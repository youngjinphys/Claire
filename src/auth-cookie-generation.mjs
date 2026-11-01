import { createHmac, timingSafeEqual } from 'node:crypto';

// The legacy cookie remains readable while an already-open Claire client
// migrates. Each new auth operation gets a distinct, signed cookie NAME: a
// late Set-Cookie response cannot overwrite a newer operation's slot.
const LEGACY = 'aleph_refresh';
const PREFIX = 'aleph_auth_g_';
const MAX_AGE = 7 * 24 * 60 * 60;
const MAX_COOKIE_HEADER = 16000;
const MAX_GENERATION_COOKIES = 12;
const MAX_REFRESH_BYTES = 8192;
const MAX_VERSIONED_COOKIE_TOKEN = 3400;
const MAX_GENERATION = BigInt(Number.MAX_SAFE_INTEGER);
const GEN_NAME = /^aleph_auth_g_([1-9a-z][0-9a-z]{0,12})$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/u;
const GEN_TEXT = /^[1-9][0-9]{0,15}$/u;
const COOKIE_BYTES = /^[\x09\x20-\x7e]*$/u;

const cookieAttrs = (env, age) => {
  const list = ['HttpOnly', 'SameSite=Strict', 'Path=/api/auth', `Max-Age=${age}`];
  if (env.VERCEL === '1' || env.NODE_ENV === 'production') list.push('Secure');
  return list.join('; ');
};
const checkToken = token => typeof token === 'string' && token.length > 0
  && Buffer.byteLength(token) <= MAX_REFRESH_BYTES
  && Buffer.byteLength(encodeURIComponent(token)) <= MAX_VERSIONED_COOKIE_TOKEN
  && !/[\x00-\x1f\x7f]/u.test(token);

function parseOrdinal(text) {
  if (!/^[1-9a-z][0-9a-z]{0,12}$/u.test(text)) return null;
  let number = 0n;
  for (const char of text) {
    const digit = BigInt(parseInt(char, 36));
    number = number * 36n + digit;
    if (number > MAX_GENERATION) return null;
  }
  return number > 0n && number.toString(36) === text ? number : null;
}

export function createAuthCookieGeneration({ env = process.env, supabaseFactory = null,
  nextGeneration = null } = {}) {
  if (typeof env.SUPABASE_SECRET_KEY !== 'string' || env.SUPABASE_SECRET_KEY.length < 24)
    throw Error('AUTH_GENERATION_CONFIGURATION_INVALID');
  // Domain separation avoids treating the Supabase service key as a raw cookie MAC key.
  const key = createHmac('sha256', env.SUPABASE_SECRET_KEY)
    .update('claire-cookie-generation-key/v1').digest();
  let admin;
  const ordinal = async () => {
    let value;
    if (nextGeneration) value = await nextGeneration();
    else {
      if (!admin) {
        if (typeof supabaseFactory !== 'function') throw Error('AUTH_GENERATION_UNAVAILABLE');
        admin = supabaseFactory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } });
      }
      const request = admin.rpc('s12_auth_cookie_generation_next');
      const controller = AbortSignal.timeout(8000);
      const cancellable = typeof request?.abortSignal === 'function'
        ? request.abortSignal(controller) : request;
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve(cancellable),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('AUTH_GENERATION_UNAVAILABLE')), 8000);
          }),
        ]);
        if (result?.error) throw Error('AUTH_GENERATION_UNAVAILABLE');
        value = result?.data;
      } finally { clearTimeout(timer); }

    }
    if (typeof value !== 'string' || !GEN_TEXT.test(value)) throw Error('AUTH_GENERATION_UNAVAILABLE');
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > MAX_GENERATION) throw Error('AUTH_GENERATION_UNAVAILABLE');
    return parsed;
  };
  const mac = (generation, kind, token) => createHmac('sha256', key)
    .update(`claire/v1\0${generation.toString(10)}\0${kind}\0${token}`)
    .digest('base64url');
  function decodeCookie(name, value) {
    const parsed = GEN_NAME.exec(name);
    const generation = parsed && parseOrdinal(parsed[1]);
    if (!generation || typeof value !== 'string' || value.length > MAX_REFRESH_BYTES + 160)
      return null;
    const delimiter = value.indexOf('.');
    const second = value.indexOf('.', delimiter + 1);
    if (delimiter !== 1 || second < 0) return null;
    const kind = value[0], signature = value.slice(2, second), raw = value.slice(second + 1);
    if (!['r','x'].includes(kind) || !SIGNATURE.test(signature)) return null;
    let token;
    try { token = decodeURIComponent(raw); } catch { return null; }
    if ((kind === 'r' && !checkToken(token)) || (kind === 'x' && token !== '')) return null;
    const actual = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(mac(generation, kind, token), 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return { name, generation, kind, token };
  }
  function parse(header = '') {
    const cleanupNames = [];
    const invalid = () => ({ invalid: true, legacy: null, entries: [], selected: null, cleanupNames });
    if (header == null) header = '';
    if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER || !COOKIE_BYTES.test(header))
      return invalid();
    const seen = new Set(), entries = [];
    const legacy = [];
    for (const part of header.split(';')) {
      const item = part.trim();
      if (!item) continue;
      const sep = item.indexOf('=');
      if (sep < 1) continue;
      const name = item.slice(0, sep).trim(), value = item.slice(sep + 1).trim();
      if (name === LEGACY) { legacy.push(value); continue; }
      if (!name.startsWith(PREFIX)) continue;
      if (/^[A-Za-z0-9_]{1,60}$/u.test(name)) cleanupNames.push(name);
      if (seen.has(name) || entries.length >= MAX_GENERATION_COOKIES) return invalid();
      seen.add(name);
      const parsed = decodeCookie(name, value);
      if (!parsed) return invalid();
      entries.push(parsed);
    }
    entries.sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    if (entries.length) return { invalid: false, legacy: null, entries, selected: entries.at(-1), cleanupNames };
    if (legacy.length > 1) return invalid();
    const raw = legacy[0];
    if (raw == null) return { invalid: false, legacy: null, entries: [], selected: null, cleanupNames };
    let token;
    try { token = decodeURIComponent(raw); } catch { token = null; }
    if (!checkToken(token)) return invalid();
    return { invalid: false, legacy: token, entries: [], selected: null, cleanupNames };
  }
  function cookieOf(sequence, kind, token) {
    const name = PREFIX + sequence.toString(36);
    const value = `${kind}.${mac(sequence, kind, token)}.${encodeURIComponent(token)}`;
    return name + '=' + value + '; ' + cookieAttrs(env, MAX_AGE);
  }
  function write(response, seen, sequence, { token = null, revoked = false } = {}) {
    if (typeof sequence !== 'bigint' || sequence <= 0n || sequence > MAX_GENERATION || (revoked ? token !== null : !checkToken(token)))
      throw Error('AUTH_GENERATION_INVALID');
    const clear = (name) => name + '=; ' + cookieAttrs(env, 0);
    const out = [...new Set([...(seen?.entries || []).map(item => item.name), ...(seen?.cleanupNames || [])])].map(clear);
    // Keep the old cookie/JSON surface compatible with already-loaded clients.
    out.push(revoked ? clear(LEGACY) : LEGACY + '=' + encodeURIComponent(token) + '; ' + cookieAttrs(env, MAX_AGE));
    out.push(cookieOf(sequence, revoked ? 'x' : 'r', revoked ? '' : token));
    response.setHeader('Set-Cookie', out);
  }
  function refreshToken(seen) {
    if (seen.invalid) return null;
    if (seen.selected) return seen.selected.kind === 'r' ? seen.selected.token : null;
    return seen.legacy;
  }
  return Object.freeze({ parse, next: ordinal, refreshToken, write });
}
