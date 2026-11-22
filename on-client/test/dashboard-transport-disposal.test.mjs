import assert from 'node:assert/strict';
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
