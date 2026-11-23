import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createAuthCookieGeneration } from '../src/auth-cookie-generation.mjs';
import { createAuthHandler } from '../api/auth.js';

const env = { SUPABASE_SECRET_KEY: 'synthetic-expiry-test-secret-never-deployed' };
const DAY = 86400000;
const response = () => ({ setHeader(name, value) { this[name] = value; } });
function fixture() {
  let now = Date.UTC(2026, 10, 23), sequence = 0;
  const api = (skew = 0) => createAuthCookieGeneration({ env,
    clock: () => now + skew, monotonic: () => now,
    nextGeneration: async () => String(++sequence) });
  // Model actual browser receipt time; older responses can arrive later.
  const jar = new Map();
  return {
    api, advance(ms) { now += ms; },
    apply(res) {
      for (const cookie of res['Set-Cookie']) {
        const [pair, ...attrs] = cookie.split(';');
        const eq = pair.indexOf('='), name = pair.slice(0, eq);
        const age = Number(attrs.find(x => x.trim().startsWith('Max-Age=')).trim().slice(8));
        if (age === 0) jar.delete(name);
        else jar.set(name, { value: pair.slice(eq + 1), expiresAt: now + age * 1000 });
      }
    },
    header() {
      for (const [name, cookie] of jar) if (now >= cookie.expiresAt) jar.delete(name);
      return [...jar].map(([name, c]) => `${name}=${c.value}`).join('; ');
    },
  };
}

for (const newerKind of ['logout', 'login']) test(`late login cannot revive after newer ${newerKind} ordering cookie expires`, async () => {
  const f = fixture(), older = f.api(), newer = f.api();
  const pending = await older.next();
  f.advance(1000);
  const latest = response();
  newer.write(latest, newer.parse(''), await newer.next(), newerKind === 'logout' ? { revoked: true } : { token: 'newer-fixture' });
  f.apply(latest);
  f.advance(9000);
  const late = response();
  older.write(late, older.parse(''), pending, { token: 'older-fixture' });
  f.apply(late);
  assert.equal(newer.refreshToken(newer.parse(f.header())), newerKind === 'logout' ? null : 'newer-fixture');
  f.advance(8 * DAY - 8000);
  // The newer slot has expired by receipt time; the delayed older slot remains.
  assert.equal(newer.parse(f.header()).selected.generation, 1n);
  assert.equal(newer.refreshToken(newer.parse(f.header())), null);
});

test('the highest expired generation never falls back to an older still-valid credential under bounded worker skew', async () => {
  const f = fixture(), ahead = f.api(30000), behind = f.api(-30000), verifier = f.api();
  const old = response(), newest = response();
  ahead.write(old, ahead.parse(''), await ahead.next(), { token: 'older-fixture' });
  behind.write(newest, behind.parse(''), await behind.next(), { token: 'newer-fixture' });
  f.apply(newest); f.apply(old);
  f.advance(7 * DAY - 15000);
  const parsed = verifier.parse(f.header());
  assert.equal(parsed.selected.generation, 2n);
  assert.equal(verifier.refreshToken(parsed), null);
  assert.equal(verifier.refreshToken(verifier.parse(f.header().split('; ').find(x => x.startsWith('aleph_auth_g_1=')))), 'older-fixture');
});

test('enforce mode rejects bare legacy and previously signed v1 credentials; explicit new login repairs them', async () => {
  const f = fixture(), api = f.api();
  const key = createHmac('sha256', env.SUPABASE_SECRET_KEY).update('claire-cookie-generation-key/v1').digest();
  const signature = createHmac('sha256', key).update('claire/v1\0' + '1\0r\0old-fixture').digest('base64url');
  for (const header of ['aleph_refresh=old-fixture', `aleph_auth_g_1=r.${signature}.old-fixture`]) {
    const seen = api.parse(header);
    assert.equal(api.refreshToken(seen), null);
    const renewed = response(); api.write(renewed, seen, await api.next(), { token: 'new-fixture' });
    assert.ok(renewed['Set-Cookie'].includes('aleph_refresh=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0'));
    f.apply(renewed);
    assert.equal(api.refreshToken(api.parse(f.header())), 'new-fixture');
  }
});

test('signed issue time cannot be extended by tampering', async () => {
  const f = fixture(), api = f.api(), res = response();
  api.write(res, api.parse(''), await api.next(), { token: 'fixture' }); f.apply(res);
  const cookie = f.header(), seen = api.parse(cookie);
  const altered = cookie.replace(`.${seen.selected.issuedAt}.`, `.${seen.selected.issuedAt + DAY}.`);
  assert.notEqual(altered, cookie);
  assert.equal(api.refreshToken(api.parse(altered)), null);
});

test('an expired pre-provider reservation cannot be published as a fresh credential', async () => {
  const f = fixture(), api = f.api(), claim = await api.next();
  f.advance(7 * DAY);
  assert.throws(() => api.write(response(), api.parse(''), claim, { token: 'fixture' }), /AUTH_GENERATION_EXPIRED/);
  assert.throws(() => api.write(response(), api.parse(''), { generation: 999n }, { token: 'fixture' }), /AUTH_GENERATION_INVALID/);
});

test('future issuance and wall-clock discontinuity fail closed', async () => {
  const f = fixture(), future = f.api(60000), verifier = f.api(), res = response();
  future.write(res, future.parse(''), await future.next(), { token: 'fixture' }); f.apply(res);
  assert.equal(verifier.refreshToken(verifier.parse(f.header())), null);
  let wall = Date.UTC(2026, 10, 23);
  const changed = createAuthCookieGeneration({ env, clock: () => wall, monotonic: () => 1, nextGeneration: async () => '1' });
  const claim = await changed.next(); wall += 60000;
  assert.throws(() => changed.write(response(), changed.parse(''), claim, { token: 'fixture' }), /AUTH_GENERATION_EXPIRED/);
});

test('the real login handler reserves before provider work and returns no session after reservation expiry', async () => {
  let now = Date.UTC(2026, 10, 23), complete, reached;
  const waiting = new Promise(resolve => { complete = resolve; });
  const providerStarted = new Promise(resolve => { reached = resolve; });
  const config = { ...env, AUTH_COOKIE_GENERATION_MODE: 'enforce', SUPABASE_URL: 'https://fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public' };
  const h = createAuthHandler({ env: config,
    generationFactory: () => createAuthCookieGeneration({ env: config, clock: () => now, monotonic: () => now, nextGeneration: async () => '1' }),
    riskGuardFactory: () => ({ claim: async () => ({ allowed: true }), record: async () => {} }),
    supabaseFactory: () => ({ auth: { async signInWithPassword() {
      reached(); await waiting;
      return { data: { session: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } }, error: null };
    } } }),
  });
  const res = { ...response(), status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  const pending = h({ method: 'POST', query: { action: 'login' }, headers: { 'content-type': 'application/json' }, body: { email: 'fixture@example.invalid', password: 'synthetic-password' } }, res);
  await providerStarted; now += 7 * DAY; complete(); await pending;
  assert.equal(res.code, 503);
  assert.deepEqual(res.body, { error: 'AUTH_GENERATION_UNAVAILABLE' });
  assert.equal(res['Set-Cookie'], undefined);
});

test('a confirmed invalid refresh tombstones its input ordinal and retains the original signed acceptance window', async () => {
  const f = fixture(), api = f.api(), res = response();
  api.write(res, api.parse(''), await api.next(), { token: 'fixture' }); f.apply(res);
  const input = api.parse(f.header()), tombstone = response();
  f.advance(DAY);
  api.write(tombstone, input, input.selected, { revoked: true }); f.apply(tombstone);
  const result = api.parse(f.header());
  assert.equal(result.selected.generation, input.selected.generation);
  assert.equal(result.selected.issuedAt, input.selected.issuedAt);
  assert.equal(result.selected.expiresAt, input.selected.expiresAt);
  assert.equal(api.refreshToken(result), null);
});
