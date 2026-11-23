import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  OPS_TRACE_BINDING, OPS_TRACE_HEADER, OPS_TRACE_STATE,
  isKnownCancelledInterception, isOperationsRequestTrace, operationsRequestTraceSource,
} from '../scripts/browser-request-trace.mjs';

const origin = 'http://127.0.0.1:48215';
const documentId = '12345678-1234-4567-89ab-123456789abc';
const requestId = documentId + ':1';
const cancelledTrace = () => ({
  schema: 'claire.browser-request-trace.v1', id: requestId,
  url: origin + '/api/ops', method: 'GET',
  headersReceived: false, abortedBeforeHeaders: true, errorName: 'AbortError',
});
const failedInterception = () => ({
  method: 'Fetch.continueRequest', cdpCode: -32602,
  error: 'CDP Fetch.continueRequest: Invalid InterceptionId.',
  url: origin + '/api/ops', qaRequestId: requestId,
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observedSignal({ aborted = false } = {}) {
  const listeners = new Set(), added = [], removed = [];
  return {
    aborted, added, removed,
    addEventListener(type, listener, options) {
      assert.equal(type, 'abort');
      assert.equal(options.once, true);
      added.push(listener);
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      removed.push(listener);
      listeners.delete(listener);
    },
    abort() {
      this.aborted = true;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() { return listeners.size; },
  };
}

function harness(nativeFetch, { binding } = {}) {
  const traces = [];
  const context = {
    URL, Headers, fetch: nativeFetch,
    location: { href: origin + '/operations.html' },
    crypto: { randomUUID: () => documentId },
    [OPS_TRACE_BINDING]: binding ?? (value => traces.push(JSON.parse(value))),
  };
  runInNewContext(operationsRequestTraceSource(origin), context);
  return { fetch: context.fetch, state: context[OPS_TRACE_STATE], traces };
}

test('interception cancellation requires the exact CDP failure and a correlated local request trace', () => {
  assert.equal(isKnownCancelledInterception(failedInterception(), cancelledTrace(), origin), true);
  const variants = {
    method: ['Fetch.failRequest', 'Fetch.continueResponse', 'fetch.continueRequest', '', 0],
    cdpCode: [-32601, -32000, 32602, '-32602', 0],
    error: ['Invalid InterceptionId.', 'CDP Fetch.continueRequest: Invalid InterceptionId',
      'CDP Fetch.continueRequest: Invalid parameters', '', new String('CDP Fetch.continueRequest: Invalid InterceptionId.')],
    url: [origin + '/api/ops?refresh=1', origin + '/api/ops#fragment', origin + '/api/other',
      'https://external.invalid/api/ops', '/api/ops', ''],
    qaRequestId: [documentId + ':2', documentId.toUpperCase() + ':1', '', {}, 1],
  };
  for (const [field, values] of Object.entries(variants)) {
    for (const value of [undefined, null, ...values]) {
      assert.equal(isKnownCancelledInterception({ ...failedInterception(), [field]: value }, cancelledTrace(), origin), false, field);
    }
    const missing = failedInterception();
    delete missing[field];
    assert.equal(isKnownCancelledInterception(missing, cancelledTrace(), origin), false, field);
  }
});

test('each trace field must retain its schema, request identity, local scope and cancellation evidence', () => {
  const variants = {
    schema: ['', 'claire.browser-request-trace.v2', {}],
    id: ['', documentId + ':0', documentId + ':1000000', documentId + ':01',
      documentId.replace('-4567-', '-3567-') + ':1', 'request-1', 1],
    url: [origin + '/api/other', origin + '/api/ops?x=1', 'https://external.invalid/api/ops', ''],
    method: ['get', 'POST', '', true],
    headersReceived: [true, 'false', 0],
    abortedBeforeHeaders: [false, 'true', 1],
    errorName: [null, 'OtherError', 'TimeoutError', '', {}],
  };
  for (const [field, values] of Object.entries(variants)) {
    for (const value of [undefined, null, ...values]) {
      assert.equal(isKnownCancelledInterception(failedInterception(), { ...cancelledTrace(), [field]: value }, origin), false, field);
    }
    const missing = cancelledTrace();
    delete missing[field];
    assert.equal(isKnownCancelledInterception(failedInterception(), missing, origin), false, field);
  }
  for (const trace of [undefined, null, [], false, 'trace']) {
    assert.equal(isKnownCancelledInterception(failedInterception(), trace, origin), false);
  }
  const impossible = { ...cancelledTrace(), headersReceived: true };
  assert.equal(isOperationsRequestTrace(impossible, origin), false);
});

test('missing network IDs and browser cancellation flags alone never excuse an interception error', () => {
  for (const networkId of [undefined, null, '', 'network-1']) {
    const failure = { ...failedInterception(), networkId, canceled: true };
    assert.equal(isKnownCancelledInterception(failure, undefined, origin), false);
    assert.equal(isKnownCancelledInterception(failure, { networkId, canceled: true }, origin), false);
    assert.equal(isKnownCancelledInterception({ ...failure, qaRequestId: undefined }, cancelledTrace(), origin), false);
  }
  // The independent fetch trace supplies correlation even when CDP omitted
  // networkId; the omission itself is never the reason an error is accepted.
  assert.equal(isKnownCancelledInterception(failedInterception(), cancelledTrace(), origin), true);
});

test('trace installation and cancellation classification are confined to the literal local fixture origin', () => {
  for (const otherOrigin of ['https://external.invalid', 'http://external.invalid',
    'http://localhost:48215', 'https://127.0.0.1:48215', origin + '/', origin + '/api/ops',
    'http://127.0.0.1:48215@external.invalid', 'invalid']) {
    assert.throws(() => operationsRequestTraceSource(otherOrigin), /INVALID_FIXTURE_ORIGIN/u);
    const trace = { ...cancelledTrace(), url: otherOrigin + '/api/ops' };
    const failure = { ...failedInterception(), url: otherOrigin + '/api/ops' };
    assert.equal(isOperationsRequestTrace(trace, otherOrigin), false);
    assert.equal(isKnownCancelledInterception(failure, trace, otherOrigin), false);
    assert.equal(isKnownCancelledInterception(failure, trace, origin), false);
  }
});

test('serialized observer preserves native promise, receiver, signal and options without mutating caller headers', async () => {
  const pending = deferred(), calls = [], signal = observedSignal();
  const receiver = { fixture: 'receiver' };
  const headers = new Headers({ accept: 'application/json', [OPS_TRACE_HEADER]: 'caller-value' });
  const init = Object.freeze({ method: 'GET', headers, signal, cache: 'no-store',
    credentials: 'same-origin', redirect: 'error', customFixtureOption: 'retained' });
  const observer = harness(function (input, options) {
    calls.push({ receiver: this, input, options });
    return pending.promise;
  });
  const returned = observer.fetch.call(receiver, '/api/ops', init);
  assert.equal(returned, pending.promise);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].input, '/api/ops');
  assert.notEqual(calls[0].options, init);
  assert.equal(calls[0].options.signal, signal);
  for (const field of ['method', 'cache', 'credentials', 'redirect', 'customFixtureOption']) {
    assert.equal(calls[0].options[field], init[field]);
  }
  assert.notEqual(calls[0].options.headers, headers);
  assert.equal(calls[0].options.headers.get('accept'), 'application/json');
  assert.equal(calls[0].options.headers.get(OPS_TRACE_HEADER), requestId);
  assert.equal(headers.get(OPS_TRACE_HEADER), 'caller-value');
  assert.equal(signal.listenerCount, 1);
  assert.equal(observer.state.started, 1);
  assert.equal(observer.state.active, 1);
  const response = { status: 200, body: { cancel() { throw Error('observer must not consume response'); } } };
  pending.resolve(response);
  assert.equal(await returned, response);
  assert.equal(observer.state.active, 0);
  assert.equal(observer.state.failures, 0);
  assert.equal(signal.listenerCount, 0);
  assert.equal(signal.removed[0], signal.added[0]);
  assert.deepEqual(observer.traces, [{ ...cancelledTrace(), headersReceived: true, abortedBeforeHeaders: false, errorName: null }]);
  signal.abort();
  assert.equal(observer.traces.length, 1);
  assert.equal(isKnownCancelledInterception(failedInterception(), observer.traces[0], origin), false);
});

test('cancellation before native headers plus native AbortError produces an independently correlatable trace', async () => {
  for (const preAborted of [false, true]) {
    const pending = deferred(), signal = observedSignal({ aborted: preAborted });
    const observer = harness(() => pending.promise);
    const returned = observer.fetch('/api/ops', { signal });
    const error = Object.assign(new Error('fixture cancellation'), { name: 'AbortError' });
    const rejected = assert.rejects(returned, actual => actual === error);
    if (!preAborted) signal.abort();
    pending.reject(error);
    await rejected;
    assert.equal(returned, pending.promise);
    assert.deepEqual(observer.traces, [cancelledTrace()]);
    assert.equal(isOperationsRequestTrace(observer.traces[0], origin), true);
    assert.equal(isKnownCancelledInterception(failedInterception(), observer.traces[0], origin), true);
    assert.equal(signal.listenerCount, 0);
    assert.equal(signal.removed[0], signal.added[0]);
    assert.equal(observer.state.active, 0);
  }
});

test('native AbortError without observed cancellation and other rejection types remain unclassified', async () => {
  for (const [errorName, aborted] of [['AbortError', false], ['TypeError', false], ['TypeError', true], ['TimeoutError', true]]) {
    const pending = deferred(), signal = observedSignal();
    const observer = harness(() => pending.promise);
    const returned = observer.fetch('/api/ops', { signal });
    const error = Object.assign(new Error('fixture rejection'), { name: errorName });
    const rejected = assert.rejects(returned, actual => actual === error);
    if (aborted) signal.abort();
    pending.reject(error);
    await rejected;
    assert.equal(observer.traces.length, 1);
    assert.equal(observer.traces[0].abortedBeforeHeaders, aborted);
    assert.equal(observer.traces[0].errorName, errorName === 'AbortError' ? 'AbortError' : 'OtherError');
    assert.equal(isKnownCancelledInterception(failedInterception(), observer.traces[0], origin), false);
    assert.equal(signal.listenerCount, 0);
    assert.equal(observer.state.active, 0);
  }
});

test('a synchronous native throw preserves the same exception and cleans up the observer', () => {
  const signal = observedSignal();
  const error = new TypeError('fixture synchronous native error');
  const observer = harness(() => { throw error; });
  assert.throws(() => observer.fetch('/api/ops', { signal }), actual => actual === error);
  assert.equal(observer.state.started, 1);
  assert.equal(observer.state.active, 0);
  assert.equal(observer.state.failures, 0);
  assert.equal(signal.listenerCount, 0);
  assert.equal(signal.removed[0], signal.added[0]);
  assert.deepEqual(observer.traces, [{ ...cancelledTrace(), abortedBeforeHeaders: false, errorName: 'OtherError' }]);
  assert.equal(isKnownCancelledInterception(failedInterception(), observer.traces[0], origin), false);
});

test('unrelated paths, external URLs, non-GET methods and non-string requests pass through untouched', async () => {
  const receiver = { fixture: 'passthrough' };
  for (const [input, method] of [
    ['/api/other', undefined], ['/api/ops?x=1', undefined], ['/api/ops#fragment', undefined],
    ['https://external.invalid/api/ops', undefined], ['http://127.0.0.1:48216/api/ops', undefined],
    ['/api/ops', 'POST'], ['/api/ops', 'HEAD'], ['/api/ops', 'get-extra'],
    [new URL(origin + '/api/ops'), undefined], [{ url: origin + '/api/ops' }, undefined],
  ]) {
    const native = Promise.resolve({ fixture: 'native-result' }), calls = [], signal = observedSignal();
    const headers = Object.freeze({ accept: 'application/json' });
    const init = Object.freeze({ ...(method === undefined ? {} : { method }), signal, headers });
    const observer = harness(function (...args) { calls.push({ receiver: this, args }); return native; });
    assert.equal(observer.fetch.call(receiver, input, init), native);
    assert.equal(calls[0].receiver, receiver);
    assert.equal(calls[0].args[0], input);
    assert.equal(calls[0].args[1], init);
    await native;
    assert.equal(observer.state.started, 0);
    assert.equal(observer.state.active, 0);
    assert.equal(observer.state.failures, 0);
    assert.equal(signal.added.length, 0);
    assert.deepEqual(observer.traces, []);
  }
});

test('default and lowercase GET trace only the exact fixture endpoint and use distinct per-request IDs', async () => {
  const promises = [], headers = [];
  const observer = harness((_input, init) => {
    headers.push(init.headers.get(OPS_TRACE_HEADER));
    const native = Promise.resolve({ fixture: 'response' });
    promises.push(native);
    return native;
  });
  assert.equal(observer.fetch('/api/ops'), promises[0]);
  assert.equal(observer.fetch(origin + '/api/ops', { method: 'get' }), promises[1]);
  await Promise.all(promises);
  assert.deepEqual(headers, [documentId + ':1', documentId + ':2']);
  assert.equal(observer.state.started, 2);
  assert.equal(observer.state.active, 0);
  assert.equal(observer.traces.length, 2);
  for (const trace of observer.traces) assert.equal(isOperationsRequestTrace(trace, origin), true);
});

test('a failing trace binding cannot change native success, rejection or synchronous errors', async () => {
  for (const outcome of ['resolve', 'reject', 'throw']) {
    const pending = deferred(), signal = observedSignal();
    const error = new TypeError('fixture native failure');
    const observer = harness(() => {
      if (outcome === 'throw') throw error;
      return pending.promise;
    }, { binding: () => { throw new Error('fixture binding unavailable'); } });
    if (outcome === 'throw') {
      assert.throws(() => observer.fetch('/api/ops', { signal }), actual => actual === error);
    } else {
      const returned = observer.fetch('/api/ops', { signal });
      assert.equal(returned, pending.promise);
      if (outcome === 'resolve') {
        const response = { fixture: 'native success' };
        pending.resolve(response);
        assert.equal(await returned, response);
      } else {
        const rejected = assert.rejects(returned, actual => actual === error);
        pending.reject(error);
        await rejected;
      }
    }
    assert.equal(observer.state.started, 1);
    assert.equal(observer.state.active, 0);
    assert.equal(observer.state.failures, 1);
    assert.equal(signal.listenerCount, 0);
    assert.deepEqual(observer.traces, []);
  }
});
