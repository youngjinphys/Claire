import {createResponseLifetime} from '../../public/http-response.mjs';
// Read-only OSV lookup. Public package approval is supplied by the caller, never inferred online.
export const OSV_QUERY_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const npmName = value => typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
const version = value => {
  if (typeof value !== 'string' || value.length > 100 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false;
  const prerelease = value.split('+')[0].split('-').slice(1).join('-');
  return !prerelease || prerelease.split('.').every(part => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'));
};
function installedName(path) {
  if (typeof path !== 'string' || !path.includes('node_modules/') || /\\/.test(path) || path.split('/').some(part => ['.', '..', ''].includes(part))) return null;
  const candidate = path.split('node_modules/').at(-1);
  return npmName(candidate) ? candidate : null;
}
function registryTarballMatches(resolved, name, installedVersion) {
  if (typeof resolved !== 'string') return false;
  let url;
  try { url = new URL(resolved); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) return false;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return false; }
  return path === `/${name}/-/${name.split('/').at(-1)}-${installedVersion}.tgz`;
}

export function buildPackageQueries(lock, { approvedPublicPackages = [] } = {}) {
  const excluded = { unapproved: 0, unsupported: 0, invalid: 0 };
  const queries = [];
  if (!plain(lock) || ![2, 3].includes(lock.lockfileVersion) || !plain(lock.packages)) return { queries, excluded: { ...excluded, unsupported: 1 }, lockfileVersion: null };
  const approved = new Set(Array.isArray(approvedPublicPackages) ? approvedPublicPackages.filter(npmName) : []);
  const seen = new Set();
  for (const [path, row] of Object.entries(lock.packages)) {
    if (path === '') continue; // The root application is not an installed dependency.
    const installed = installedName(path);
    if (!installed || !plain(row) || row.link === true || row.private === true) { excluded.unsupported++; continue; }
    // For npm aliases, package-lock records the actual package in row.name.
    const name = row.name === undefined ? installed : row.name;
    if (!npmName(name)) { excluded.invalid++; continue; }
    if (!approved.has(name)) { excluded.unapproved++; continue; }
    if (!version(row.version) || !registryTarballMatches(row.resolved, name, row.version)) { excluded.invalid++; continue; }
    const key = `${name}\n${row.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ package: { name, ecosystem: 'npm' }, version: row.version });
  }
  return { queries, excluded, lockfileVersion: lock.lockfileVersion };
}

const validQuery = query => exactFields(query, ['package', 'version']) && exactFields(query.package, ['name', 'ecosystem']) && npmName(query.package.name) && query.package.ecosystem === 'npm' && version(query.version);
const safeCursor = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value);
const validFinding = finding => plain(finding) && typeof finding.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(finding.id)
  && typeof finding.modified === 'string' && finding.modified.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(finding.modified) && Number.isFinite(Date.parse(finding.modified));
const limitsValid = (timeoutMs, maxPages, maxResponseBytes) => Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000
  && Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 100 && Number.isInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 10485760;

function endpointFor(endpoint, allowLoopbackHttp) {
  if (endpoint === OSV_QUERY_BATCH_URL) return endpoint;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (!allowLoopbackHttp || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/querybatch') return null;
  return url.href;
}
async function readBoundedJson(response, maxBytes, lifetime, check) {
  const chunks = [];
  let bytes = 0;
  if (!response.body?.getReader) throw new Error('OSV_INVALID_RESPONSE');
  const reader = lifetime.reader(response.body.getReader());
  for (;;) {
    check();const part = await reader.read();check();if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maxBytes) throw new Error('OSV_RESPONSE_TOO_LARGE');
    chunks.push(part.value);
  }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(Buffer.concat(chunks)));
  check();return result;
}

export function createOsvClient({ endpoint = OSV_QUERY_BATCH_URL, allowLoopbackHttp = false, fetchImpl = globalThis.fetch,
  monotonic = () => performance.now() } = {}) {
  const url = endpointFor(endpoint, allowLoopbackHttp);
  return Object.freeze({
    async lookupPackages(queries, { signal: externalSignal, timeoutMs = 10000, maxPages = 10, maxResponseBytes = 1048576 } = {}) {
      if (!Array.isArray(queries)) return [];
      const checkedAt = new Date().toISOString();
      // Never echo extra fields, local paths, URLs, cursors or arbitrary errors.
      const states = queries.map(query => ({ query: validQuery(query) ? structuredClone(query) : null,
        result: { name: npmName(query?.package?.name) ? query.package.name : null, version: version(query?.version) ? query.version : null,
          status:'unverifiable', source:OSV_QUERY_BATCH_URL, checkedAt }, findings:new Map(), cursor:null, seenCursors:new Set(), finished:false }));
      const results = () => states.map(state => ({ ...state.result, vulnerabilities:[...state.findings.values()].map(row => ({ ...row })) }));
      if (!url || typeof fetchImpl !== 'function' || typeof monotonic !== 'function' || externalSignal?.aborted || !limitsValid(timeoutMs,maxPages,maxResponseBytes)) return results();
      const started = monotonic();
      if (!Number.isFinite(started)) return results();
      const controller = new AbortController(), deadline = started + timeoutMs;
      let timer, cancel, deadlineMissed = false;
      const check = () => {
        const current = monotonic();
        if (!Number.isFinite(current) || current < started || current >= deadline) { deadlineMissed = true; throw Error('OSV_TIMEOUT'); }
        if (controller.signal.aborted) throw Error('OSV_CANCELLED');
      };
      const stopped = new Promise((_, reject) => {
        cancel = () => { controller.abort(); reject(Error('OSV_CANCELLED')); };
        timer = setTimeout(() => { deadlineMissed = true; controller.abort(); reject(Error('OSV_TIMEOUT')); }, timeoutMs);
        externalSignal?.addEventListener('abort',cancel,{once:true});
      });
      const work = async () => {
        for (let page = 0; page < maxPages; page++) {
          check();
          const pending = states.filter(state => state.query && !state.finished);
          if (!pending.length) break;
          const lifetime = createResponseLifetime(controller.signal);
          try {
            const response = lifetime.response(await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},
              body:JSON.stringify({queries:pending.map(state => ({...state.query,...(state.cursor?{page_token:state.cursor}:{})}))}),redirect:'manual',signal:controller.signal}));
            check();
            if (!response?.ok || response.redirected || !Number.isInteger(response.status) || response.status >= 300 || response.status < 200) break;
            const declared=response.headers.get('content-length');
            if (declared!==null && (!/^\d+$/.test(declared) || Number(declared)>maxResponseBytes)) break;
            const payload = await readBoundedJson(response,maxResponseBytes,lifetime,check);
            if (!plain(payload) || !Array.isArray(payload.results) || payload.results.length !== pending.length) break;
            for (let i = 0; i < pending.length; i++) {
              check();const state = pending[i], row = payload.results[i];
              if (!plain(row) || Object.keys(row).some(key => !['vulns','next_page_token'].includes(key))
                || row.vulns !== undefined && !Array.isArray(row.vulns)
                || row.next_page_token !== undefined && row.next_page_token !== '' && !safeCursor(row.next_page_token)) { state.finished = true; continue; }
              let valid = true;
              for (const finding of row.vulns ?? []) { check();if (!validFinding(finding)) { valid = false;break; } }
              if (!valid) { state.finished = true;continue; }
              for (const finding of row.vulns ?? []) {
                check();const existing = state.findings.get(finding.id);
                if (!existing || Date.parse(finding.modified) > Date.parse(existing.modified)) state.findings.set(finding.id,{id:finding.id,modified:finding.modified});
              }
              check();const cursor = row.next_page_token;
              if (cursor) {
                if (state.seenCursors.has(cursor)) { state.finished = true;continue; }
                state.seenCursors.add(cursor);state.cursor = cursor;
              } else {
                state.finished = true;
                state.result.status = state.findings.size ? 'known_vulnerabilities' : 'none_found';
              }
            }
          } finally { lifetime.close(); }
        }
        check();
      };
      try { await Promise.race([work(),stopped]);check(); }
      catch { /* An incomplete comparison never becomes a clean bill of health. */ }
      finally { clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);controller.abort(); }
      const output = results();
      // A large result projection can also defer timer delivery. Re-check the
      // monotonic deadline before publishing any complete result.
      const completedAt = monotonic();
      if (deadlineMissed || externalSignal?.aborted || !Number.isFinite(completedAt) || completedAt < started || completedAt >= deadline)
        for (const row of output) row.status = 'unverifiable';
      return output;
    },
  });
}

export async function lookupPackages(queries, { endpoint = OSV_QUERY_BATCH_URL, allowLoopbackHttp = false, fetchImpl = globalThis.fetch, ...options } = {}) {
  return createOsvClient({ endpoint, allowLoopbackHttp, fetchImpl }).lookupPackages(queries, options);
}
