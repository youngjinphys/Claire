import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('an updated installation retrieves the public recovery page from its own cache', async () => {
  const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../public/offline.html', import.meta.url), 'utf8');
  const oldCache = 'byte-back-offline-v1';
  const otherCache = 'another-app';
  const handlers = new Map();
  const removed = [];
  let installedCache;
  let installedPath;
  runInNewContext(worker, {
    self: {
      addEventListener: (event, handler) => handlers.set(event, handler),
      skipWaiting() {},
      clients: { claim() {} },
    },
    Request: class extends Request {
      constructor(path, options) { super(new URL(path, 'https://portal.example'), options); }
    },
    caches: {
      async open(name) {
        installedCache = name;
        return { async add(request) {
          installedPath = new URL(request.url).pathname;
          assert.equal(request.cache, 'reload');
        } };
      },
      async keys() { return [otherCache, oldCache, installedCache]; },
      async delete(name) { removed.push(name); },
      async match(path, options) {
        return path === installedPath && options?.cacheName === installedCache ? page : undefined;
      },
    },
    async fetch() { throw new TypeError('Offline'); },
  });
  for (const phase of ['install', 'activate']) {
    let completion;
    handlers.get(phase)({ waitUntil(promise) { completion = promise; } });
    assert.ok(completion);
    await completion;
  }
  assert.equal(installedPath, '/offline.html');
  assert.deepEqual(removed, [oldCache]);

  const navigate = handlers.get('fetch');
  let fallback;
  navigate({ request: { mode: 'navigate', method: 'GET' }, respondWith(result) { fallback = result; } });
  assert.match(await fallback, /<a\s+href="\/">[^<]+<\/a>/u);
  for (const request of [{ mode: 'cors', method: 'GET' }, { mode: 'navigate', method: 'POST' }]) {
    navigate({ request, respondWith() { assert.fail('Only GET navigations receive the public page'); } });
  }
});
