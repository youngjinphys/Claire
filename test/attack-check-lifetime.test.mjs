import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import config from '../aleph.config.json' with { type: 'json' };
import { runAttackChecks } from '../src/attack-check.mjs';
import { runStage12ReadOnlyChecks } from '../src/attack-check-stage12.mjs';
import { probeResponse, readBoundedJson } from '../src/probe-response-lifetime.mjs';

const never = () => new Promise(() => {});
const encoder = new TextEncoder();
function trackedResponse({ status = 200, type = 'application/json', text = '{}',
  headers = {}, chunks = [encoder.encode(text)], hangRead = false,
  readError = false, cancel = 'resolve', onRead = () => {}, onAcquire = () => {} } = {}) {
  const state = { readers: 0, reads: 0, readerCancels: 0, bodyCancels: 0, releases: 0 };
  let index = 0;
  const cancelled = () => {
    if (cancel === 'throw') throw new Error('synthetic cancel failure');
    if (cancel === 'reject') return Promise.reject(new Error('synthetic cancel rejection'));
    return cancel === 'hang' ? never() : Promise.resolve();
  };
  const reader = {
    read() {
      state.reads++;
      onRead();
      if (readError) return Promise.reject(new Error('synthetic read failure'));
      if (hangRead) return never();
      return Promise.resolve(index < chunks.length ? { done: false, value: chunks[index++] } : { done: true });
    },
    cancel() { state.readerCancels++; return cancelled(); },
    releaseLock() { state.releases++; },
  };
  return { state, response: {
    status, ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': type, 'cache-control': 'no-store', ...headers }),
    body: {
      getReader() { state.readers++; onAcquire(); return reader; },
      cancel() { state.bodyCancels++; return cancelled(); },
    },
  } };
}

const unauthorized = () => Response.json({ error: 'UNAUTHORIZED' }, {
  status: 401, headers: { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' },
});
const stage12 = (fetchImpl, probeTimeoutMs = 100) => runStage12ReadOnlyChecks(
  config, new URL(config.publicAppUrl), fetchImpl, { probeTimeoutMs },
);
const record = (rows, id) => rows.find(row => row.attackId === id);

test('Stage12 bounds an abort-ignoring fetch, owns other bodies immediately, and discards a late response', { timeout: 2000 }, async () => {
  let deliver, signal;
  const waiting = new Promise(resolve => { deliver = resolve; });
  const fast = trackedResponse({ text: '{"notes":[]}' });
  const pending = stage12(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/aleph.json') { signal = init.signal; return waiting; }
    if (path === '/data.json') return fast.response;
    return unauthorized();
  });
  await tick();
  assert.ok(fast.state.reads > 0, 'one delayed fetch must not postpone ownership of other bodies');
  const rows = await pending;
  assert.equal(rows.length, 20);
  assert.equal(signal.aborted, true);
  assert.equal(record(rows, 'deployed_restore_route').observed, 'not_run');
  assert.match(record(rows, 'stage12_static_data_redaction').observed, /HTTP 200.*정적 메모 빈 배열/u);
  const late = trackedResponse({ cancel: 'hang' });
  deliver(late.response);
  await tick();
  assert.equal(late.state.bodyCancels, 1);
  assert.equal(late.state.readers, 0);
});

test('Stage12 body timeout retains observed HTTP metadata and never credits incomplete JSON', { timeout: 2000 }, async () => {
  const body = trackedResponse({ hangRead: true, cancel: 'hang', headers: { 'x-vercel-id': 'fixture::observed' } });
  const rows = await stage12(url => new URL(url).pathname === '/aleph.json' ? body.response : unauthorized());
  const observed = record(rows, 'deployed_restore_route').observed;
  assert.match(observed, /GET https:.*\/aleph\.json HTTP 200; requestId=x-vercel-id:fixture::observed;/u);
  assert.match(observed, /미확인/u);
  assert.equal(body.state.readerCancels, 1);
  assert.ok(body.state.releases > 0);
});

test('Stage12 header-only and unexpected successful private bodies are discarded without a reader', { timeout: 2000 }, async () => {
  const privateStates = [];
  const homeStates = [];
  const rows = await stage12((url, init) => {
    const path = new URL(url).pathname;
    if (path === '/') {
      const item = trackedResponse({ type: 'text/html', cancel: 'hang' });
      homeStates.push(item.state);
      return item.response;
    }
    if (path.startsWith('/api/') && path !== '/api/ops') {
      const item = trackedResponse({ text: '{"body":"PRIVATE_FIXTURE_MUST_NOT_BE_READ"}', cancel: 'reject' });
      privateStates.push(item.state);
      return item.response;
    }
    assert.equal(init.credentials, 'omit');
    return unauthorized();
  });
  await tick();
  assert.equal(homeStates.length, 2);
  assert.equal(privateStates.length, 6);
  for (const state of [...homeStates, ...privateStates]) {
    assert.equal(state.readers, 0);
    assert.equal(state.bodyCancels, 1);
  }
  assert.match(record(rows, 'existing_browser_ui').observed, /HTTP 200.*HTML 제공/u);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_FIXTURE_MUST_NOT_BE_READ/u);
});

for (const sample of [
  { name: 'wrong MIME', options: { type: 'text/plain' }, readers: 0 },
  { name: 'oversized declaration', options: { headers: { 'content-length': '24577' } }, readers: 0 },
  { name: 'malformed declaration', options: { headers: { 'content-length': '-1' } }, readers: 0 },
  { name: 'oversized received bytes', options: { chunks: [new Uint8Array(24577)] }, readers: 1 },
  { name: 'malformed UTF-8', options: { chunks: [new Uint8Array([0xff])] }, readers: 1 },
  { name: 'invalid JSON', options: { text: '{' }, readers: 1 },
  { name: 'stream failure', options: { readError: true }, readers: 1 },
  { name: 'non-byte stream chunk', options: { chunks: ['not bytes'] }, readers: 1 },
]) {
  test(`Stage12 rejects ${sample.name} and cleanup cannot delay completion`, { timeout: 2000 }, async () => {
    const body = trackedResponse({ ...sample.options, cancel: 'hang' });
    const rows = await stage12(url => new URL(url).pathname === '/data.json' ? body.response : unauthorized());
    assert.equal(body.state.readers, sample.readers);
    assert.equal(body.state.readerCancels + body.state.bodyCancels, 1);
    assert.match(record(rows, 'stage12_static_data_redaction').observed, /HTTP 200.*미확인/u);
  });
}

test('whole-probe monotonic checks reject late headers and body work without resetting the deadline', async () => {
  for (const lateHeaders of [false, true]) {
    let now = 0;
    const body = trackedResponse({ text: '{"notes":[]}', onRead: () => { now = 6; } });
    const result = await probeResponse({ url: 'https://fixture.invalid/', timeoutMs: 5, now: () => now,
      fetchImpl: () => { now = lateHeaders ? 6 : 4; return body.response; },
      consume: (response, ownership) => readBoundedJson(response, ownership),
    });
    assert.equal(result.value, null);
    assert.equal(result.error, 'PROBE_TIMEOUT');
    assert.equal(result.response, lateHeaders ? null : body.response);
    assert.equal(body.state.readers, lateHeaders ? 0 : 1);
    assert.equal(body.state.readerCancels + body.state.bodyCancels, 1);
  }
});

test('native stalled stream releases its reader even when cancellation never settles', { timeout: 2000 }, async () => {
  let cancelled = 0, acquired = 0;
  const body = new ReadableStream({ cancel() { cancelled++; return never(); } }, { highWaterMark: 0 });
  const originalReader = body.getReader.bind(body);
  body.getReader = () => { acquired++; return originalReader(); };
  const response = new Response(body, { headers: { 'content-type': 'application/json' } });
  const result = await probeResponse({ url: 'https://fixture.invalid/', timeoutMs: 100,
    fetchImpl: () => response, consume: (reply, ownership) => readBoundedJson(reply, ownership),
  });
  assert.equal(result.response, response);
  assert.equal(result.error, 'PROBE_TIMEOUT');
  assert.equal(acquired, 1);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('invalid probe deadline overrides cannot begin a request', async () => {
  const fetchImpl = () => { throw new Error('request must not start'); };
  for (const probeTimeoutMs of [0, -1, 1.5, Infinity, '20', 10001]) {
    await assert.rejects(runAttackChecks(config, { fetchImpl, probeTimeoutMs }), /INVALID_PROBE_TIMEOUT/u);
    await assert.rejects(stage12(fetchImpl, probeTimeoutMs), /INVALID_PROBE_TIMEOUT/u);
  }
});

const configFor = step => ({ ...config, step, sampleMarker: 'SYNTHETIC_MARKER' });
const httpRecords = new Map([[1, 1], [2, 3], [3, 2], [4, 2], [5, 6], [6, 3], [7, 3], [8, 3], [9, 3], [10, 4]]);
for (const [step, count] of httpRecords) {
  test(`retained stage ${step}: unobserved requests finish as not_run without fabricated HTTP status`, { timeout: 3000 }, async () => {
    const late = [];
    const rows = await runAttackChecks(configFor(step), {
      probeTimeoutMs: 5,
      fetchImpl: (_url, init) => new Promise(resolve => { late.push({ resolve, signal: init.signal }); }),
    });
    assert.equal(rows.filter(row => row.observed === 'not_run').length, count);
    assert.doesNotMatch(JSON.stringify(rows), /HTTP (?:null|undefined|0)\b/u);
    const states = late.map(({ resolve, signal }) => {
      assert.equal(signal.aborted, true);
      const item = trackedResponse({ cancel: 'throw' });
      resolve(item.response);
      return item.state;
    });
    await tick();
    assert.ok(states.every(state => state.bodyCancels === 1 && state.readers === 0));
  });
}

for (const step of [3, 4, 5, 6, 7, 8, 9, 10]) {
  test(`retained stage ${step}: successful private bodies are never acquired`, async () => {
    const privateStates = [];
    const homeStates = [];
    const rows = await runAttackChecks(configFor(step), { fetchImpl: url => {
      const target = new URL(url);
      if (target.pathname === '/aleph.json') return Response.json(configFor(step));
      if (target.pathname === '/') {
        if (step === 5) return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
        const item = trackedResponse({ type: 'text/html', cancel: 'hang' });
        homeStates.push(item.state);
        return item.response;
      }
      const item = trackedResponse({ text: '{"body":"PRIVATE_FIXTURE_MUST_NOT_BE_READ"}', cancel: 'hang' });
      privateStates.push(item.state);
      return item.response;
    } });
    assert.ok(privateStates.length > 0);
    for (const state of [...privateStates, ...homeStates]) {
      assert.equal(state.readers, 0);
      assert.equal(state.bodyCancels, 1);
    }
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_FIXTURE_MUST_NOT_BE_READ/u);
  });
}

test('legacy incomplete 401 bodies cannot prove that no protected data was returned', { timeout: 2000 }, async () => {
  const bodies = [];
  const rows = await runAttackChecks(configFor(3), { probeTimeoutMs: 10, fetchImpl: () => {
    const item = trackedResponse({ status: 401, hangRead: true, cancel: 'hang' });
    bodies.push(item.state);
    return item.response;
  } });
  assert.ok(rows.every(row => /검증 실패.*HTTP 401/u.test(row.observed)));
  assert.ok(bodies.every(body => body.readerCancels === 1));
});

test('legacy JSON and HTML reads enforce byte limits and never infer a missing public key from unread HTML', async () => {
  const oversizedJson = trackedResponse({ headers: { 'content-length': '24577' }, cancel: 'hang' });
  const first = await runAttackChecks(configFor(1), { fetchImpl: () => oversizedJson.response });
  assert.match(first[0].observed, /보이지 않음.*HTTP 200/u);
  assert.equal(oversizedJson.state.readers, 0);
  assert.equal(oversizedJson.state.bodyCancels, 1);
  const oversizedHtml = trackedResponse({ type: 'text/html', chunks: [new Uint8Array(128 * 1024 + 1)], cancel: 'hang' });
  const rows = await runAttackChecks(configFor(5), { fetchImpl: url => {
    const path = new URL(url).pathname;
    if (path === '/') return oversizedHtml.response;
    if (path === '/aleph.json') return Response.json(configFor(5));
    return unauthorized();
  } });
  assert.match(record(rows, 'screen_public_key_absent').observed, /확인 미완료.*HTTP 200/u);
  assert.equal(oversizedHtml.state.readerCancels, 1);
});
