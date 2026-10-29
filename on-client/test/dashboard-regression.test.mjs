import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendSample, appendGap, normalizeSnapshot, normalizeEvents, normalizeSecurity, trendSummary,
  MAX_SAMPLES, seriesSegments, securityCardState, pairedSamples,
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
  const data = { user: { id: 'user', label: 'User' }, device: { id: 'pc', label: 'PC', status: 'compliant' }, session: { id: 'session', status: 'active' } };
  assert.equal(normalizeSecurity({ ok: true, data, meta: { mode: 'disconnected', checkedAt } }).status, 'unavailable');
  assert.equal(normalizeSecurity({ ok: true, data, meta: { mode: 'connected', checkedAt } }).value, 'compliant');
  assert.equal(normalizeSecurity({ ok: true, data: { device: { status: 'compliant' } }, meta: { mode: 'connected', checkedAt } }).status, 'unavailable');
});
test('malformed, duplicate and coverage-mismatched event lists fail closed', () => {
  const checkedAt = stamp(Date.now()), at = stamp(Date.now() - 10000);
  const item = { id: 'e1', kind: 'xdr', at, summary: 'server data', appId: null, evidence: [], rules: [], state: { access: 'unknown', session: 'unknown', device: 'unknown' }, supportedActions: [] };
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

test('security and event projections require the entire original contract', () => {
  const checkedAt = stamp(Date.now());
  const identity = { user: { id:'user', label:'User' }, device: { id:'pc', label:'PC', status:'compliant' }, session: { id:'session', status:'active' } };
  const reply = { ok:true, data:identity, meta:{ mode:'connected', checkedAt } };
  assert.equal(normalizeSecurity(reply).status,'ok');
  assert.equal(normalizeSecurity({ ...reply, data:{ ...identity, session:{ id:'session', status:'invalid' } } }).status,'unavailable');
  assert.equal(normalizeSecurity({ ...reply, data:{ ...identity, user:{ id:'user' } } }).status,'unavailable');
  const item = { id:'e1', kind:'access', at:checkedAt, summary:'access', appId:'repo', evidence:[], rules:[], state:{ access:'allowed', session:'active', device:'compliant' }, supportedActions:[] };
  const events = { ok:true, data:[item], meta:{ mode:'connected', checkedAt } };
  assert.equal(normalizeEvents(events).status,'ok');
  for (const altered of [
    { ...item, evidence:undefined },
    { ...item, rules:[{ id:'bad', text:123 }] },
    { ...item, supportedActions:'device:revoke' },
    { ...item, state:{ ...item.state, access:'granted' } },
    { ...item, appId:'not a safe ID' },
  ]) assert.equal(normalizeEvents({ ...events, data:[altered] }).status,'unavailable');
});
test('record coverage is bound to actual request window, not forged response time', () => {
  const now = Date.now(), checkedAt = stamp(now);
  const item = { id:'e1', kind:'xdr', at:checkedAt, appId:null, summary:'event', evidence:[], rules:[], state:{access:'unknown',session:'unknown',device:'unknown'},supportedActions:[] };
  const coverage = { schema:'alekov.sdp.coverage.v1',kind:'events',scope:'own-recorded-events',limit:40,total:1,returned:1,truncated:false,observedAtMs:now-15000 };
  const response = { ok:true, data:[item], meta:{mode:'connected',checkedAt},coverage };
  assert.equal(normalizeEvents(response).status,'ok'); // legacy client without request timing
  assert.equal(normalizeEvents(response,{requestedAt:now,receivedAt:now+200}).status,'unavailable');
  assert.equal(normalizeEvents({...response,coverage:{...coverage,observedAtMs:now-1000}},{requestedAt:now,receivedAt:now+200}).status,'ok');
});
test('graph splits long idle gaps even when both endpoints contain valid numbers', () => {
  const t = Date.now() - 45000;
  const rows = [{ time:t,cpu:10,memory:30 },{ time:t+5000,cpu:14,memory:40 },{ time:t+30000,cpu:90,memory:96 },{time:t+35000,cpu:92,memory:98}];
  const segments = seriesSegments(rows,'cpu');
  assert.deepEqual(segments.map(s=>s.length),[2,2]);
  assert.deepEqual(segments.map(s=>s[0].value),[10,90]);
  assert.equal(trendSummary(rows).cpuDelta,2);
  const missing = seriesSegments([{time:t,cpu:10},{time:t+5000,cpu:null},{time:t+10000,cpu:90}],'cpu');
  assert.deepEqual(missing.map(s=>s.length),[1,1]);
});

test('security compliance colors distinguish unhealthy and inactive sessions from verified safe', () => {
  const now = Date.now();
  const base = { status:'ok', mode:'connected', checkedAt:new Date(now).toISOString(), value:'compliant', sessionStatus:'active' };
  assert.equal(securityCardState(base,now),'ok');
  assert.equal(securityCardState({ ...base,value:'noncompliant' },now),'risk');
  assert.equal(securityCardState({ ...base,sessionStatus:'revoked' },now),'warning');
  assert.equal(securityCardState({ ...base,sessionStatus:'expired' },now),'warning');
  assert.equal(securityCardState({ ...base,sessionStatus:'unknown' },now),'warning');
  assert.equal(securityCardState({ ...base,value:'unknown' },now),'unavailable');
  assert.equal(securityCardState({ ...base,mode:'demo' },now),'demo');
  assert.equal(securityCardState(base,now+31000),'unavailable');
});

test('a failed read is a gap, not a counted valid sample or a fictitious measurement time', () => {
  const t = Date.now() - 10000;
  const history = [
    { time:t, cpu:40, memory:50 },
    { time:t+5000, cpu:null, memory:null },
    { time:t+8000, cpu:42, memory:null },
  ];
  assert.equal(pairedSamples(history).length, 1);
  assert.equal(pairedSamples(history).at(-1).time,t);
  assert.equal(pairedSamples([{time:t,cpu:null,memory:null}]).length,0);
});
