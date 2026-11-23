export const OPS_TRACE_HEADER = 'x-claire-qa-request-id';
export const OPS_TRACE_BINDING = '__claireOpsRequestTrace';
export const OPS_TRACE_STATE = '__claireOpsRequestTraceState';
const SCHEMA = 'claire.browser-request-trace.v1';
const TRACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:[1-9][0-9]{0,5}$/u;
const isFixtureOrigin = origin => {
  try { const url = new URL(origin); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin; }
  catch { return false; }
};

// This function is serialized into a synthetic browser fixture, never shipped
// with the application. Observe the native promise without replacing it.
function installOperationsRequestTrace({ origin, headerName, bindingName, stateName, schema }) {
  const nativeFetch = globalThis.fetch;
  const documentId = globalThis.crypto.randomUUID();
  const state = { started: 0, active: 0, failures: 0 };
  Object.defineProperty(globalThis, stateName, { value: state, configurable: true });
  globalThis.fetch = function (input, init) {
    const options = init ?? {};
    let url;
    try { if (typeof input === 'string') url = new URL(input, globalThis.location.href).href; } catch {}
    if (url !== origin + '/api/ops'
        || (options.method !== undefined && options.method !== 'GET' && options.method !== 'get')) {
      return Reflect.apply(nativeFetch, this, [input, init]);
    }
    const headers = new Headers(options.headers);
    const id = documentId + ':' + (++state.started);
    headers.set(headerName, id);
    const signal = options.signal;
    let headersReceived = false, abortedBeforeHeaders = signal?.aborted === true;
    const onAbort = () => { if (!headersReceived) abortedBeforeHeaders = true; };
    const listens = typeof signal?.addEventListener === 'function';
    if (listens) signal.addEventListener('abort', onAbort, { once: true });
    state.active++;
    const finish = errorName => {
      if (listens) signal.removeEventListener('abort', onAbort);
      state.active--;
      try {
        globalThis[bindingName](JSON.stringify({
          schema, id, url, method: 'GET', headersReceived, abortedBeforeHeaders, errorName,
        }));
      } catch { state.failures++; }
    };
    let request;
    try { request = Reflect.apply(nativeFetch, this, [input, { ...options, headers }]); }
    catch (error) { finish(error?.name === 'AbortError' ? 'AbortError' : 'OtherError'); throw error; }
    // Side observers clean themselves up at native fetch settlement. A later
    // body-disposal abort cannot be mistaken for cancellation before headers.
    void request.then(() => { headersReceived = true; finish(null); }, error => {
      finish(error?.name === 'AbortError' ? 'AbortError' : 'OtherError');
    });
    return request;
  };
}

export function operationsRequestTraceSource(origin) {
  if (!isFixtureOrigin(origin)) throw Error('INVALID_FIXTURE_ORIGIN');
  return '(' + installOperationsRequestTrace.toString() + ')(' + JSON.stringify({
    origin, headerName: OPS_TRACE_HEADER, bindingName: OPS_TRACE_BINDING,
    stateName: OPS_TRACE_STATE, schema: SCHEMA,
  }) + ');';
}

export function isOperationsRequestTrace(trace, origin) {
  return isFixtureOrigin(origin) && trace !== null && typeof trace === 'object' && !Array.isArray(trace)
    && trace.schema === SCHEMA && typeof trace.id === 'string' && TRACE_ID.test(trace.id)
    && trace.url === origin + '/api/ops' && trace.method === 'GET'
    && typeof trace.headersReceived === 'boolean' && typeof trace.abortedBeforeHeaders === 'boolean'
    && [null, 'AbortError', 'OtherError'].includes(trace.errorName)
    && (trace.headersReceived ? trace.errorName === null : trace.errorName !== null);
}

export function isKnownCancelledInterception(failure, trace, origin) {
  return isOperationsRequestTrace(trace, origin)
    && failure?.method === 'Fetch.continueRequest' && failure.cdpCode === -32602
    && failure.error === 'CDP Fetch.continueRequest: Invalid InterceptionId.'
    && failure.url === origin + '/api/ops' && failure.qaRequestId === trace.id
    && trace.headersReceived === false && trace.abortedBeforeHeaders === true
    && trace.errorName === 'AbortError';
}
