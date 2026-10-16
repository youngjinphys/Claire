import { createClient } from '@supabase/supabase-js';
import config from '../aleph.config.json' with { type: 'json' };
import { createAuthRiskGuard, suspiciousAuthInput, validLoginInput, verifiedEdgeAddress } from '../src/auth-xdr.mjs';

const COOKIE = 'aleph_refresh';
const MAX_BODY_BYTES = 8192;
const MAX_REFRESH_AGE = 7 * 24 * 60 * 60;

const noStore = (response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('CDN-Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
};

const bodyObject = (request) => {
  const incoming = request.body;
  if (typeof incoming === 'string') {
    if (Buffer.byteLength(incoming) > MAX_BODY_BYTES) return null;
    try {
      const result = JSON.parse(incoming);
      return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
    } catch { return null; }
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
  try {
    return Buffer.byteLength(JSON.stringify(incoming)) <= MAX_BODY_BYTES ? incoming : null;
  } catch { return null; }
};

// Duplicate or malformed refresh cookies do not silently override a real one.
const refreshTokenCookie = (header = '') => {
  if (typeof header !== 'string' || header.length > 12000) return null;
  const parts = header.split(';').map(item => item.trim()).filter(Boolean);
  const matches = parts.filter(item => item.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const encoded = matches[0].slice(COOKIE.length + 1);
  if (!encoded || encoded.length > 8192) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
};

const setRefreshCookie = (response, token, env) => {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly', 'SameSite=Strict', 'Path=/api/auth',
    `Max-Age=${MAX_REFRESH_AGE}`,
  ];
  if (env.VERCEL === '1' || env.NODE_ENV === 'production') parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
};
const clearRefreshCookie = (response, env) => {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/auth', 'Max-Age=0'];
  if (env.VERCEL === '1' || env.NODE_ENV === 'production') parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
};

const requestOriginAllowed = (request) => {
  const origin = request.headers?.origin;
  const fetchSite = request.headers?.['sec-fetch-site'];
  if (typeof origin === 'string' && origin !== new URL(config.publicAppUrl).origin) return false;
  if (origin != null && typeof origin !== 'string') return false;
  if (fetchSite != null && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
};

const publicSession = (session) => ({
  accessToken: session.access_token,
  expiresAt: session.expires_at ?? null,
  user: { email: session.user?.email ?? null },
});

export function createAuthHandler({
  env = process.env,
  supabaseFactory = createClient,
  riskGuardFactory = createAuthRiskGuard,
} = {}) {
  let client;
  let risk;
  const backend = () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return null;
    if (!client) client = supabaseFactory(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
  };
  const guard = () => {
    if (!risk) risk = riskGuardFactory({env, supabaseFactory});
    return risk;
  };
  return async function authHandler(request, response) {
    noStore(response);
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    }
    if (!requestOriginAllowed(request))
      return response.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' });
    const action = request.query?.action;
    if (typeof action !== 'string' || !['login','session','logout'].includes(action))
      return response.status(404).json({ error: 'AUTH_ROUTE_NOT_FOUND' });
    const supabase = backend();
    if (!supabase) return response.status(503).json({ error: 'AUTH_BACKEND_NOT_CONFIGURED' });

    if (action === 'login') {
      const contentType = request.headers?.['content-type'];
      if (contentType != null && (typeof contentType !== 'string'
        || !/^application\/json(?:\s*;|$)/iu.test(contentType)))
        return response.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE' });
      const declared = request.headers?.['content-length'];
      if (declared != null && (!/^\d+$/u.test(String(declared))
        || Number(declared) > MAX_BODY_BYTES))
        return response.status(413).json({ error: 'INVALID_CREDENTIAL_INPUT' });
      const body = bodyObject(request);
      const email = typeof body?.email === 'string' ? body.email.trim() : '';
      const ingressSignal = suspiciousAuthInput(email, verifiedEdgeAddress(request, env));
      if (!validLoginInput(body) || ingressSignal.action !== 'record')
        return response.status(400).json({ error: 'INVALID_CREDENTIAL_INPUT' });

      let admission;
      try { admission = await guard().claim(email, request); }
      catch { return response.status(503).json({ error: 'AUTH_RISK_GUARD_UNAVAILABLE' }); }
      if (!admission.allowed) {
        response.setHeader('Retry-After', String(
          Math.max(1, Math.min(600, Number(admission.retryAfterSeconds) || 600))));
        return response.status(429).json({ error: 'AUTH_RATE_LIMITED' });
      }

      let result;
      try { result = await supabase.auth.signInWithPassword({email, password: body.password}); }
      catch { return response.status(503).json({ error: 'AUTH_BACKEND_UNAVAILABLE' }); }
      const session = result?.data?.session;
      const success = !result?.error && session?.access_token && session?.refresh_token;
      try { await guard().record(admission, Boolean(success)); }
      catch { return response.status(503).json({ error: 'AUTH_RISK_GUARD_UNAVAILABLE' }); }
      // Never forward arbitrary provider error strings or verbose account existence hints.
      if (!success) return response.status(401).json({ error: 'LOGIN_FAILED' });
      setRefreshCookie(response, session.refresh_token, env);
      return response.status(200).json(publicSession(session));
    }

    if (action === 'session') {
      const refreshToken = refreshTokenCookie(request.headers?.cookie);
      if (!refreshToken) return response.status(401).json({ error: 'NO_SESSION' });
      try {
        const {data, error} = await supabase.auth.refreshSession({refresh_token:refreshToken});
        if (error || !data.session?.access_token || !data.session?.refresh_token)
          throw new Error('SESSION_EXPIRED');
        setRefreshCookie(response, data.session.refresh_token, env);
        return response.status(200).json(publicSession(data.session));
      } catch {
        clearRefreshCookie(response, env);
        return response.status(401).json({ error: 'SESSION_EXPIRED' });
      }
    }

    const refreshToken = refreshTokenCookie(request.headers?.cookie);
    clearRefreshCookie(response, env);
    if (refreshToken) {
      try {
        const {data} = await supabase.auth.refreshSession({refresh_token:refreshToken});
        if (data.session?.access_token && data.session?.refresh_token)
          await supabase.auth.signOut({scope:'local'});
      } catch { /* cookie revocation is still performed locally */ }
    }
    return response.status(200).json({ok:true});
  };
}

export default createAuthHandler();
