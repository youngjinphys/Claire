import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createOnServer } from '../src/server.mjs';

test('local PC cache expires on monotonic time even if the wall clock rolls back', async t => {
  const server = createOnServer({});
  const originalNow = Date.now;
  t.after(async () => {
    Date.now = originalNow;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/local-pc`;
  const first = (await (await fetch(url)).json()).data.checkedAt;
  Date.now = () => originalNow() - 60000;
  await sleep(1100);
  const second = (await (await fetch(url)).json()).data.checkedAt;
  assert.notEqual(second, first, 'manual measurement must recover without waiting for wall time to catch up');
});
