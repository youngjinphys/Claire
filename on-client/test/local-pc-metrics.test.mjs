import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateCpuUsage, createLocalPcSampler } from '../src/local-pc-metrics.mjs';

const cpu = (busy, idle) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];

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
