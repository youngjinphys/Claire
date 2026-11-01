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
    this.ownerDocument = null; this.className = ''; this.open = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; this.writes++; }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
  append(...children) { for (const child of children) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child); child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  replaceWith(replacement) { if (!this.parentElement) return; const parent = this.parentElement, index = parent.children.indexOf(this); if (index < 0) return; parent.children[index] = replacement; replacement.parentElement = parent; this.parentElement = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  matches(selector) {
    if (selector === 'details[open]') return this.tagName === 'DETAILS' && this.open;
    if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
    if (selector === 'a[href]') return this.tagName === 'A' && Boolean(this.href || this.getAttribute('href'));
    if (selector === '[data-host-report-details]') return this.getAttribute('data-host-report-details') !== null;
    if (selector === '[role="status"]') return this.getAttribute('role') === 'status';
    if (selector === 'p[aria-hidden="true"]') return this.tagName === 'P' && this.getAttribute('aria-hidden') === 'true';
    if (selector.startsWith('.')) return this.className.split(/\s+/u).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const parts = selector.split(',').map(part => part.trim());
    const matches = node => parts.some(part => part === '[data-host-card] strong'
      ? node.tagName === 'STRONG' && node.parentElement?.getAttribute('data-host-card') !== null
      : node.matches(part));
    const found = [];
    const visit = node => { for (const child of node.children) { if (matches(child)) found.push(child); visit(child); } };
    visit(this); return found;
  }
  cloneNode(deep = false) {
    const copy = new Element(this.tagName); copy.ownerDocument = this.ownerDocument; copy.className = this.className;
    copy._text = this._text; copy.attributes = new Map(this.attributes); copy.open = this.open;
    if (deep) for (const child of this.children) copy.append(child.cloneNode(true));
    return copy;
  }
  contains(child) { return child === this || this.children.some(el => el.contains?.(child)); }
  click() { if (!this.disabled) return this.handlers.get('click')?.({ target: this }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(el => el !== this); }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

async function browser(t, { delayedEvents = false, throwingPanel = false, blockedDownload = false, layoutFailureFixture = false, failedModule = false, pendingModule = false } = {}) {
  const elements = new Map(), timers = new Map(), calls = [], deferred = [];
  let timerId = 0;
  const window = new Element(), document = new Element(); document.body = new Element('body'); document.hidden = false;
  const make = tag => { const element = new Element(tag); element.ownerDocument = document; return element; };
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  document.createElement = tag => make(tag); document.createElementNS = (_, tag) => make(tag);
  let failPanel = throwingPanel, failModule = failedModule, holdModule = pendingModule;
  const moduleAttempts = [], moduleWaiters = [];
  if (layoutFailureFixture) {
    const template = make('div'); template.className = 'host-loading';
    const cards = make('div'); const card = make('article'); card.setAttribute('data-host-card', 'network'); card.append(make('strong')); cards.append(card);
    const actions = make('div'); actions.className = 'host-loading-actions'; actions.setAttribute('aria-hidden', 'true');
    const status = make('p'); status.setAttribute('role', 'status');
    const hint = make('p'); hint.setAttribute('aria-hidden', 'true');
    template.append(cards, actions, status, hint); document.getElementById('integrated-host-root').append(template);
  }
  const fetch = async path => {
    calls.push(path);
    if (path === '/api/local-pc') return json(sample());
    if (path === '/api/events' && delayedEvents) return new Promise(resolve => deferred.push(resolve));
    return json(path === '/api/me' ? identity() : events());
  };
  const hostPanel = state => {
    if (failPanel) throw Error('PRIVATE_HOST_RENDER_DETAIL');
    const region = make('section'), detail = make('div'); detail.setAttribute('data-host-report-details', '');
    if (layoutFailureFixture) {
      const button = make('button'); button.type = 'button'; button.textContent = '보고서 선택'; button.setAttribute('aria-label', '보고서 선택');
      const details = make('details'), summary = make('summary'); summary.textContent = '원천별 관측 상태'; details.append(summary); detail.append(details);
      region.append(button); state.hostRedraw = () => { if (failPanel) throw Error('PRIVATE_HOST_RENDER_DETAIL'); };
    }
    region.append(detail);
    return region;
  };
  const loadStudentModule = url => {
    moduleAttempts.push(url);
    if (holdModule) return new Promise((resolve, reject) => moduleWaiters.push({ resolve, reject }));
    return failModule ? Promise.reject(Error('PRIVATE_MODULE_LOAD_DETAIL')) : Promise.resolve({ hostPanel });
  };
  class LocalURL extends URL {}
  LocalURL.createObjectURL = () => { if (blockedDownload) throw Error('PRIVATE_DOWNLOAD_DETAIL'); return 'blob:synthetic-test'; };
  const revoked = []; LocalURL.revokeObjectURL = value => revoked.push(value);
  const context = vm.createContext({ ...model, hostPanel, loadStudentModule, console, document, window, fetch, AbortController,
    URL: LocalURL, Blob, Response, TextDecoder, performance, structuredClone,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, type: 'timeout' }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, type: 'interval' }); return id; },
    clearInterval: id => timers.delete(id),
  });
  t.after(() => window.handlers.get('pagehide')?.({ persisted: false }));
  const source = (await readFile(new URL('../public/dashboard.mjs', import.meta.url), 'utf8'))
    .replace(/^(?:import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*)+/u, '')
    .replace('import(hostModuleUrl)', 'loadStudentModule(hostModuleUrl)');
  vm.runInContext(source, context);
  await flush();
  return { get: document.getElementById, context, window, document, timers, calls, deferred, revoked, moduleAttempts, moduleWaiters, hostPanel,
    setPanelFailure: value => { failPanel = value; }, setModuleFailure: value => { failModule = value; }, setModulePending: value => { holdModule = value; } };
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

test('initial host render failure exposes accessible retry and returns focus to the recovered panel', async t => {
  const b = await browser(t, { throwingPanel: true, layoutFailureFixture: true });
  const root = b.get('integrated-host-root'), actions = root.querySelector('.host-loading-actions');
  const retry = actions.querySelector('button'), original = actions.querySelector('a[href]');
  assert.ok(retry); assert.ok(original);
  assert.equal(actions.getAttribute('aria-hidden'), null);
  assert.match(root.querySelector('[role="status"]').textContent, /확인 불가/);
  retry.focus(); b.setPanelFailure(false); retry.click(); await flush();
  const recovered = root.querySelector('button');
  assert.equal(recovered?.textContent, '보고서 선택');
  assert.equal(b.document.activeElement, recovered);
});

test('a failed student module leaves independent controls working and permits an explicit retry', async t => {
  const b = await browser(t, { failedModule: true, layoutFailureFixture: true });
  const root = b.get('integrated-host-root');
  const status = root.querySelector('[role="status"]');
  assert.ok(status, 'a failed module must display an error status');
  assert.match(status.textContent, /불러오|표시 확인 불가/);
  assert.equal(b.get('sample-once').disabled, false);
  b.get('sample-once').click(); await flush();
  assert.ok(b.calls.includes('/api/local-pc'));
  assert.ok(b.calls.includes('/api/me')); assert.ok(b.calls.includes('/api/events'));
  assert.equal(b.moduleAttempts.length, 1, 'do not automatically retry a failed module');
  const retry = root.querySelector('.host-loading-actions').querySelector('button');
  retry.focus(); b.setModuleFailure(false); retry.click(); await flush();
  assert.equal(root.querySelector('button')?.textContent, '보고서 선택');
  assert.equal(b.moduleAttempts.length, 2);
  assert.notEqual(b.moduleAttempts[0], b.moduleAttempts[1], 'retry a failed evaluated module with a fresh URL');
  assert.doesNotMatch(root.textContent, /PRIVATE_MODULE_LOAD_DETAIL/);
});

test('a timed-out student module cannot replace a later explicit retry', async t => {
  const b = await browser(t, { pendingModule: true, layoutFailureFixture: true });
  assert.equal(b.moduleAttempts.length, 1);
  const timer = [...b.timers].find(([, value]) => value.type === 'timeout' && value.delay === 12000);
  assert.ok(timer, 'student module loading must have a bounded wait');
  b.timers.delete(timer[0]); timer[1].fn(); await flush();
  const root = b.get('integrated-host-root');
  const retry = root.querySelector('.host-loading-actions').querySelector('button');
  assert.ok(retry);
  retry.focus(); retry.click(); retry.click(); await flush();
  assert.equal(b.moduleAttempts.length, 2, 'an in-flight retry must not be duplicated');
  assert.equal(retry.getAttribute('aria-disabled'), 'true');
  assert.equal(b.document.activeElement, retry, 'loading must not discard keyboard focus');
  b.moduleWaiters[1].resolve({ hostPanel: b.hostPanel }); await flush();
  assert.equal(root.querySelector('button')?.textContent, '보고서 선택');
  assert.equal(b.document.activeElement, root.querySelector('button'));
  b.moduleWaiters[0].reject(Error('PRIVATE_LATE_FAILURE')); await flush();
  assert.equal(root.querySelector('button')?.textContent, '보고서 선택');
  assert.doesNotMatch(root.textContent, /PRIVATE_LATE_FAILURE/);
});

test('a student module retry does not steal focus after the user moves elsewhere', async t => {
  const b = await browser(t, { failedModule: true, layoutFailureFixture: true });
  const retry = b.get('integrated-host-root').querySelector('.host-loading-actions').querySelector('button');
  retry.focus(); b.setModuleFailure(false); b.setModulePending(true); retry.click(); await flush();
  const outside = b.get('sample-once'); outside.focus();
  b.moduleWaiters[0].resolve({ hostPanel: b.hostPanel }); await flush();
  assert.equal(b.get('integrated-host-root').querySelector('button')?.textContent, '보고서 선택');
  assert.equal(b.document.activeElement, outside);
});

test('student module retries stop at the bounded path limit and explain recovery', async t => {
  const b = await browser(t, { failedModule: true, layoutFailureFixture: true });
  const root = b.get('integrated-host-root');
  for (let i = 0; i < 7; i++) {
    const retry = root.querySelector('.host-loading-actions').querySelector('button');
    retry.focus(); retry.click(); await flush();
  }
  assert.equal(b.moduleAttempts.length, 8);
  assert.deepEqual(b.moduleAttempts.slice(1), Array.from({length:7}, (_, i) => `/student/extension-retry-${i + 2}.mjs`));
  assert.match(root.querySelector('[role="status"]').textContent, /새로고침/);
  assert.equal(root.querySelector('.host-loading-actions').querySelector('button').disabled, true);
});

test('pagehide interrupts a pending student module without an automatic BFCache retry', async t => {
  const b = await browser(t, { pendingModule: true, layoutFailureFixture: true });
  b.window.handlers.get('pagehide')?.({ persisted: true }); await flush();
  const root = b.get('integrated-host-root');
  const retry = root.querySelector('.host-loading-actions').querySelector('button');
  assert.ok(retry);
  b.window.handlers.get('pageshow')?.({ persisted: true }); await flush();
  assert.equal(b.moduleAttempts.length, 1);
  b.setModulePending(false); retry.click(); await flush();
  assert.equal(b.moduleAttempts.length, 2);
  assert.notEqual(b.moduleAttempts[0], b.moduleAttempts[1]);
  assert.equal(root.querySelector('button')?.textContent, '보고서 선택');
  b.moduleWaiters[0].resolve({ hostPanel: b.hostPanel }); await flush();
  assert.equal(root.querySelector('button')?.textContent, '보고서 선택');
});

test('a host redraw failure preserves open report details and focus after retry', async t => {
  const b = await browser(t, { layoutFailureFixture: true });
  const root = b.get('integrated-host-root'), report = b.get('host-report-content');
  const button = root.querySelector('button'), details = report.querySelector('details');
  assert.ok(button); assert.ok(details);
  details.open = true; button.focus(); b.setPanelFailure(true);
  vm.runInContext('hostState.hostRedraw()', b.context);
  const actions = root.querySelector('.host-loading-actions'), retry = actions?.querySelector('button');
  assert.ok(retry);
  assert.equal(actions.getAttribute('aria-hidden'), null);
  assert.equal(b.document.activeElement, retry);
  assert.match(root.querySelector('[role="status"]').textContent, /확인 불가/);
  b.setPanelFailure(false); retry.click(); await flush();
  assert.equal(report.querySelector('details')?.open, true);
  assert.equal(b.document.activeElement, root.querySelector('button'));
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
