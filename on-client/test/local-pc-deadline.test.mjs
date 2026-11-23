import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {test} from 'node:test';
import {createLocalPcSampler} from '../src/local-pc-metrics.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function fixture(t, sensor) {
  let mono = 0, clockReads = 0, cpuReads = 0, diskReads = 0;
  const base = Date.UTC(2026, 10, 23), active = new Set(), records = new Map();
  const gate = deferred(), entered = deferred(), caller = new AbortController();
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const token = {};
    records.set(token, {callback, delay, clears: 0}); active.add(token); return token;
  });
  t.mock.method(globalThis, 'clearTimeout', token => {
    assert.ok(records.has(token)); records.get(token).clears++; active.delete(token);
  });
  const sampler = createLocalPcSampler({
    platform: 'linux', sensorTimeoutMs: 500, intervalMs: 400,
    totalmem: () => 8 * 1024 ** 3, freemem: () => 2 * 1024 ** 3,
    cpus: () => [{times: ++cpuReads % 2 === 1
      ? {user: 0, nice: 0, sys: 0, idle: 0, irq: 0}
      : {user: 30, nice: 0, sys: 0, idle: 70, irq: 0}}],
    statfsRead: async () => {
      diskReads++;
      if (sensor === 'disk' && diskReads === 1) { entered.resolve(); await gate.promise; }
      return {bsize: 4096n, bavail: 262144n};
    },
    monotonic: () => mono,
    clock: () => {
      if (++clockReads === 2 && sensor === 'cpu') mono = 0.25;
      return new Date(base + Math.floor(mono));
    },
    wait: async () => {
      if (sensor === 'cpu') { entered.resolve(); await gate.promise; }
      else mono += 400;
    },
  });
  t.after(() => { gate.resolve(); caller.abort(); });
  return {
    sampler, caller, gate, entered, active, records,
    setMono(value) { mono = value; },
    get cpuReads() { return cpuReads; }, get diskReads() { return diskReads; },
    only() { assert.equal(active.size, 1); return [...active][0]; },
    fire(token, at) { assert.ok(active.delete(token)); mono = at; records.get(token).callback(); },
    stale(token) { records.get(token).callback(); },
    released() {
      assert.equal(active.size, 0);
      for (const row of records.values()) assert.equal(row.clears, 1);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    },
  };
}

for (const sensor of ['cpu', 'disk']) for (const mode of ['timely', 'early', 'equality', 'cancel']) {
  test(`${sensor} deadline ${mode} keeps the original budget and owned resources`, async t => {
    const f = fixture(t, sensor);
    let outcome;
    const pending = f.sampler.sample({signal: f.caller.signal}).then(
      value => { outcome = {value}; }, error => { outcome = {error}; });
    await f.entered.promise; await turn();
    const first = f.only();
    if (mode === 'early' || mode === 'cancel') {
      f.fire(first, 499.25); await turn();
      assert.equal(outcome, undefined);
      assert.equal(f.records.get(first).clears, 1);
      const second = f.only(), acquired = f.records.size;
      assert.notEqual(second, first); assert.equal(f.records.get(second).delay, 1);
      f.stale(first); assert.equal(f.records.size, acquired); assert.equal(f.only(), second);
      if (mode === 'early') {
        f.fire(second, 499.75); await turn();
        assert.equal(outcome, undefined); assert.equal(f.records.get(second).clears, 1);
        assert.equal(f.records.get(f.only()).delay, 1);
      }
    }
    if (mode === 'cancel') f.caller.abort();
    else if (mode === 'equality') f.fire(first, 500);
    else { f.setMono(mode === 'early' ? 499.875 : 499.5); f.gate.resolve(); }
    await pending;
    if (mode === 'cancel') assert.equal(outcome.error?.code, 'MEASUREMENT_CANCELLED');
    else {
      const metrics = outcome.value.metrics;
      if (mode === 'equality') {
        assert.equal(metrics[sensor].status, 'unavailable');
        assert.equal(metrics[sensor].reason, sensor.toUpperCase() + '_READ_TIMEOUT');
      } else {
        assert.equal(metrics[sensor].status, 'ok');
        assert.equal(metrics[sensor].value, sensor === 'cpu' ? 30 : 1);
      }
      assert.equal(metrics.memory.value, 75);
      assert.equal(metrics[sensor === 'cpu' ? 'disk' : 'cpu'].status, 'ok');
    }
    f.released();
    const acquired = f.records.size;
    for (const token of f.records.keys()) f.stale(token);
    assert.equal(f.records.size, acquired); f.released();
    const cpuReads = f.cpuReads; f.gate.resolve(); await turn();
    assert.equal(f.cpuReads, cpuReads, 'late interval completion cannot resume a retired sample');
  });
}

for (const end of ['timeout', 'cancel']) test(`disk ${end} retains its actual single-flight slot until the read settles`, async t => {
  const f = fixture(t, 'disk');
  const first = f.sampler.sample({signal: f.caller.signal});
  const observed = first.then(value => ({value}), error => ({error}));
  await f.entered.promise; await turn();
  if (end === 'timeout') f.fire(f.only(), 500); else f.caller.abort();
  const result = await observed;
  if (end === 'timeout') assert.equal(result.value.metrics.disk.reason, 'DISK_READ_TIMEOUT');
  else assert.equal(result.error.code, 'MEASUREMENT_CANCELLED');
  f.released();
  const during = await f.sampler.sample();
  assert.equal(during.metrics.disk.reason, 'DISK_READ_IN_PROGRESS');
  assert.equal(f.diskReads, 1); f.released();
  f.gate.resolve(); await turn();
  const after = await f.sampler.sample();
  assert.equal(after.metrics.disk.status, 'ok'); assert.equal(after.metrics.disk.value, 1);
  assert.equal(f.diskReads, 2); f.released();
});

function diskFinalizationFixture(t, {info = {bsize: 4096n, bavail: 262144n}, cost = 0, cancelAtStamp = false} = {}) {
  const base = Date.UTC(2026, 10, 23), caller = new AbortController();
  const cpuGate = deferred(), diskGate = deferred(), cpuEntered = deferred(), diskEntered = deferred();
  const active = new Set(), records = new Map();
  let mono = 0, cpuReads = 0, diskReads = 0, waits = 0, armed = false, stampHooks = 0, readFinishedAt;
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const token = {};
    records.set(token, {callback, delay, clears: 0}); active.add(token); return token;
  });
  t.mock.method(globalThis, 'clearTimeout', token => {
    assert.ok(records.has(token)); records.get(token).clears++; active.delete(token);
  });
  const sampler = createLocalPcSampler({
    platform: 'linux', sensorTimeoutMs: 500, intervalMs: 400,
    totalmem: () => 8 * 1024 ** 3, freemem: () => 2 * 1024 ** 3,
    cpus: () => [{times: ++cpuReads % 2 === 1
      ? {user: 0, nice: 0, sys: 0, idle: 0, irq: 0}
      : {user: 30, nice: 0, sys: 0, idle: 70, irq: 0}}],
    statfsRead: async () => {
      if (++diskReads === 1) {
        diskEntered.resolve(); await diskGate.promise; readFinishedAt = mono; return info;
      }
      return {bsize: 4096n, bavail: 262144n};
    },
    wait: async () => {
      if (++waits === 1) { cpuEntered.resolve(); await cpuGate.promise; }
      else mono += 400;
    },
    monotonic: () => mono,
    clock: () => {
      if (armed) {
        armed = false; stampHooks++; mono += cost;
        if (cancelAtStamp) caller.abort();
      }
      return new Date(base + mono);
    },
  });
  t.after(() => { armed = false; caller.abort(); cpuGate.resolve(); diskGate.resolve(); });
  return {
    sampler,
    get diskReads() { return diskReads; },
    async first() {
      const pending = sampler.sample({signal: caller.signal}).then(value => ({value}), error => ({error}));
      await Promise.all([cpuEntered.promise, diskEntered.promise]);
      mono = 400; cpuGate.resolve(); await turn();
      assert.equal(cpuReads, 2); assert.equal(active.size, 1, 'only the unfinished disk read owns a deadline');
      mono = 499; armed = true; diskGate.resolve();
      const outcome = await pending;
      assert.equal(readFinishedAt, 499); assert.equal(mono, 499 + cost);
      assert.equal(stampHooks, 1, 'only the post-read disk timestamp consumes the controlled budget');
      return outcome;
    },
    released() {
      assert.equal(active.size, 0);
      for (const record of records.values()) assert.equal(record.clears, 1);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    },
  };
}

const finalizationCases = [
  {label: 'valid timely', cost: 0, reason: null},
  {label: 'valid equality', cost: 1, reason: 'DISK_READ_TIMEOUT'},
  {label: 'valid late', cost: 2, reason: 'DISK_READ_TIMEOUT'},
  {label: 'wrong type timely', info: {bsize: 4096, bavail: 262144n}, cost: 0, reason: 'DISK_INVALID'},
  {label: 'wrong type equality', info: {bsize: 4096, bavail: 262144n}, cost: 1, reason: 'DISK_READ_TIMEOUT'},
  {label: 'invalid size timely', info: {bsize: 0n, bavail: 262144n}, cost: 0, reason: 'DISK_INVALID'},
  {label: 'invalid size equality', info: {bsize: 0n, bavail: 262144n}, cost: 1, reason: 'DISK_READ_TIMEOUT'},
  {label: 'unsafe capacity timely', info: {bsize: 4096n, bavail: 2n ** 100n}, cost: 0, reason: 'DISK_INVALID'},
  {label: 'unsafe capacity equality', info: {bsize: 4096n, bavail: 2n ** 100n}, cost: 1, reason: 'DISK_READ_TIMEOUT'},
];
for (const control of finalizationCases) test(`C26 disk finalization ${control.label} uses its original deadline`, async t => {
  const f = diskFinalizationFixture(t, control), outcome = await f.first();
  assert.equal(outcome.error, undefined); f.released();
  const {cpu, memory, disk} = outcome.value.metrics;
  assert.equal(cpu.status, 'ok'); assert.equal(cpu.value, 30);
  assert.equal(memory.status, 'ok'); assert.equal(memory.value, 75);
  assert.equal(disk.status, control.reason ? 'unavailable' : 'ok');
  assert.equal(disk.reason ?? null, control.reason); assert.equal(disk.value, control.reason ? null : 1);
  assert.equal(f.diskReads, 1);
});

test('C26 disk finalization timestamp cancellation rejects the whole sample before fallback cleanup', async t => {
  const f = diskFinalizationFixture(t, {cancelAtStamp: true}), outcome = await f.first();
  assert.equal(outcome.value, undefined); assert.equal(outcome.error?.code, 'MEASUREMENT_CANCELLED');
  assert.equal(f.diskReads, 1); f.released();
});

test('C26 disk finalization timeout after actual settlement permits the next explicit read', async t => {
  const f = diskFinalizationFixture(t, {cost: 1}), first = await f.first();
  assert.equal(first.error, undefined); assert.equal(first.value.metrics.disk.reason, 'DISK_READ_TIMEOUT'); f.released();
  const next = await f.sampler.sample();
  assert.equal(f.diskReads, 2);
  assert.equal(next.metrics.disk.status, 'ok'); assert.equal(next.metrics.disk.value, 1);
  assert.equal(next.metrics.cpu.status, 'ok'); assert.equal(next.metrics.cpu.value, 30);
  assert.equal(next.metrics.memory.value, 75); f.released();
});
