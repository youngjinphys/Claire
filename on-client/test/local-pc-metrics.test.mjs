import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateCpuUsage, createLocalPcSampler } from '../src/local-pc-metrics.mjs';

const cpu = (busy, idle) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];

test('sensor deadlines reject synchronous late results before timer callbacks run', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const block = () => { elapsed += 45; };
  let reads = 0, stamp = 1000;
  const sampler = createLocalPcSampler({
    cpus:() => { if (++reads === 2) block(); return cpu(reads * 30, reads * 70); },
    statfsRead:() => { block(); return {bsize:4096n,bavail:262144n}; },
    wait:async () => { stamp += 400; }, monotonic:() => stamp, clock:() => new Date(stamp),
    sensorTimeoutMs:25,
  });
  const { metrics } = await sampler.sample();
  assert.equal(metrics.cpu.reason, 'CPU_READ_TIMEOUT');
  assert.equal(metrics.disk.reason, 'DISK_READ_TIMEOUT');
  assert.equal(metrics.memory.status, 'ok');
});

test('CPU usage uses two OS tick snapshots, not an invented percentage', () => {
  assert.equal(calculateCpuUsage(cpu(100, 100), cpu(130, 170)), 30);
  assert.equal(calculateCpuUsage(cpu(100, 100), cpu(99, 200)), null);
  assert.equal(calculateCpuUsage(cpu(100, 100), cpu(100, 100)), null);
  assert.equal(calculateCpuUsage([], []), null);
});
test('user-accessible CPU, memory, disk show units, sources and timestamps', async () => {
  let calls = 0;
  let current = 1000;
  const sampler = createLocalPcSampler({
    cpus: () => (++calls === 1 ? cpu(100, 100) : cpu(130, 170)),
    totalmem: () => 8 * 1024 ** 3,
    freemem: () => 2 * 1024 ** 3,
    statfsRead: async () => ({ bsize: 4096n, bavail: 262144n }),
    wait: async () => { current += 400; },
    clock: () => new Date(current),
    monotonic: () => current,
  });
  const result = await sampler.sample();
  assert.equal(result.schema, 'claire.local-pc.v1');
  assert.equal(result.metrics.cpu.value, 30);
  assert.equal(result.metrics.cpu.windowMs, 400);
  assert.equal(result.metrics.memory.value, 75);
  assert.equal(result.metrics.memory.usedGiB, 6);
  assert.equal(result.metrics.disk.value, 1);
  assert.equal(result.metrics.disk.scope, 'project-filesystem');
  for (const metric of Object.values(result.metrics)) {
    assert.equal(metric.status, 'ok');
    assert.match(metric.measuredAt, /^\d{4}-/);
    assert.equal(typeof metric.source, 'string');
    assert.equal(typeof metric.unit, 'string');
  }
  assert.equal(JSON.stringify(result).includes('projectPath'), false);
});
test('per-sensor failures never become fake healthy metrics', async () => {
  const sampler = createLocalPcSampler({
    cpus: () => { throw Error('private machine details'); },
    totalmem: () => 8,
    freemem: () => 10,
    statfsRead: async () => { throw Error('/confidential/private/path'); },
    wait: async () => {},
  });
  const result = await sampler.sample();
  assert.deepEqual([result.metrics.cpu.status, result.metrics.memory.status, result.metrics.disk.status], ['unavailable', 'unavailable', 'unavailable']);
  for (const metric of Object.values(result.metrics)) assert.equal(metric.value, null);
  assert.doesNotMatch(JSON.stringify(result), /confidential|private machine/);
});

test('monotonic clock detects invalid CPU sampling intervals and rejects wall clock reversal', async () => {
  const noElapsed = createLocalPcSampler({
    cpus: () => cpu(30, 70),
    statfsRead: async () => ({ bsize: 4096n, bavail: 262144n }),
    wait: async () => {},
    monotonic: () => 10,
  });
  assert.equal((await noElapsed.sample()).metrics.cpu.status, 'unavailable');
  assert.equal((await noElapsed.sample()).metrics.cpu.reason, 'CPU_INTERVAL_INVALID');
  let tick = 0;
  const sampler = createLocalPcSampler({
    cpus: () => cpu(30, 70),
    statfsRead: async () => ({ bsize: 4096n, bavail: 262144n }),
    wait: async () => {},
    monotonic: () => tick++ * 400,
    clock: () => new Date(1000 - tick * 100),
  });
  const row = (await sampler.sample()).metrics.cpu;
  assert.equal(row.status, 'unavailable');
  assert.equal(row.reason, 'CPU_INTERVAL_INVALID');
});
test('disk space rejects impossible huge capacity without losing integer precision', async () => {
  const sampler = createLocalPcSampler({
    cpus: () => [],
    statfsRead: async () => ({ bsize: 4096n, bavail: 2n ** 100n }),
    wait: async () => {},
  });
  const row = (await sampler.sample()).metrics.disk;
  assert.equal(row.status, 'unavailable');
  assert.equal(row.reason, 'DISK_INVALID');
  assert.equal(row.value, null);
});

test('Windows IRQ is included in kernel time; Unix IRQ remains a separate counter', () => {
  const before = [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
  const after = [{ times: { user: 20, nice: 0, sys: 30, idle: 50, irq: 10 } }];
  assert.equal(calculateCpuUsage(before, after, 'win32'), 50);
  assert.equal(calculateCpuUsage(before, after, 'linux'), 54.55);
  assert.equal(calculateCpuUsage(before, after, 'darwin'), 54.55);
});
test('a wall-clock jump and fractional memory byte counts cannot become valid measurements', async () => {
  let tick = 0, wall = 10000, calls = 0;
  const sampler = createLocalPcSampler({
    cpus: () => (++calls === 1 ? cpu(100,100) : cpu(130,170)),
    totalmem: () => 8 * 1024 ** 3 + 0.5,
    freemem: () => 1024 ** 3,
    statfsRead: async () => ({ bsize: 4096n, bavail: 1n }),
    monotonic: () => tick, clock: () => new Date(wall),
    wait: async () => { tick += 400; wall += 3000; },
  });
  const {metrics} = await sampler.sample();
  assert.equal(metrics.cpu.reason, 'CPU_INTERVAL_INVALID');
  assert.equal(metrics.memory.reason, 'MEMORY_INVALID');
  assert.equal(metrics.disk.status, 'ok');
});

for (const cancelAtEnvelope of [false, true]) test('final envelope clock ' + (cancelAtEnvelope ? 'cancellation rejects the sample' : 'preserves a valid sample'), async () => {
  const caller = new AbortController();
  let at = 1000, clockReads = 0, cpuReads = 0, diskReads = 0;
  const sampler = createLocalPcSampler({
    platform: 'linux',
    cpus: () => (++cpuReads === 1 ? cpu(100, 100) : cpu(130, 170)),
    totalmem: () => 8 * 1024 ** 3,
    freemem: () => 2 * 1024 ** 3,
    statfsRead: async () => { diskReads++; return { bsize: 4096n, bavail: 262144n }; },
    wait: async () => { at += 400; },
    monotonic: () => at,
    clock: () => {
      // Memory, CPU start/end and disk stamps precede the envelope stamp.
      if (++clockReads === 5 && cancelAtEnvelope) caller.abort();
      return new Date(at);
    },
  });
  const pending = sampler.sample({ signal: caller.signal });
  if (cancelAtEnvelope) await assert.rejects(pending, { code: 'MEASUREMENT_CANCELLED' });
  else {
    const result = await pending;
    assert.equal(result.checkedAt, new Date(1400).toISOString());
    assert.deepEqual(Object.values(result.metrics).map(metric => metric.status), ['ok', 'ok', 'ok']);
    assert.deepEqual([result.metrics.cpu.value, result.metrics.memory.value, result.metrics.disk.value], [30, 75, 1]);
  }
  assert.equal(caller.signal.aborted, cancelAtEnvelope);
  assert.equal(clockReads, 5);
  assert.deepEqual([cpuReads, diskReads], [2, 1]);
});
