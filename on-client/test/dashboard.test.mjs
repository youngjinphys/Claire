import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOnServer } from '../src/server.mjs';
import {
  appendSample, normalizeSnapshot, normalizeSecurity, normalizeEvents,
  trendSummary, HISTORY_WINDOW_MS, MAX_SAMPLES,
} from '../public/dashboard-model.mjs';

const at = ms => new Date(ms).toISOString();
const metric = (value, unit, source, time, extra = {}) => ({ status: 'ok', value, unit, source, measuredAt: at(time), ...extra });
function sample(time = 1000000, cpu = 20, memory = 40) {
  return normalizeSnapshot({ ok: true, data: {
    schema: 'claire.local-pc.v1', scope: 'local-machine', checkedAt: at(time),
    metrics: {
      cpu: metric(cpu, '%', 'os.cpus', time, { measuredFrom: at(time - 400), windowMs: 400 }),
      memory: metric(memory, '%', 'os.totalmem/os.freemem', time, { usedGiB: memory / 10, totalGiB: 10 }),
      disk: metric(90, 'GiB', 'fs.statfs', time, { scope: 'project-filesystem' }),
    },
  } });
}
test('snapshot rejects invented values, invalid units and unverifiable origin', () => {
  assert.equal(normalizeSnapshot({ ok: true, data: { schema: 'unknown' } }).status, 'error');
  const value = sample();
  assert.equal(value.metrics.cpu.value, 20);
  assert.equal(value.metrics.memory.usedGiB, 4);
  assert.equal(value.metrics.disk.unit, 'GiB');
  assert.equal(normalizeSnapshot({ ok: true, data: {
    schema: 'claire.local-pc.v1', scope: 'local-machine', checkedAt: at(1000000),
    metrics: { cpu: { status: 'ok', value: 25, unit: 'GiB', source: 'os.cpus', measuredAt: at(1000000) } },
  } }).metrics.cpu.status, 'unavailable');
});
test('time history requires actual samples, preserves absent values and stays bounded', () => {
  const t = 1000000;
  let data = appendSample([], sample(t), t);
  data = appendSample(data, sample(t + 5000, 30, 44), t + 5000);
  assert.equal(data.length, 2);
  assert.deepEqual(trendSummary(data), { cpuDelta: 10, memoryDelta: 4, cpuSamples: 2, memorySamples: 2, from: t, to: t + 5000 });
  const broken = { ...sample(t + 10000), metrics: { ...sample(t + 10000).metrics, cpu: { status: 'unavailable', value: null } } };
  data = appendSample(data, broken, t + 10000);
  assert.equal(data.at(-1).cpu, null);
  assert.equal(data.at(-1).memory, 40);
  assert.equal(appendSample(data, sample(t), t + 10000).length, data.length);
  let long = [];
  for (let i = 0; i < 180; i++) long = appendSample(long, sample(t + i * 5000), t + i * 5000);
  assert.ok(long.length <= MAX_SAMPLES);
  assert.ok(long.at(-1).time - long[0].time <= HISTORY_WINDOW_MS);
});
test('security and events distinguish SDP verified, DEMO and not-connected', () => {
  const checkedAt = at(1000000);
  const demo = normalizeSecurity({ ok: true, data: { user: { id: 'practice-user', label: '연습 사용자' }, session: { id: 'practice-session', status: 'active' }, device: { id: 'practice-device', label: '연습 기기', status: 'unknown' } }, meta: { mode: 'demo', checkedAt } });
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.value, 'unknown');
  const missing = normalizeSecurity({ ok: false, error: { code: 'ENGINE_NOT_CONNECTED' }, meta: { mode: 'disconnected', checkedAt } });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'ENGINE_NOT_CONNECTED');
  const events = normalizeEvents({ ok: true, data: [{ id: 'e1', kind: 'xdr', at: checkedAt, summary: 'demo', appId: null, evidence: [], rules: [], state: { access: 'unknown', session: 'unknown', device: 'unknown' }, supportedActions: [] }], meta: { mode: 'demo', checkedAt } });
  assert.equal(events.mode, 'demo');
  assert.equal(events.events.length, 1);
  assert.equal(normalizeEvents({ ok: false, error: { code: 'ENGINE_NOT_CONNECTED' }, meta: { mode: 'disconnected', checkedAt } }).events.length, 0);
});
test('dashboard assets parse and HTML has exactly four metric cards and source labels', () => {
  const base = new URL('../public/', import.meta.url);
  for (const file of ['dashboard.mjs', 'dashboard-model.mjs']) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, base))], { stdio: 'pipe' });
  const html = readFileSync(new URL('dashboard.html', base), 'utf8');
  assert.equal((html.match(/class="metric-card(?: security)?"/g) || []).length, 4);
  for (const id of ['cpu-card', 'memory-card', 'disk-card', 'security-card', 'resource-chart', 'events-body', 'start', 'stop']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /PC 실측/u);
  assert.match(html, /예제 DEMO/u);
  assert.doesNotMatch(html, /onclick\s*=/iu);
});
test('new local dashboard and metrics route use the existing same-origin loopback server', { timeout: 15000 }, async () => {
  const server = createOnServer({});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const file of ['/dashboard.html', '/dashboard.css', '/dashboard.mjs', '/dashboard-model.mjs']) {
      const response = await fetch(base + file);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      await response.text();
    }
    // Simultaneous local requests must share one bounded measurement, not fan out to the OS.
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(base + '/api/local-pc')));
    const response = responses[0];
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    for (const extra of responses.slice(1)) {
      assert.equal(extra.status, 200);
      const repeated = await extra.json();
      assert.equal(repeated.data.checkedAt, body.data.checkedAt);
    }
    assert.equal(body.ok, true);
    const parsed = normalizeSnapshot(body);
    assert.equal(parsed.status, 'ok');
    for (const name of ['cpu', 'memory', 'disk']) {
      assert.ok(['ok', 'unavailable'].includes(parsed.metrics[name].status));
      assert.ok(parsed.metrics[name].measuredAt);
    }
    const original = await fetch(base + '/');
    assert.equal(original.status, 200);
    assert.match(await original.text(), /id="tab-protection"/);
    const disconnected = await fetch(base + '/api/me');
    assert.equal(disconnected.status, 503);
    assert.equal((await disconnected.json()).error.code, 'ENGINE_NOT_CONNECTED');
  } finally {
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); });
  }
});
