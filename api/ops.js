import config from '../aleph.config.json' with { type: 'json' };
import { compareDeploymentIdentity } from '../src/deployment-evidence.mjs';
import { PROBES, redactResponse, operationsSnapshot } from '../src/operations.mjs';
import { createResponseLifetime } from '../src/probe-response-lifetime.mjs';

// Read-only evidence adapter; it never returns a note body, token, email or person ID.
// Probes originate on the server and target the deployed app, not a client URL.
const REGEX_HOST = /^[a-z0-9][a-z0-9.-]*\.vercel\.app$/iu;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{2,63}$/u;
const isJson = value => /^application\/json(?:;|$)/iu.test(value || '');
const hasNoStore = value => /\bno-store\b/iu.test(value || '');
const RESTORE_ERRORS = new Set(['UNAUTHORIZED','RESTORE_NOT_AUTHORIZED','RESTORE_DISABLED','VERIFIED_BACKUP_NOT_CONFIGURED','UNVERIFIED_NOTE_BACKUP']);

// Bound actual received bytes, not the untrusted Content-Length header or
// JavaScript string length. Never buffer arbitrary upstream response bodies.
async function smallBody(response, lifetime, check, limit = 3500) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared)
    || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) {
    return null;
  }
  const reader = response.body?.getReader ? lifetime.reader(response.body.getReader()) : null;
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      check();
      const part = await reader.read();
      check();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) return null;
      bytes += part.value.byteLength;
      if (bytes > limit) return null;
      chunks.push(Buffer.from(part.value));
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    check();
    return body;
  } catch {
    return null;
  } finally {
    lifetime.close();
  }
}
function outcomeFor(id, response, body, manifestStep, expectedCommit) {
  const status = response.status;
  const json = isJson(response.headers.get('content-type'));
  const noStore = hasNoStore(response.headers.get('cache-control'));
  if (id === 'deployment_manifest') {
    if (status !== 200 || !json || !noStore || manifestStep !== config.step) return 'failed';
    // Self-consistency of THIS deployment only; latest main/production alias
    // freshness must be verified independently.
    return compareDeploymentIdentity(body, config, expectedCommit).outcome;
  }
  if (id === 'static_redaction')
    return status === 200 && json && noStore && Array.isArray(body?.notes)
      && body.notes.length === 0 && !Object.hasOwn(body,'sampleMarker')
      ? 'verified' : 'failed';
  if (id === 'anonymous_notes')
    return status === 401 && json && noStore && body?.error === 'UNAUTHORIZED'
      && (response.headers.get('www-authenticate') || '').trim() === 'Bearer'
      ? 'verified' : status === 503 ? 'inconclusive' : 'failed';
  if (id === 'anonymous_restore')
    return (status === 401 || status === 403) && json && noStore
      && RESTORE_ERRORS.has(body?.error)
      ? 'verified' : status === 503 && RESTORE_ERRORS.has(body?.error)
        ? 'inconclusive' : 'failed';
  if (id === 'authenticated_notes')
    return status === 200 && json && noStore
      && response.headers.get('x-resource-zone') === 'memo'
      ? 'verified' : status === 503 ? 'inconclusive' : 'failed';
  return 'inconclusive';
}
export function createOperationsHandler({ fetchImpl = globalThis.fetch, env = process.env,
  clock = () => new Date().toISOString(), probeTimeoutMs = 6500 } = {}) {
  // Trusted factory callers may shorten the fixed production bound for tests.
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 6500)
    throw new Error('INVALID_OPERATIONS_TIMEOUT');
  return async function handler(req, res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('CDN-Cache-Control','no-store');
    res.setHeader('Vercel-CDN-Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Vary','Authorization');
    if (req.method !== 'GET') {
      res.setHeader('Allow','GET');
      return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    }
    const host = typeof env.VERCEL_URL === 'string' && REGEX_HOST.test(env.VERCEL_URL)
      ? env.VERCEL_URL : new URL(config.publicAppUrl).host;
    const origin = 'https://' + host;
    const authorization = req.headers?.authorization;
    // Never include browser tokens in the observations. Only perform a read-only
    // authenticated probe when a Bearer credential is explicitly present.
    const usableAuth = typeof authorization === 'string'
      && /^Bearer [A-Za-z0-9._~+/-]{15,4096}$/u.test(authorization);
    const records = await Promise.all(PROBES.map(async probe => {
      if (probe.id === 'authenticated_notes' && !usableAuth)
        return {id:probe.id, httpStatus:null, requestId:null, errorCode:null,
          checkedAt:null, outcome:'unrun'};
      const inconclusive = () => ({id:probe.id,httpStatus:null,requestId:null,errorCode:null,
          checkedAt:null,outcome:'inconclusive'});
      const controller = new AbortController(), lifetime = createResponseLifetime(controller.signal);
      const deadline = performance.now() + probeTimeoutMs;
      const check = () => {
        if (controller.signal.aborted || performance.now() >= deadline) {
          controller.abort();throw new Error('OPERATIONS_PROBE_TIMEOUT');
        }
      };
      let timer;
      const stopped = new Promise(resolve => {
        timer = setTimeout(() => {controller.abort();resolve(inconclusive());},probeTimeoutMs);
      });
      const work = async () => {
        try {
          check();
          const headers = {Accept:'application/json'};
          if (probe.id === 'authenticated_notes') headers.Authorization = authorization;
          if (probe.id === 'authenticated_notes' && typeof req.headers?.['x-aleph-device-proof'] === 'string') headers['x-aleph-device-proof'] = req.headers['x-aleph-device-proof'];
          const response = lifetime.response(await fetchImpl(new URL(probe.path, origin), {
            method:'GET', redirect:'error', cache:'no-store', headers, signal:controller.signal,
          }));
          check();
          if (response.redirected || response.type === 'opaqueredirect') throw new Error('OPERATIONS_REDIRECT_BLOCKED');
          // Authenticated responses and unexpected successful private resources
          // are classified from headers only; never acquire a body reader.
          const safeToRead = probe.id !== 'authenticated_notes' && isJson(response.headers.get('content-type'))
            && (probe.id === 'deployment_manifest' || probe.id === 'static_redaction' || response.status >= 400);
          const body = safeToRead ? await smallBody(response,lifetime,check) : null;
          check();
          const scrub = redactResponse(response,
            typeof body?.error === 'string' && SAFE_ERROR.test(body.error) ? body.error : null);
          const result = {id:probe.id,...scrub,checkedAt:clock(),
            outcome:outcomeFor(probe.id,response,body,config.step,env.VERCEL_GIT_COMMIT_SHA)};
          check();return result;
        } catch {return inconclusive();}
        finally {lifetime.close();}
      };
      try {
        const result = await Promise.race([work(),stopped]);
        return controller.signal.aborted || performance.now() >= deadline ? inconclusive() : result;
      } finally {
        clearTimeout(timer);controller.abort();lifetime.close();
      }
    }));
    const snapshot = operationsSnapshot(records, {
      target:origin,commit:env.VERCEL_GIT_COMMIT_SHA,
    });
    return res.status(200).json(snapshot);
  };
}
export default createOperationsHandler();
