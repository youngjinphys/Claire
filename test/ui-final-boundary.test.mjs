import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createResponseLifetime} from '../on-client/public/http-response.mjs';
import {operationsSnapshot} from '../src/operations.mjs';

const [appSource, deviceSource, pageSource, operationsSource] = await Promise.all([
  '../on-client/public/app.js', '../public/device.mjs', '../public/index.html', '../public/operations.mjs',
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));

function section(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `source section exists: ${from}`);
  return source.slice(start, end);
}

const appHttp = section(appSource, 'function normalizeMeta(', '// AI requests remain bounded');
const appCommon = section(appSource, 'function normalizeMeta(', '// 모든 요청은');
const aiRequest = section(appSource, 'async function aiRequest(', '// ---------- 공통 상태');
const vulnerabilities = section(appSource, 'function cancelVulnerabilities(', 'function renderApps(');
const deviceRequest = section(deviceSource, '  async function deviceRequest(', '  async function status(');
const readHttpJson = section(pageSource, '    const readHttpJson =', '    const discardResponse =');
const operationsRefresh = section(operationsSource, '  async function refresh(){', '  const updateChart=');
const validateSnapshot = Function('outcomes', 'optionalText',
  section(operationsSource, 'function validateSnapshot(', 'function dataCell(') + '; return validateSnapshot;')(
  ['verified', 'failed', 'inconclusive', 'unrun'], value => value == null || typeof value === 'string');

const build = (source, values) => Function(...Object.keys(values), source)(...Object.values(values));

function clock() {
  let now = 0;
  const timers = new Map();
  return {
    performance: {now: () => now},
    setTimeout(fn, delay) { const handle = {}; timers.set(handle, {fn, delay}); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
    expire() { now = 11; },
    timers,
  };
}

// The first queued microtask runs before the EOF continuation; the second
// runs after that continuation resolves the inner read and before the outer
// Promise.race continuation can publish it. No timer or wall-clock delay fires.
const atFinalBoundary = callback => queueMicrotask(() => queueMicrotask(callback));

function streamResponse(data, status, after, afterHeaders = false) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const stats = {reads: 0, acquired: 0, cancelled: 0, released: 0};
  const reader = {
    read() {
      if (stats.reads++ === 0) return Promise.resolve({done: false, value: bytes});
      atFinalBoundary(after);
      return Promise.resolve({done: true});
    },
    cancel() { stats.cancelled++; return Promise.resolve(); },
    releaseLock() { stats.released++; },
  };
  const response = {
    status,
    get ok() {
      if (afterHeaders) atFinalBoundary(after);
      return status >= 200 && status < 300;
    },
    headers: new Headers({'content-type': 'application/json'}),
    body: {
      getReader() { stats.acquired++; return reader; },
      cancel() { stats.cancelled++; return Promise.resolve(); },
    },
  };
  return {response, stats};
}

function transportFixture(kind, {boundary = null, denied = false, duringValidation = false} = {}) {
  const time = clock(), caller = new AbortController();
  let signal, cancel, parsed = false, boundaryRan = false, api;
  const data = kind === 'operations' ? operationsSnapshot([])
    : kind === 'app' ? denied
      ? {ok: false, error: {code: 'FIXTURE_DENIED', message: 'Fixture denial'}, meta: {mode: 'connected'}}
      : {ok: true, data: {fixture: true}, meta: {mode: 'connected'}}
    : {fixture: true};
  const afterHeaders = kind === 'operations' && denied;
  const after = () => {
    if (!boundary) return;
    assert.equal(parsed, !afterHeaders, 'the boundary follows inner parsing, or the immediate HTTP rejection');
    boundaryRan = true;
    if (boundary === 'deadline') time.expire();
    else cancel();
  };
  const {response, stats} = streamResponse(data, denied ? 403 : 200, after, afterHeaders);
  const fetch = (_url, options = {}) => { signal = options.signal; return Promise.resolve(response); };
  const common = {
    performance: time.performance, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    JSON: {stringify: JSON.stringify, parse(text) { parsed = true; return JSON.parse(text); }},
  };
  if (kind === 'app') {
    const request = build(appHttp + '; return request;', {...common, fetch, REQUEST_TIMEOUT_MS: 10, createResponseLifetime});
    api = {run: () => request('/api/events', {signal: caller.signal})};
    cancel = () => caller.abort();
  } else if (kind === 'device') {
    api = build("const getAccessToken = () => 'synthetic-fixture'; let disposed = false, epoch = 0; const activeRequests = new Set();\n" +
      deviceRequest + '; return {run: () => deviceRequest("status"), cancel() { epoch++; for (const controller of activeRequests) controller.abort(); }, activeCount: () => activeRequests.size};',
    {...common, fetch, requestTimeoutMs: 10});
    cancel = api.cancel;
  } else if (kind === 'inline') {
    const read = build(readHttpJson + '; return readHttpJson;', common);
    api = {run: () => read(ownedSignal => fetch('/api/notes', {signal: ownedSignal}), {
      signal: caller.signal, timeoutMs: 10, timeoutMessage: 'READ_TIMEOUT',
    })};
    cancel = () => caller.abort();
  } else {
    const nodes = new Map(), attributes = new Map(), rendered = [];
    const previous = {fixturePrevious: true};
    const byId = id => {
      if (!nodes.has(id)) nodes.set(id, {textContent: '', classList: {add() {}, remove() {}}});
      return nodes.get(id);
    };
    api = build('let requestNumber = 0, activeRequest = null, snapshot = previous, suspended = false;\n' + operationsRefresh +
      '; return {run: refresh, cancel() { activeRequest?.abort(); }, activeCount: () => Number(activeRequest !== null)};',
    {...common, fetch, requestTimeoutMs: 10, getToken: () => null, getDeviceProof: () => null,
      button: {setAttribute(key, value) { attributes.set(key, value); }}, byId, previous,
      validateSnapshot(value) { validateSnapshot(value); if (duringValidation) time.expire(); },
      render(value) { rendered.push(value); },
    });
    Object.assign(api, {nodes, attributes, rendered, previous});
    cancel = api.cancel;
  }
  return {
    ...api, time, stats,
    async settle() {
      try { return {value: await api.run()}; } catch (error) { return {error}; }
    },
    assertCleanup() {
      if (boundary) assert.equal(boundaryRan, true);
      assert.equal(signal.aborted, true, 'owned fetch is aborted before returning');
      assert.equal(stats.cancelled, 1, 'response ownership is disposed once');
      if (stats.acquired) assert.ok(stats.released >= 1, 'acquired reader ownership is released');
      assert.equal(time.timers.size, 0, 'deadline timer is cleared');
      if (api.activeCount) assert.equal(api.activeCount(), 0, 'active request ownership is cleared');
      if (api.attributes) assert.equal(api.attributes.get('aria-disabled'), 'false', 'refresh is usable again');
    },
  };
}

function assertTransportStopped(kind, fixture, result, reason) {
  if (kind === 'app') {
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, reason === 'deadline' ? 'TIMEOUT' : 'CANCELLED');
  } else if (kind === 'device') {
    assert.equal(result.error?.message, reason === 'deadline' ? 'DEVICE_REQUEST_TIMEOUT' : 'DEVICE_REQUEST_CANCELLED');
  } else if (kind === 'inline') {
    assert.equal(result.error?.message, reason === 'deadline' ? 'READ_TIMEOUT' : '요청이 취소되어 응답을 적용하지 않았습니다.');
  } else {
    assert.equal(fixture.rendered.length, 0, 'no stopped observation replaces the previous snapshot');
    assert.equal(fixture.nodes.get('ops-state').textContent, '증적 조회 실패 · 마지막으로 받은 기록을 표시합니다.');
  }
}

for (const kind of ['app', 'device', 'inline', 'operations']) {
  for (const boundary of ['deadline', 'cancellation']) {
    test(`${kind}: successful inner read cannot cross final ${boundary} boundary`, async () => {
      const fixture = transportFixture(kind, {boundary});
      assertTransportStopped(kind, fixture, await fixture.settle(), boundary);
      fixture.assertCleanup();
    });
  }

  test(`${kind}: expired HTTP denial cannot escape the final lifetime check`, async () => {
    const fixture = transportFixture(kind, {boundary: 'deadline', denied: true});
    assertTransportStopped(kind, fixture, await fixture.settle(), 'deadline');
    fixture.assertCleanup();
  });

  test(`${kind}: timely denial keeps its existing HTTP contract`, async () => {
    const fixture = transportFixture(kind, {denied: true}), result = await fixture.settle();
    if (kind === 'app') assert.equal(result.value.error.code, 'FIXTURE_DENIED');
    else if (kind === 'device') assert.equal(result.error?.message, 'DEVICE_HTTP_403');
    else if (kind === 'inline') { assert.equal(result.value.response.status, 403); assert.deepEqual(result.value.data, {fixture: true}); }
    else {
      assert.equal(fixture.rendered.length, 0);
      assert.match(fixture.nodes.get('ops-state').textContent, /증적 조회 실패 \(HTTP_403\)/u);
    }
    fixture.assertCleanup();
  });

  test(`${kind}: timely success remains usable and releases ownership`, async () => {
    const fixture = transportFixture(kind), result = await fixture.settle();
    assert.equal(result.error, undefined);
    if (kind === 'app') assert.deepEqual(result.value.data, {fixture: true});
    else if (kind === 'device') assert.deepEqual(result.value, {fixture: true});
    else if (kind === 'inline') assert.deepEqual(result.value.data, {fixture: true});
    else assert.equal(fixture.rendered.length, 1);
    fixture.assertCleanup();
  });
}

test('operations: validation cannot publish a snapshot after consuming the remaining budget', async () => {
  const fixture = transportFixture('operations', {duringValidation: true});
  assertTransportStopped('operations', fixture, await fixture.settle(), 'deadline');
  fixture.assertCleanup();
});

function wrapperFixture(kind, {boundary = null, denied = false, duringValidation = false} = {}) {
  const time = clock(), caller = new AbortController(), renders = [];
  let signal, boundaryRan = false, normalizations = 0, api;
  const result = denied
    ? {ok: false, error: {code: 'FIXTURE_DENIED', message: 'Fixture denial'}, meta: {mode: 'connected'}}
    : {ok: true, data: {fixture: true}, meta: {mode: 'connected'}};
  const request = (_path, options) => {
    signal = options.signal;
    if (boundary) atFinalBoundary(() => {
      boundaryRan = true;
      if (boundary === 'deadline') time.expire();
      else if (kind === 'ai') caller.abort();
      else api.cancel();
    });
    return Promise.resolve(result);
  };
  const common = {performance: time.performance, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    REQUEST_TIMEOUT_MS: 10, request};
  if (kind === 'ai') {
    const run = build(appCommon + aiRequest + '; return aiRequest;', {
      ...common, AI_MESSAGES: {TIMEOUT: 'fixture timeout', CANCELLED: 'fixture cancellation'},
    });
    api = {run: () => run('/api/ai', {body: {fixture: true}, signal: caller.signal})};
  } else {
    const state = {vulnerabilities: {status: 'idle'}};
    api = build(appCommon + '\nlet generation = 0, vulnerabilitiesGeneration = 0, vulnerabilitiesController = null;\n' +
      vulnerabilities + '; return {run: loadVulnerabilities, cancel: cancelVulnerabilities, active: () => vulnerabilitiesController};', {
      ...common, state,
      normalizeScan(value) { normalizations++; if (duringValidation) time.expire(); return value; },
      renderVulnerabilities() { renders.push(structuredClone(state.vulnerabilities)); },
    });
    Object.assign(api, {state, renders});
  }
  return {
    ...api, result, normalizations: () => normalizations,
    assertCleanup() {
      if (boundary) assert.equal(boundaryRan, true);
      assert.equal(signal.aborted, true);
      assert.equal(time.timers.size, 0);
      if (api.active) assert.equal(api.active(), null);
    },
  };
}

for (const kind of ['ai', 'vulnerabilities']) {
  for (const boundary of ['deadline', 'cancellation']) {
    test(`${kind}: completed inner request is checked again before publication after ${boundary}`, async () => {
      const fixture = wrapperFixture(kind, {boundary}), result = await fixture.run();
      const error = kind === 'ai' ? result.error : fixture.state.vulnerabilities.error;
      assert.equal(error.code, boundary === 'deadline' ? 'TIMEOUT' : 'CANCELLED');
      if (kind === 'vulnerabilities') {
        assert.equal(fixture.state.vulnerabilities.status, 'error');
        assert.equal(fixture.normalizations(), 0);
        assert.deepEqual(fixture.renders.map(value => value.status), ['loading', 'error']);
      }
      fixture.assertCleanup();
    });
  }

  test(`${kind}: expired negative response is replaced by the terminal timeout result`, async () => {
    const fixture = wrapperFixture(kind, {boundary: 'deadline', denied: true}), result = await fixture.run();
    assert.equal(kind === 'ai' ? result.error.code : fixture.state.vulnerabilities.error.code, 'TIMEOUT');
    fixture.assertCleanup();
  });

  test(`${kind}: timely success and denial preserve their existing outcome`, async () => {
    for (const denied of [false, true]) {
      const fixture = wrapperFixture(kind, {denied}), result = await fixture.run();
      if (kind === 'ai') assert.equal(result, fixture.result);
      else {
        assert.equal(fixture.state.vulnerabilities.status, denied ? 'error' : 'ok');
        if (denied) assert.equal(fixture.state.vulnerabilities.error.code, 'FIXTURE_DENIED');
        else assert.deepEqual(fixture.state.vulnerabilities.data, {fixture: true});
      }
      fixture.assertCleanup();
    }
  });
}

test('vulnerabilities: normalization cannot publish data after consuming the remaining budget', async () => {
  const fixture = wrapperFixture('vulnerabilities', {duringValidation: true});
  await fixture.run();
  assert.equal(fixture.normalizations(), 1);
  assert.equal(fixture.state.vulnerabilities.status, 'error');
  assert.equal(fixture.state.vulnerabilities.error.code, 'TIMEOUT');
  assert.deepEqual(fixture.renders.map(value => value.status), ['loading', 'error']);
  fixture.assertCleanup();
});
