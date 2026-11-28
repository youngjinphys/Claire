import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalPcSampler } from '../src/local-pc-metrics.mjs';
import {
  appendSample, appendGap, normalizeSnapshot, normalizeEvents, normalizeSecurity, trendSummary, completedTrendSummary, localTransportReason,
  MAX_SAMPLES, HISTORY_WINDOW_MS, seriesSegments, securityCardState, pairedSamples, readingFreshness, trimHistory, exportMeasurements,
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
test('memory normalization retains exact byte evidence despite small-capacity display rounding', async () => {
  const time = Date.UTC(2026, 10, 23), mib = 1024 ** 2;
  for (const [totalBytes, freeBytes] of [[128 * mib, mib], [mib, 0], [mib, mib], [312 * mib, 37 * mib], [Number.MAX_SAFE_INTEGER, 1]]) {
    const sampler = createLocalPcSampler({
      cpus: () => [], totalmem: () => totalBytes, freemem: () => freeBytes,
      statfsRead: async () => ({ bsize: 1n, bavail: 1n }),
      clock: () => new Date(time), monotonic: () => 0, wait: async () => {},
    });
    const data = await sampler.sample();
    const normalized = normalizeSnapshot({ ok: true, data });
    assert.equal(data.metrics.memory.status, 'ok');
    assert.equal(normalized.metrics.memory.status, 'ok', `${totalBytes} total / ${freeBytes} free`);
    assert.equal(normalized.metrics.memory.usedBytes, totalBytes - freeBytes);
    assert.equal(normalized.metrics.memory.totalBytes, totalBytes);
    assert.equal(normalized.metrics.memory.value, data.metrics.memory.value);
  }
});
test('legacy memory percentages must fit capacity-dependent rounding intervals', () => {
  const time = Date.UTC(2026, 10, 23), metric = measured(time).data.metrics.memory;
  for (const value of [49.91, 50, 50.09]) {
    assert.equal(normalizeSnapshot(measured(time, { memory: { ...metric, value } })).metrics.memory.status, 'ok');
  }
  for (const value of [49.9, 50.1, 52.9, 47.1]) {
    assert.equal(normalizeSnapshot(measured(time, { memory: { ...metric, value } })).metrics.memory.reason, 'MEMORY_INVALID');
  }
  assert.equal(normalizeSnapshot(measured(time, { memory: { ...metric, usedGiB: 0.12, totalGiB: 0.13, value: 99.22 } })).metrics.memory.status, 'ok');
});
test('memory raw evidence cannot be repaired by plausible rounded display fields', () => {
  const time = Date.UTC(2026, 10, 23), gib = 1024 ** 3;
  const metric = { ...measured(time).data.metrics.memory, usedBytes: 4 * gib, totalBytes: 8 * gib };
  for (const change of [{ value: 50.01 }, { usedGiB: 4.01 }, { totalGiB: 8.01 },
    { totalBytes: 0 }, { usedBytes: -1 }, { usedBytes: 9 * gib }, { totalBytes: undefined },
    { usedBytes: '4294967296' }, { usedGiB: NaN }, { totalGiB: Infinity }]) {
    assert.equal(normalizeSnapshot(measured(time, { memory: { ...metric, ...change } })).metrics.memory.reason, 'MEMORY_INVALID');
  }
  const missing = { ...metric }; delete missing.usedBytes;
  assert.equal(normalizeSnapshot(measured(time, { memory: missing })).metrics.memory.reason, 'MEMORY_INVALID');
});
test('cached duplicates coalesce while small and large clock reversals break continuity before trimming', () => {
  const t = Date.UTC(2026, 10, 23);
  const sample = time => normalizeSnapshot(measured(time));
  const first = appendSample([], sample(t), t);
  assert.deepEqual(appendSample(first, sample(t), t + 500), first);
  for (const back of [500, 60000]) {
    const original = appendSample(appendSample([], sample(t - back - 500), t - back - 500), sample(t), t);
    const reversed = appendSample(original, sample(t - back), t - back);
    assert.equal(reversed.at(-2).cpu, null, 'the acquisition reversal remains explicit');
    assert.equal(reversed.at(-1).time, t - back);
    assert.equal(trendSummary(reversed), null, 'old points do not become the new baseline');
    const next = appendSample(reversed, sample(t - back + 500), t - back + 500);
    assert.equal(trendSummary(next).from, t - back);
    assert.equal(seriesSegments(next, 'cpu').at(-1).length, 2);
  }
});
test('cached replies after stop and restart remain in their original interval without adding a new sample', () => {
  const t = Date.UTC(2026, 10, 23), sample = time => normalizeSnapshot(measured(time));
  let history = appendSample([], sample(t - 5000), t - 5000);
  history = appendSample(history, sample(t), t);
  history = appendGap(history, t + 100);
  history = appendGap(history, t + 200);
  const reused = appendSample(history, sample(t), t + 300);
  assert.deepEqual(reused, history, 'a normal cached reply must not become a new acquisition after a gap');
  assert.equal(pairedSamples(reused).length, 2);
  assert.equal(trendSummary(reused), null);
  assert.equal(completedTrendSummary(reused).to, t);
  const resumed = appendSample(reused, sample(t + 5000), t + 5000);
  assert.equal(trendSummary(resumed), null, 'the new interval needs two newly acquired samples');
  const continued = appendSample(resumed, sample(t + 10000), t + 10000);
  assert.equal(trendSummary(continued).from, t + 5000);
  assert.equal(trendSummary(continued).cpuSamples, 2);
  assert.equal(exportMeasurements(continued, stamp(t + 10000)).records.filter(row => row.type === 'sample').length, 4);
});
test('a clock rollback may acquire different sensor evidence at an earlier retained timestamp', () => {
  const t = Date.UTC(2026, 10, 23), earlier = t - 60000;
  let history = appendSample([], normalizeSnapshot(measured(earlier)), earlier);
  history = appendSample(history, normalizeSnapshot(measured(t)), t);
  history = appendGap(history, earlier);
  const reply = measured(earlier);
  reply.data.metrics.cpu.value = 55;
  history = appendSample(history, normalizeSnapshot(reply), earlier);
  assert.equal(history.at(-1).cpu, 55, 'matching wall-clock time alone does not prove cached acquisition after a rollback');
  assert.equal(trendSummary(history), null, 'the new evidence still starts an independent interval');
  const next = measured(earlier + 5000);
  next.data.metrics.cpu.value = 65;
  history = appendSample(history, normalizeSnapshot(next), earlier + 5000);
  assert.equal(trendSummary(history).cpuDelta, 10);
  assert.equal(trendSummary(history).from, earlier);
});
test('a cached reply after clock rollback preserves a stop boundary removed by retention', () => {
  const t = Date.UTC(2026, 10, 23), sample = time => normalizeSnapshot(measured(time));
  let history = appendSample([], sample(t - 5000), t - 5000);
  history = appendSample(history, sample(t), t);
  history = appendGap(history, t + 5000);
  const reused = appendSample(history, sample(t), t + 300);
  assert.equal(pairedSamples(reused).length, 2, 'reuse does not add an acquisition');
  assert.equal(reused.at(-1).cpu, null, 'retaining past samples must not remove their closing gap');
  assert.equal(reused.at(-1).time, t + 300);
  assert.equal(trendSummary(reused), null);
  assert.equal(completedTrendSummary(reused).to, t);
  const resumed = appendSample(reused, sample(t + 5000), t + 5000);
  assert.equal(trendSummary(resumed), null);
  const continued = appendSample(resumed, sample(t + 10000), t + 10000);
  assert.equal(trendSummary(continued).from, t + 5000);
});
test('history display and export share the exact retention boundary and sample cap', () => {
  const now = Date.UTC(2026, 10, 23), history = [
    { time: now - HISTORY_WINDOW_MS, cpu: null, memory: null },
    { time: now - HISTORY_WINDOW_MS + 1, cpu: null, memory: null },
  ];
  const visible = trimHistory(history, now);
  const exported = exportMeasurements(history, stamp(now)).records;
  assert.equal(visible.length, 1);
  assert.deepEqual(exported.map(x => Date.parse(x.checkedAt)), visible.map(x => x.time));
});
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

test('live PC replies bind both envelope and individual sensor times to the active request', () => {
  const t = Date.now(), timing = { requestedAt: t, receivedAt: t + 1000 };
  assert.equal(normalizeSnapshot(measured(t - 6000), timing).status, 'error');
  assert.equal(normalizeSnapshot(measured(t - 5000), timing).status, 'ok', 'five-second clock tolerance');
  const valid = measured(t + 500);
  assert.equal(normalizeSnapshot(valid, timing).metrics.cpu.status, 'ok');
  const partial = normalizeSnapshot(measured(t + 500, {
    memory: { ...valid.data.metrics.memory, measuredAt: stamp(t - 6000) },
    cpu: { ...valid.data.metrics.cpu, measuredAt: stamp(t - 4800), measuredFrom: stamp(t - 5200) },
  }), timing);
  assert.equal(partial.status, 'ok');
  assert.equal(partial.metrics.memory.reason, 'MEASUREMENT_TIME_INVALID');
  assert.equal(partial.metrics.cpu.reason, 'MEASUREMENT_TIME_INVALID');
  assert.equal(partial.metrics.disk.status, 'ok');
  assert.equal(partial.metrics.cpu.measuredAt, null);
  assert.equal(normalizeSnapshot(measured(t - 6000)).status, 'ok', 'historical validation does not invent an HTTP window');
});

test('live freshness boundaries distinguish future clock errors from historical readings', () => {
  const t = Date.now();
  assert.equal(readingFreshness(stamp(t - 30000), t), 'recent');
  assert.equal(readingFreshness(stamp(t - 30001), t), 'stale');
  assert.equal(readingFreshness(stamp(t + 1000), t), 'recent');
  assert.equal(readingFreshness(stamp(t + 1001), t), 'clock_skew');
  assert.equal(readingFreshness('not-a-date', t), 'unverifiable');
  assert.equal(readingFreshness(stamp(t), NaN), 'unverifiable');
});

test('CPU interval metadata must agree with observation timestamps', () => {
  const t = Date.now();
  for (const measuredFrom of [stamp(t - 100), stamp(t - 3100)]) {
    const row = { ...measured(t).data.metrics.cpu, measuredFrom, windowMs: 400 };
    assert.equal(normalizeSnapshot(measured(t, {cpu: row})).metrics.cpu.reason, 'CPU_INTERVAL_INVALID');
  }
});

test('trend peak reports only actual samples in the latest uninterrupted paired interval', () => {
  const t = Date.now() - 50000;
  const rows = [
    { time: t, cpu: 100, memory: 90 },
    { time: t + 5000, cpu: 80, memory: 70 },
    { time: t + 10000, cpu: null, memory: null },
    { time: t + 15000, cpu: 10, memory: 20 },
    { time: t + 20000, cpu: 70, memory: 65 },
    { time: t + 25000, cpu: 10, memory: 20 },
  ];
  const summary = trendSummary(rows);
  assert.equal(summary.cpuDelta, 0, 'last-to-first delta hides transient activity');
  assert.equal(summary.memoryDelta, 0);
  assert.equal(summary.cpuPeak, 70, 'old segment peak cannot contaminate current range');
  assert.equal(summary.memoryPeak, 65);
  assert.equal(summary.cpuSamples, 3);
  assert.equal(summary.from, t + 15000);
});

test('only explicitly supplied local transport failures survive unknown SDP attribution', () => {
  const now = Date.now(), timing = { requestedAt: now, receivedAt: now };
  for (const normalize of [normalizeSecurity, normalizeEvents]) {
    for (const reason of ['LOCAL_FETCH_FAILED','REQUEST_CANCELLED','RESPONSE_TOO_LARGE','RESPONSE_CONTRACT_INVALID']) {
      const failure = normalize(null, timing, reason);
      assert.equal(failure.mode, 'unknown');
      assert.equal(failure.status, 'unavailable');
      assert.equal(failure.reason, reason);
      assert.equal(failure.checkedAt, null);
    }
    assert.equal(normalize(null, timing, 'PRIVATE_MESSAGE').reason, 'SOURCE_MODE_UNVERIFIED');
    const untrusted = { ok: false, meta: { mode: 'unknown' }, error: { code: 'LOCAL_FETCH_FAILED' } };
    assert.equal(normalize(untrusted, timing).reason, 'SOURCE_MODE_UNVERIFIED');
  }
  assert.equal(localTransportReason(Error('RESPONSE_TOO_LARGE')), 'RESPONSE_TOO_LARGE');
  assert.equal(localTransportReason(Error('private path')), 'LOCAL_FETCH_FAILED');
});
test('a stopped or failed interval retains its last completed paired summary without connecting later samples', () => {
  const t = Date.now() - 30000;
  const good = [{ time:t,cpu:10,memory:20 }, { time:t+5000,cpu:60,memory:40 }];
  const stopped = appendGap(good, t+6000);
  assert.equal(trendSummary(stopped), null);
  assert.equal(completedTrendSummary(stopped).cpuPeak, 60);
  assert.equal(completedTrendSummary(stopped).to, t+5000);
  const next = [...stopped, { time:t+10000,cpu:5,memory:10 }];
  assert.equal(trendSummary(next), null);
  assert.equal(completedTrendSummary(next).cpuDelta, 50);
  next.push({ time:t+15000,cpu:7,memory:12 });
  assert.equal(trendSummary(next).cpuDelta, 2);
  const ended = appendGap(next, t+16000);
  assert.equal(completedTrendSummary(ended).cpuPeak, 7);
  assert.equal(completedTrendSummary(trimHistory(ended, t+HISTORY_WINDOW_MS+20000)), null);
  assert.equal(completedTrendSummary(good), null);
});
