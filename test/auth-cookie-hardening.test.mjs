import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthSessionMissingError } from '@supabase/supabase-js';
import { createAuthHandler } from '../api/auth.js';
import { createAuthCookieGeneration } from '../src/auth-cookie-generation.mjs';

// Synthetic fixtures only. No real Supabase credentials, remote calls or accounts.
const env = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-only',
  SUPABASE_SECRET_KEY: 'synthetic-cookie-audit-key-32-bytes-not-real',
  AUTH_COOKIE_GENERATION_MODE: 'enforce',
  VERCEL: '1',
};
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { release, promise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const mockResponse = () => ({
  headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
function cookieJar() {
  const map = new Map();
  return {
    header: () => [...map].map(([key, value]) => key + '=' + value).join('; '),
    names: () => [...map.keys()],
    apply(response) {
      const cookies = response.headers['set-cookie'] || [];
      for (const line of typeof cookies === 'string' ? [cookies] : cookies) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq), value = pair.slice(eq + 1);
        if (attrs.some(attr => /Max-Age=0/u.test(attr))) map.delete(name);
        else map.set(name, value);
      }
    },
  };
}
function fixture({ holdFirst = true } = {}) {
  let currentGeneration = 0, failGeneration = false, refreshCount = 0;
  const firstRefresh = deferred();
  const config = { ...env };
  const factory = () => ({ auth: {
    async signInWithPassword({ email }) {
      const who = email.split('@')[0];
      return { data: { session: { access_token: 'access-' + who, refresh_token: 'refresh-' + who,
        expires_at: 1800000000, user: { email } } }, error: null };
    },
    async refreshSession({ refresh_token }) {
      const who = refresh_token.replace(/^(?:refresh-|rotated-)/u, '');
      if (refresh_token === 'refresh-alice') {
        refreshCount += 1;
        if (holdFirst && refreshCount === 1) await firstRefresh.promise;
        else return { data: { session: null }, error: new AuthSessionMissingError() };
      }
      return { data: { session: { access_token: 'access-' + who, refresh_token: 'rotated-' + who,
        expires_at: 1800000000, user: { email: who + '@example.invalid' } } }, error: null };
    },
    async signOut() { return { error: null }; },
  } });
  const genFactory = () => createAuthCookieGeneration({ env: config, nextGeneration: async () => {
    if (failGeneration) throw Error('synthetic offline sequence');
    return String(++currentGeneration);
  } });
  const handler = createAuthHandler({ env: config, supabaseFactory: factory,
    generationFactory: genFactory,
    riskGuardFactory: () => ({ claim: async () => ({ allowed: true }), record: async () => {} }),
  });
  async function call(action, header = '', who = 'alice') {
    const req = { method: 'POST', query: { action },
      headers: { cookie: header, origin: 'https://skt-aleph-defense.vercel.app',
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: { email: who + '@example.invalid', password: 'synthetic-only' },
    };
    const res = mockResponse();
    await handler(req, res);
    return res;
  }
  return { call, firstRefresh, get refreshCount() { return refreshCount; },
    failGeneration() { failGeneration = true; } };
}

test('concurrent refresh rejection invalidates only the input generation', async () => {
  const ctx = fixture(), browser = cookieJar();
  const login = await ctx.call('login');
  assert.equal(login.code, 200);
  browser.apply(login);
  const initialCookie = browser.header();
  const pending = ctx.call('session', initialCookie);
  for (let i = 0; i < 8 && ctx.refreshCount === 0; i += 1) await tick();
  assert.equal(ctx.refreshCount, 1);
  const rejected = await ctx.call('session', initialCookie);
  assert.equal(rejected.code, 401);
  assert.deepEqual(rejected.body, { error: 'SESSION_EXPIRED' });
  assert.equal(ctx.refreshCount, 2);
  browser.apply(rejected);
  ctx.firstRefresh.release();
  const success = await pending;
  assert.equal(success.code, 200);
  browser.apply(success);
  const restored = await ctx.call('session', browser.header());
  assert.equal(restored.code, 200);
  assert.equal(restored.body.user.email, 'alice@example.invalid');
  const responseNames = rejected.headers['set-cookie'].map(line => line.slice(0, line.indexOf('=')));
  assert.equal(new Set(responseNames).size, responseNames.length, 'one response must not duplicate cookie names');
});

test('stale signed refresh failure cannot erase a newer valid login', async () => {
  const ctx = fixture({ holdFirst: false }), browser = cookieJar();
  browser.apply(await ctx.call('login', '', 'alice'));
  const staleCookie = browser.header();
  browser.apply(await ctx.call('login', browser.header(), 'bob'));
  const newerCookie = browser.header();
  const rejected = await ctx.call('session', staleCookie);
  assert.equal(rejected.code, 401);
  browser.apply(rejected);
  assert.equal((await ctx.call('session', browser.header())).body.user.email, 'bob@example.invalid');
  assert.ok(browser.header().length <= newerCookie.length + 500);
});

test('generation outage during logout clears observed signed cookies without faking logout success', async () => {
  const ctx = fixture(), browser = cookieJar();
  browser.apply(await ctx.call('login'));
  assert.ok(browser.names().some(name => name.startsWith('aleph_auth_g_')));
  ctx.failGeneration();
  const outage = await ctx.call('logout', browser.header());
  assert.equal(outage.code, 503);
  assert.deepEqual(outage.body, { error: 'AUTH_GENERATION_UNAVAILABLE' });
  browser.apply(outage);
  assert.equal(browser.names().filter(name => name.startsWith('aleph_auth_g_')).length, 0);
  assert.equal(browser.names().includes('aleph_refresh'), false);
});

test('oversized valid signed cookie set is never authenticated and explicit login removes stale slots', async () => {
  let next = 0;
  const api = createAuthCookieGeneration({ env, nextGeneration: async () => String(++next) });
  const browser = cookieJar();
  for (let i = 0; i < 8; i += 1) {
    const res = mockResponse();
    api.write(res, api.parse(''), await api.next(), { token: 'synthetic-' + i + '-' + 'x'.repeat(2100) });
    browser.apply(res);
  }
  assert.ok(browser.header().length > 16000);
  const untrusted = api.parse(browser.header());
  assert.equal(untrusted.invalid, true);
  assert.equal(api.refreshToken(untrusted), null);
  assert.equal(untrusted.cleanupNames.length, 8);
  const renewal = mockResponse();
  api.write(renewal, untrusted, await api.next(), { token: 'recovered' });
  browser.apply(renewal);
  assert.equal(api.refreshToken(api.parse(browser.header())), 'recovered');
});

test('invalid first generation cookie does not strand valid later cookie names', async () => {
  const api = createAuthCookieGeneration({ env, nextGeneration: async () => '5' });
  const browser = cookieJar();
  const res = mockResponse();
  api.write(res, api.parse(''), 4n, { token: 'good' });
  browser.apply(res);
  const invalid = api.parse('aleph_auth_g_oops=r.bad.payload; ' + browser.header());
  assert.equal(invalid.invalid, true);
  assert.ok(invalid.cleanupNames.includes('aleph_auth_g_4'));
  assert.ok(invalid.cleanupNames.includes('aleph_auth_g_oops'));
});
