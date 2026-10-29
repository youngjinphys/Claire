import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendSample, appendGap, normalizeSnapshot, normalizeEvents, normalizeSecurity, trendSummary,
  MAX_SAMPLES,
} from '../public/dashboard-model.mjs';

const stamp = time => new Date(time).toISOString();
function measured(time, extras = {}) {
  return {
    ok: true,
    data: {
      schema: 'claire.local-pc.v1', scope: 'local-machine', checkedAt: stamp(time),
      metrics: {
        cpu: { status: 'ok', unit: '%', source: 'os.cpus', value: 25, measuredAt: stamp(time - 100), measuredFrom: stamp(time - 500), windowMs: 400 },
        memory: { status: 'ok', unit: '%', source: 'os.totalmem/os.freemem', value: 50, measuredAt: stamp(time - 100), usedGiB: 4, totalGiB: 8 },
        disk: { status: 'ok', unit: 'GiB', source: 'fs.statfs', value: 42, measuredAt: stamp(time - 100), scope: 'project-filesystem' },
        ...extras,
      },
    },
  };
}
test('stale sensor value never enters a trend even when the envelope timestamp is fresh', () => {
  const now = Date.now();
  const original = measured(now);
  const stale = normalizeSnapshot(measured(now + 5000, {
    cpu: { ...original.data.metrics.cpu, value: 99, measuredAt: stamp(now - 60000) },
  }));
  assert.equal(stale.status, 'ok');
  assert.equal(stale.metrics.cpu.status, 'unavailable');
  assert.equal(stale.metrics.cpu.reason, 'MEASUREMENT_TIME_INVALID');
  const first = appendSample([], normalizeSnapshot(original), now);
  const next = appendSample(first, stale, now + 5000);
  assert.equal(next.at(-1).cpu, null);
  assert.equal(trendSummary(next), null);
});
test('errors split trend segments and cannot silently reconnect periods', () => {
  const t = Date.now() - 30000;
  const make = (ts, value) => normalizeSnapshot(measured(ts, {
    cpu: { status: 'ok', unit: '%', source: 'os.cpus', value, measuredAt: stamp(ts - 100), measuredFrom: stamp(ts - 500), windowMs: 400 },
  }));
  let h = [];
  h = appendSample(h, make(t, 10), t);
  h = appendSample(h, make(t + 5000, 15), t + 5000);
  assert.equal(trendSummary(h).cpuDelta, 5);
  h = appendGap(h, t + 10000);
  assert.equal(trendSummary(h), null);
  h = appendSample(h, make(t + 15000, 80), t + 15000);
  assert.equal(trendSummary(h), null);
  h = appendSample(h, make(t + 20000, 85), t + 20000);
  assert.equal(trendSummary(h).cpuDelta, 5);
  assert.equal(trendSummary(h).from, t + 15000);
});
test('gap history cannot grow without a bound during repeated failures', () => {
  const now = Date.now();
  let h = [];
  for (let i = 0; i < 1000; i++) h = appendGap(h, now + i * 100);
  assert.ok(h.length <= MAX_SAMPLES);
});
test('unavailable readings must not contain numeric sample claims or untrusted timestamps', () => {
  const t = Date.now();
  const wrong = normalizeSnapshot(measured(t, {
    cpu: { status: 'unavailable', value: 100, unit: '%', source: 'os.cpus', measuredAt: stamp(t), reason: 'CPU_READ_FAILED' },
  }));
  assert.equal(wrong.metrics.cpu.status, 'unavailable');
  assert.equal(wrong.metrics.cpu.reason, 'MEASUREMENT_CONTRACT_INVALID');
  const invalidScope = normalizeSnapshot(measured(t, {
    disk: { status: 'ok', value: 10, unit: 'GiB', source: 'fs.statfs', measuredAt: stamp(t), scope: 'another-volume' },
  }));
  assert.equal(invalidScope.metrics.disk.reason, 'DISK_SCOPE_UNVERIFIED');
});
test('security results fail closed when the mode is disconnected despite an ok flag', () => {
  const checkedAt = stamp(Date.now());
  const data = { user: { id: 'user' }, device: { id: 'pc', status: 'compliant' }, session: { id: 'session' } };
  assert.equal(normalizeSecurity({ ok: true, data, meta: { mode: 'disconnected', checkedAt } }).status, 'unavailable');
  assert.equal(normalizeSecurity({ ok: true, data, meta: { mode: 'connected', checkedAt } }).value, 'compliant');
  assert.equal(normalizeSecurity({ ok: true, data: { device: { status: 'compliant' } }, meta: { mode: 'connected', checkedAt } }).status, 'unavailable');
});
test('malformed, duplicate and coverage-mismatched event lists fail closed', () => {
  const checkedAt = stamp(Date.now()), at = stamp(Date.now() - 10000);
  const item = { id: 'e1', kind: 'xdr', at, summary: 'server data', appId: null };
  const source = { ok: true, data: [item], meta: { mode: 'connected', checkedAt } };
  assert.equal(normalizeEvents(source).status, 'ok');
  assert.equal(normalizeEvents({ ...source, data: [item, item] }).status, 'unavailable');
  assert.equal(normalizeEvents({ ...source, meta: { mode: 'disconnected', checkedAt } }).status, 'unavailable');
  const coverage = { schema: 'alekov.sdp.coverage.v1', kind: 'events', scope: 'own-recorded-events', limit: 40,
    total: 3, returned: 1, truncated: true, observedAtMs: Date.parse(checkedAt) - 1000 };
  assert.equal(normalizeEvents({ ...source, coverage }).truncated, true);
  assert.equal(normalizeEvents({ ...source, coverage: { ...coverage, returned: 2 } }).status, 'unavailable');
  assert.equal(normalizeEvents({ ...source, coverage: { ...coverage, observedAtMs: Date.parse(checkedAt) - 100000 } }).status, 'unavailable');
});

test('a long no-data interval must not be interpreted as a continuous trend', () => {
  const t = Date.now() - 40000;
  const f = ts => normalizeSnapshot(measured(ts));
  let history = appendSample([], f(t), t);
  history = appendSample(history, f(t + 22000), t + 22000);
  assert.equal(trendSummary(history), null);
});
