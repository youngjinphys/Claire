// Synthetic response/DOM tests of shipped code. No probes, elevation or real SDP data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as model from '../public/dashboard-model.mjs';

const flush = async () => { for (let n = 0; n < 3; n++) await new Promise(resolve => setImmediate(resolve)); };
const iso = time => new Date(time).toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const identity = (time = Date.now()) => ({ ok: true, meta: { mode: 'connected', checkedAt: iso(time) }, data: {
  user: { id: 'test-user', label: 'Synthetic user' }, device: { id: 'test-device', label: 'Synthetic device', status: 'compliant' },
  session: { id: 'test-session', status: 'active' },
} });
const events = (time = Date.now()) => ({ ok: true, data: [], meta: { mode: 'connected', checkedAt: iso(time) } });
const sample = () => {
  const now = Date.now();
  const metric = (value, unit, source, extra = {}) => ({ status: 'ok', value, unit, source, measuredAt: iso(now), ...extra });
  return { ok: true, data: { schema: 'claire.local-pc.v1', scope: 'local-machine', checkedAt: iso(now), metrics: {
    cpu: metric(30, '%', 'os.cpus', { measuredFrom: iso(now - 400), windowMs: 400 }),
    memory: metric(50, '%', 'os.totalmem/os.freemem', { usedGiB: 4, totalGiB: 8 }),
    disk: metric(20, 'GiB', 'fs.statfs', { scope: 'project-filesystem' }),
  } } };
};

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.handlers = new Map(); this.children = []; this.dataset = {};
    this.value = 'all'; this.disabled = false; this.hidden = false; this._text = ''; this.writes = 0;
    this.attributes = new Map(); this.style = {}; this.isConnected = true; this.parentElement = null;
  }
  set textContent(value) { this._text = String(value); this.children = []; this.writes++; }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains(child) { return child === this || this.children.some(el => el.contains?.(child)); }
  click() { if (!this.disabled) return this.handlers.get('click')?.({ target: this }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(el => el !== this); }
  focus() { this.focused = true; }
}

async function browser(t, { delayedEvents = false, throwingPanel = false, blockedDownload = false } = {}) {
  const elements = new Map(), timers = new Map(), calls = [], deferred = [];
  let timerId = 0;
  const window = new Element(), document = new Element(); document.body = new Element('body'); document.hidden = false;
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = tag => new Element(tag); document.createElementNS = (_, tag) => new Element(tag);
  const fetch = async path => {
    calls.push(path);
    if (path === '/api/local-pc') return json(sample());
    if (path === '/api/events' && delayedEvents) return new Promise(resolve => deferred.push(resolve));
    return json(path === '/api/me' ? identity() : events());
  };
  const hostPanel = () => {
    if (throwingPanel) throw Error('PRIVATE_HOST_RENDER_DETAIL');
    const region = new Element(), detail = new Element();
    region.append(detail); region.querySelector = selector => selector === '[data-host-report-details]' ? detail : null;
    return region;
  };
  class LocalURL extends URL {}
  LocalURL.createObjectURL = () => { if (blockedDownload) throw Error('PRIVATE_DOWNLOAD_DETAIL'); return 'blob:synthetic-test'; };
  const revoked = []; LocalURL.revokeObjectURL = value => revoked.push(value);
  const context = vm.createContext({ ...model, hostPanel, console, document, window, fetch, AbortController,
    URL: LocalURL, Blob, Response, TextDecoder, performance, structuredClone,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, type: 'timeout' }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, type: 'interval' }); return id; },
    clearInterval: id => timers.delete(id),
  });
  t.after(() => window.handlers.get('pagehide')?.({ persisted: false }));
  const source = (await readFile(new URL('../public/dashboard.mjs', import.meta.url), 'utf8'))
    .replace(/^(?:import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*)+/u, '');
  vm.runInContext(source, context);
  await flush();
  return { get: document.getElementById, context, window, document, timers, calls, deferred, revoked };
}

test('identity result appears without waiting for a slow independent events response', async t => {
  const b = await browser(t, { delayedEvents: true });
  assert.match(b.get('sdp-policy-detail').textContent, /기준 충족/);
  assert.match(b.get('events-note').textContent, /조회 중/);
  b.deferred[0](json(events())); await flush();
  assert.equal(b.get('refresh-security').disabled, false);
});

test('changing event filter and freshness ticks cannot erase the in-flight state', async t => {
  const b = await browser(t, { delayedEvents: true });
  b.get('event-filter').value = 'xdr'; b.get('event-filter').handlers.get('change')?.();
  for (const timer of [...b.timers.values()]) if (timer.type === 'interval') timer.fn();
  assert.match(b.get('events-note').textContent, /조회 중/);
  assert.equal(b.get('records-panel').getAttribute('aria-busy'), 'true');
  b.deferred[0](json(events())); await flush();
  assert.equal(b.get('records-panel').getAttribute('aria-busy'), 'false');
});

test('events and identity reject stale/future envelopes even when optional coverage is absent', () => {
  const now = Date.now(), timing = { requestedAt: now, receivedAt: now + 100 };
  for (const time of [now - 60000, now + 60000]) {
    assert.equal(model.normalizeEvents(events(time), timing).status, 'unavailable');
    assert.equal(model.normalizeSecurity(identity(time), timing).status, 'unavailable');
  }
  assert.equal(model.normalizeEvents(events(now), timing).status, 'ok');
  assert.equal(model.normalizeSecurity(identity(now), timing).status, 'ok');
});

test('invalid request timing is not accepted merely because coverage is absent', () => {
  const now = Date.now();
  for (const timing of [{}, { requestedAt: now + 1, receivedAt: now }, { requestedAt: NaN, receivedAt: now }]) {
    assert.equal(model.normalizeEvents(events(now), timing).status, 'unavailable');
    assert.equal(model.normalizeSecurity(identity(now), timing).status, 'unavailable');
  }
});

test('one host-panel render failure cannot disable the independent PC measurement controls', async t => {
  const b = await browser(t, { throwingPanel: true });
  assert.match(b.get('integrated-host-root').textContent, /확인 불가/);
  assert.doesNotMatch(b.get('integrated-host-root').textContent, /PRIVATE_HOST_RENDER_DETAIL/);
  b.get('sample-once').click(); await flush();
  assert.equal(b.get('cpu-value').textContent, '30.0');
  assert.equal(b.get('sample-once').disabled, false);
});

test('bounded history repaint notices a same-time gap without repainting unchanged rows', async t => {
  const b = await browser(t);
  vm.runInContext('history=Array.from({length:120},(_,i)=>({time:Date.now()-120000+i*1000,cpu:30,memory:50,metrics:{cpu:{status:"ok",value:30,unit:"%"},memory:{status:"ok",value:50,unit:"%"},disk:{status:"ok",value:1,unit:"GiB"}}}));renderMeasurementRecords();', b.context);
  const before = b.get('measurement-body').children[0];
  vm.runInContext('renderMeasurementRecords();', b.context);
  assert.equal(b.get('measurement-body').children[0], before, 'unchanged rows retain their DOM');
  vm.runInContext('history=appendGap(history,history.at(-1).time);renderMeasurementRecords();', b.context);
  assert.match(b.get('measurement-body').children[0].textContent, /관측 중단\/실패 구간/);
});

test('explicit Stop creates a missing-data boundary before a subsequent one-shot', async t => {
  const b = await browser(t);
  vm.runInContext('history=[{time:Date.now()-5000,cpu:20,memory:50}];observing=true;stopObserving();', b.context);
  assert.equal(vm.runInContext('history.at(-1).cpu', b.context), null);
  vm.runInContext('history=appendSample(history,{status:"ok",checkedAt:new Date(Date.now()+1).toISOString(),metrics:{cpu:{status:"ok",value:30,measuredAt:new Date().toISOString()},memory:{status:"ok",value:50,measuredAt:new Date().toISOString()}}},Date.now()+1);', b.context);
  assert.equal(vm.runInContext('trendSummary(history)', b.context), null);
});

test('download failures show next steps without discarding records or throwing into the UI', async t => {
  const b = await browser(t, { blockedDownload: true });
  vm.runInContext('history=[{time:Date.now(),cpu:null,memory:null}];', b.context);
  assert.doesNotThrow(() => vm.runInContext('downloadMeasurements();', b.context));
  assert.match(b.get('measurement-note').textContent, /확인 불가/);
  assert.doesNotMatch(b.get('measurement-note').textContent, /PRIVATE_DOWNLOAD_DETAIL/);
  assert.equal(vm.runInContext('history.length', b.context), 1);
});

test('unchanged polite status text is not rewritten on every UI tick', async t => {
  const b = await browser(t);
  const el = b.get('sdp-policy-detail'), count = el.writes;
  vm.runInContext('showSecurity();showSecurity();', b.context);
  assert.equal(el.writes, count);
});

test('hidden tab pauses repaint timers and restoration never polls or resumes sampling', async t => {
  const b = await browser(t);
  const calls = b.calls.length;
  b.document.hidden = true; b.document.handlers.get('visibilitychange')?.();
  assert.equal([...b.timers.values()].filter(timer => timer.type === 'interval').length, 0);
  b.document.hidden = false; b.document.handlers.get('visibilitychange')?.(); await flush();
  assert.equal([...b.timers.values()].filter(timer => timer.type === 'interval').length, 1);
  assert.equal(b.calls.length, calls);
  assert.equal(b.get('start').disabled, false);
});

test('malformed JSON and invalid UTF-8 are response-format failures, not network outages', async () => {
  for (const body of ['{incomplete', new Uint8Array([0xff])]) {
    await assert.rejects(model.requestDashboardJson('/api/events', {
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    }), /RESPONSE_CONTRACT_INVALID/);
  }
});

test('DEMO provenance must not hide a failed policy read', async t => {
  const b = await browser(t);
  vm.runInContext("latestSecurity={status:'unavailable',mode:'demo',checkedAt:new Date().toISOString(),reason:'SOURCE_TIME_UNVERIFIED'};showSecurity();", b.context);
  assert.match(b.get('sdp-policy-detail').textContent, /DEMO/);
  assert.match(b.get('sdp-policy-detail').textContent, /확인 불가/);
});
