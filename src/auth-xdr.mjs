import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { decide as bruteForceDecision } from '../xdr/brute-force/decide.mjs';
import { decide as webInjectionDecision } from '../xdr/web-injection/decide.mjs';

// Only an edge-verified source address is used; browser-controlled forwarded-for
// headers, user agents and account names never become trusted XDR signals.
export function verifiedEdgeAddress(request, env = process.env) {
  if (env.VERCEL !== '1') return null;
  const header = request.headers?.['x-vercel-forwarded-for'];
  const value = Array.isArray(header) ? null : header;
  return typeof value === 'string' && value === value.trim() && isIP(value) ? value : null;
}

export function validLoginInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'email,password') return false;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  return email.length > 3 && email.length <= 254
    && /^[^\s@<>"'\\\x00-\x1f]{1,64}@[^\s@<>"'\\\x00-\x1f]{1,189}$/u.test(email)
    && typeof body.password === 'string'
    && body.password.length > 0 && body.password.length <= 4096;
}

export function suspiciousAuthInput(email, source, now = new Date()) {
  // Credentials/passwords must never be inspected, logged or sent as XDR data.
  const malicious = /<script\b|<svg\b|\bunion\s+(?:all\s+)?select\b|(?:\.\.\/){2}|%0[ad]|\b(?:drop|alter)\s+table\b/iu.test(email);
  if (!malicious) return { action: 'record', confidence: 0.1, reason: 'no_injection_indicator' };
  // The existing Wazuh-format student XDR judge entry is reused unchanged.
  return webInjectionDecision({
    timestamp: now.toISOString(),
    rule: { level: 6, mitre: ['T1190'], description: 'suspicious web input' },
    data: { srcip: source || '', url: '/api/auth/login?value=' + email.slice(0, 254), count: '1' },
  });
}

export function classifyVerifiedLoginFailures({ count, source, key, now = new Date() }) {
  if (!Number.isSafeInteger(count) || count < 2 || !source || !key)
    return { action: 'record', confidence: 0.1, reason: 'insufficient_verified_failures' };
  const alert = {
    timestamp: now.toISOString(),
    rule: {level: count >= 20 ? 12 : 5, mitre: ['T1110'],
      description: '같은 계정에 10분 동안 로그인 실패 ' + count + '건이 쌓였습니다.'},
    data: {srcip: source, srcuser: 'account_' + key.slice(2, 14), count: String(count)},
  };
  return bruteForceDecision(alert);
}

export function createAuthRiskGuard({ env = process.env, supabaseFactory = createClient } = {}) {
  let admin = null;
  const getAdmin = () => {
    if (!admin) {
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)
        throw new Error('AUTH_RISK_BACKEND_NOT_CONFIGURED');
      admin = supabaseFactory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return admin;
  };
  const keyed = (scope, value) => scope + ':' + createHmac('sha256', env.SUPABASE_SECRET_KEY)
    .update('aleph-stage12-auth/' + scope + '/' + value).digest('hex');
  const context = (email, request) => {
    if (typeof env.SUPABASE_SECRET_KEY !== 'string' || env.SUPABASE_SECRET_KEY.length < 24)
      throw new Error('AUTH_RISK_BACKEND_NOT_CONFIGURED');
    const source = verifiedEdgeAddress(request, env);
    return {
      source,
      accountKey: keyed('a', email.trim().toLowerCase()),
      sourceKey: source ? keyed('s', source) : null,
    };
  };
  const rpc = async (name, args) => {
    const { data, error } = await getAdmin().rpc(name, args);
    if (error || !data || typeof data !== 'object')
      throw new Error('AUTH_RISK_BACKEND_UNAVAILABLE');
    return data;
  };
  return {
    async claim(email, request) {
      const ctx = context(email, request);
      const reply = await rpc('s12_auth_claim', {
        p_account_key: ctx.accountKey, p_source_key: ctx.sourceKey,
      });
      if (typeof reply.allowed !== 'boolean' || !Number.isInteger(reply.retryAfterSeconds))
        throw new Error('AUTH_RISK_BACKEND_INVALID');
      return {...ctx, ...reply};
    },
    async record(ctx, success) {
      const result = await rpc('s12_auth_record_result', {
        p_account_key: ctx.accountKey, p_source_key: ctx.sourceKey,
        p_success: Boolean(success),
      });
      return classifyVerifiedLoginFailures({
        count: result.accountFailures, source: ctx.source, key: ctx.accountKey,
      });
    },
  };
}
