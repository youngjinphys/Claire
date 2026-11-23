import { createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Enforce mode accepts only time-bounded v2 generations. Bare legacy/v1
// credentials require explicit login; the handler's explicit legacy mode is
// a separate compatibility rollback, not an automatic authentication fallback.
const LEGACY = 'aleph_refresh';
const PREFIX = 'aleph_auth_g_';
const MAX_AGE = 7 * 24 * 60 * 60;
const ORDERING_AGE = 8 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_MS = 30000;
const MAX_COOKIE_HEADER = 16000;
// Normal authentication uses the ASCII header bound above. Explicit login may only
// discover bounded cookie *names* from a larger header to clear stale slots.
const MAX_RECOVERY_HEADER = 65536;
const MAX_RECOVERY_NAMES = 32;
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
  nextGeneration = null, clock = Date.now, monotonic = () => performance.now() } = {}) {
  if (typeof env.SUPABASE_SECRET_KEY !== 'string' || env.SUPABASE_SECRET_KEY.length < 24)
    throw Error('AUTH_GENERATION_CONFIGURATION_INVALID');
  // Domain separation avoids treating the Supabase service key as a raw cookie MAC key.
  const key = createHmac('sha256', env.SUPABASE_SECRET_KEY)
    .update('claire-cookie-generation-key/v1').digest();
  let admin;
  const reservations = new WeakMap(), validated = new WeakSet();
  const time = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER - MAX_AGE * 1000)
      throw Error('AUTH_GENERATION_UNAVAILABLE');
    return value;
  };
  const ordinal = async () => {
    let value;
    if (nextGeneration) value = await nextGeneration();
    else {
      if (!admin) {
        if (typeof supabaseFactory !== 'function') throw Error('AUTH_GENERATION_UNAVAILABLE');
        admin = supabaseFactory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } });
      }
      const started = monotonic();
      if (!Number.isFinite(started)) throw Error('AUTH_GENERATION_UNAVAILABLE');
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
        const elapsed = monotonic() - started;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 8000 || result?.error) throw Error('AUTH_GENERATION_UNAVAILABLE');
        value = result?.data;
      } finally { clearTimeout(timer); }

    }
    if (typeof value !== 'string' || !GEN_TEXT.test(value)) throw Error('AUTH_GENERATION_UNAVAILABLE');
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > MAX_GENERATION) throw Error('AUTH_GENERATION_UNAVAILABLE');
    return parsed;
  };
  async function reserve() {
    // Capture the acceptance window BEFORE allocator/provider work. A late
    // response must not acquire another seven days of server acceptance.
    const issuedAt = time(), started = monotonic();
    const generation = await ordinal();
    const claim = Object.freeze({ generation });
    reservations.set(claim, { generation, issuedAt, expiresAt: issuedAt + MAX_AGE * 1000, started });
    return claim;
  }
  const mac = (generation, kind, issuedAt, token) => createHmac('sha256', key)
    .update(`claire/v2\0${generation.toString(10)}\0${kind}\0${issuedAt}\0${token}`)
    .digest('base64url');
  function decodeCookie(name, value) {
    const parsed = GEN_NAME.exec(name);
    const generation = parsed && parseOrdinal(parsed[1]);
    if (!generation || typeof value !== 'string' || value.length > MAX_REFRESH_BYTES + 160)
      return null;
    const delimiter = value.indexOf('.');
    const second = value.indexOf('.', delimiter + 1);
    const third = value.indexOf('.', second + 1);
    if (delimiter !== 1 || second < 0 || third < 0) return null;
    const kind = value[0], signature = value.slice(2, second), timestamp = value.slice(second + 1, third), raw = value.slice(third + 1);
    const issuedAt = Number(timestamp);
    if (!/^[1-9][0-9]{0,15}$/u.test(timestamp) || !Number.isSafeInteger(issuedAt)
      || issuedAt > Number.MAX_SAFE_INTEGER - MAX_AGE * 1000) return null;
    if (!['r','x'].includes(kind) || !SIGNATURE.test(signature)) return null;
    let token;
    try { token = decodeURIComponent(raw); } catch { return null; }
    if ((kind === 'r' && !checkToken(token)) || (kind === 'x' && token !== '')) return null;
    const actual = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(mac(generation, kind, issuedAt, token), 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const entry = Object.freeze({ name, generation, kind, token, issuedAt, expiresAt: issuedAt + MAX_AGE * 1000 });
    validated.add(entry);
    return entry;
  }
  function parse(header = '') {
    // Do not stop discovering removable names at the first invalid version.
    // This pass never decodes values or elevates an oversized header to valid.
    const cleanupNames = [];
    if (typeof header === 'string' && header.length <= MAX_RECOVERY_HEADER && COOKIE_BYTES.test(header)) {
      const names = new Set();
      for (const part of header.split(';')) {
        if (names.size >= MAX_RECOVERY_NAMES) break;
        const text = part.trim(), sep = text.indexOf('=');
        if (sep < 1) continue;
        const name = text.slice(0, sep).trim();
        if (name.startsWith(PREFIX) && /^[A-Za-z0-9_]{1,60}$/u.test(name)) names.add(name);
      }
      cleanupNames.push(...names);
    }
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
      if (seen.has(name) || entries.length >= MAX_GENERATION_COOKIES) return invalid();
      seen.add(name);
      const parsed = decodeCookie(name, value);
      if (!parsed) return invalid();
      entries.push(parsed);
    }
    entries.sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    if (entries.length) return { invalid: false, legacy: null, entries, selected: entries.at(-1), cleanupNames };
    if (legacy.length) return invalid();
    return { invalid: false, legacy: null, entries: [], selected: null, cleanupNames };
  }
  const clear = name => name + '=; ' + cookieAttrs(env, 0);
  function observedNames(seen) {
    return [...new Set([...(seen?.entries || []).map(entry => entry.name), ...(seen?.cleanupNames || [])])];
  }
  function clearObserved(response, seen) {
    // If the shared allocator is unavailable, no newer tombstone can be issued.
    // Clear every observed cookie without claiming a completed remote logout.
    // A delayed old response can still reintroduce a slot: the client must lock.
    const cookies = [...observedNames(seen).map(clear), clear(LEGACY)];
    // No versioned names: keep the old single Set-Cookie shape for legacy clients.
    response.setHeader('Set-Cookie', cookies.length === 1 ? cookies[0] : cookies);
  }
  function cookieOf(sequence, kind, issuedAt, token) {
    const name = PREFIX + sequence.toString(36);
    const value = `${kind}.${mac(sequence, kind, issuedAt, token)}.${issuedAt}.${encodeURIComponent(token)}`;
    // Keep ordering evidence beyond the seven-day acceptance window, including
    // bounded worker skew. Browser receipt delay cannot extend signed expiry.
    return name + '=' + value + '; ' + cookieAttrs(env, ORDERING_AGE);
  }
  function write(response, seen, claim, { token = null, revoked = false } = {}) {
    const reservation = reservations.get(claim);
    const entry = reservation || (revoked && claim === seen?.selected && validated.has(claim) ? claim : null);
    if (!entry || (revoked ? token !== null : !checkToken(token)))
      throw Error('AUTH_GENERATION_INVALID');
    const { generation: sequence, issuedAt, expiresAt } = entry;
    const at = time();
    const elapsed = reservation ? monotonic() - reservation.started : null;
    if (reservation && (!Number.isFinite(reservation.started) || !Number.isFinite(elapsed) || elapsed < 0
      || at < issuedAt - MAX_CLOCK_SKEW_MS || at >= expiresAt
      || Math.abs((at - issuedAt) - elapsed) > MAX_CLOCK_SKEW_MS))
      throw Error('AUTH_GENERATION_EXPIRED');
    const issuedName = PREFIX + sequence.toString(36);
    // Refresh failure can invalidate its input generation, not other sessions.
    // Never clear and reset the same cookie name in one HTTP response.
    const out = observedNames(seen).filter(name => name !== issuedName).map(clear);
    // Keep routes/JSON compatible, but never issue an unsigned fallback token.
    out.push(clear(LEGACY));
    out.push(cookieOf(sequence, revoked ? 'x' : 'r', issuedAt, revoked ? '' : token));
    response.setHeader('Set-Cookie', out);
  }
  function refreshToken(seen) {
    if (seen.invalid) return null;
    const selected = seen.selected;
    if (!selected || selected.kind !== 'r') return null;
    // The greatest signed generation is authoritative even when expired.
    // Filtering expired entries first would revive an older credential.
    const at = time();
    return at >= selected.issuedAt - MAX_CLOCK_SKEW_MS && at < selected.expiresAt ? selected.token : null;
  }
  return Object.freeze({ parse, next: reserve, refreshToken, write, clearObserved });
}
