import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnServer } from '../src/server.mjs';
import { demoEngine } from '../src/engine.mjs';

async function serve(t, options) {
  const server = createOnServer(options);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const kind of ['read', 'request']) test(`${kind} deadline rejects a synchronous late engine result before timer delivery`, async t => {
  const engine = demoEngine(), original = engine.readIdentity;
  let calls = 0, now = 0;
  t.mock.method(performance, 'now', () => now);
  engine.readIdentity = () => { calls++; now += 45; return original(); };
  const origin = await serve(t, { engine, readTimeoutMs:kind === 'read' ? 15 : 1000, requestTimeoutMs:kind === 'request' ? 15 : 1000 });
  const response = await fetch(origin + '/api/me'), body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, kind === 'read' ? 'ENGINE_TIMEOUT' : 'REQUEST_TIMEOUT');
  assert.equal(calls, 1);
});

test('request publication checks the deadline after synchronous metadata construction', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const origin = await serve(t, { engine:demoEngine(), requestTimeoutMs:15, clock:() => { now += 45; return new Date(); } });
  const response = await fetch(origin + '/api/me'), body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'REQUEST_TIMEOUT');
});
