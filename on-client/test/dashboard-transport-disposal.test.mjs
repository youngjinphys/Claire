import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { requestDashboardJson } from '../public/dashboard-model.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const streamResponse = (status = 200, type = 'application/json') => {
  let cancels = 0;
  const stream = new ReadableStream({ cancel() { cancels++; } });
  const response = new Response(stream, { status, headers: { 'content-type': type } });
  return { response, cancelled: () => cancels };
};

test('late response body is closed when fetch ignores the request timeout signal', async () => {
  let deliver;
  const future = new Promise(resolve => { deliver = resolve; });
  const pending = requestDashboardJson('/api/events', { timeoutMs: 20, fetchImpl: () => future });
  await assert.rejects(pending, /LOCAL_FETCH_FAILED/);
  const late = streamResponse();
  deliver(late.response);
  await settle();
  assert.equal(late.cancelled(), 1, 'late body must not remain open after deadline');
});

test('late response body is closed after user cancellation even for an uncooperative fetch', async () => {
  let deliver;
  const future = new Promise(resolve => { deliver = resolve; });
  const abort = new AbortController();
  const pending = requestDashboardJson('/api/events', { signal: abort.signal, fetchImpl: () => future });
  abort.abort();
  await assert.rejects(pending, /REQUEST_CANCELLED/);
  const late = streamResponse();
  deliver(late.response);
  await settle();
  assert.equal(late.cancelled(), 1);
});

test('rejected MIME response body is disposed without consuming sensitive data', async () => {
  const invalid = streamResponse(200, 'text/html');
  await assert.rejects(requestDashboardJson('/api/events', { fetchImpl: async () => invalid.response }), /RESPONSE_CONTRACT_INVALID/);
  await settle();
  assert.equal(invalid.cancelled(), 1);
});

test('declared oversized JSON body is disposed without reading it', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const response = new Response(body, { headers: {'content-type':'application/json','content-length':'10485760'} });
  await assert.rejects(requestDashboardJson('/api/events', { maxBytes:1024, fetchImpl:async()=>response }), /RESPONSE_TOO_LARGE/);
  await settle();
  assert.equal(cancelled, 1);
});

test('valid same-origin JSON remains readable', async () => {
  const value = await requestDashboardJson('/api/events', {fetchImpl:async()=>Response.json({ok:true,data:[]})});
  assert.equal(value.ok,true);
});

for (const abortAtClock of [null, 1, 2]) test(`dashboard cancellation at clock ${abortAtClock ?? 'none'} is observed before fetch`, async () => {
  const caller = new AbortController();
  let clocks = 0, fetches = 0;
  const pending = requestDashboardJson('/api/events', {
    signal: caller.signal,
    monotonic: () => { if (++clocks === abortAtClock) caller.abort(); return 0; },
    fetchImpl: async (_path, options) => {
      fetches++;
      assert.equal(options.signal.aborted, false);
      return Response.json({ ok: true, data: [] });
    },
  });
  if (abortAtClock === null) {
    assert.deepEqual(await pending, { ok: true, data: [] });
    assert.equal(fetches, 1);
  } else {
    await assert.rejects(pending, /REQUEST_CANCELLED/);
    assert.equal(fetches, 0, 'cancellation before dispatch must send no request');
  }
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('synchronous fetch work cannot publish after the monotonic deadline before timers run', async () => {
  let now = 0;
  const late = streamResponse();
  await assert.rejects(requestDashboardJson('/api/events', {
    timeoutMs:10, monotonic:() => now,
    fetchImpl:() => { now = 11; return late.response; },
  }), /LOCAL_FETCH_FAILED/);
  await settle();
  assert.equal(late.cancelled(), 1);
});

test('body completion cannot publish success after the deadline', async () => {
  let now = 0, cancelled = 0, reads = 0;
  const reader = {
    async read() {
      if (reads++ === 0) return {done:false,value:new TextEncoder().encode('{"ok":true}')};
      now = 11; return {done:true};
    },
    cancel() { cancelled++; }, releaseLock() {},
  };
  await assert.rejects(requestDashboardJson('/api/events', {
    timeoutMs:10, monotonic:() => now,
    fetchImpl:() => ({ok:true,headers:new Headers({'content-type':'application/json'}),body:{getReader:() => reader}}),
  }), /LOCAL_FETCH_FAILED/);
  await settle();
  assert.equal(cancelled, 1);
});
