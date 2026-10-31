import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectHostObservation } from '../student/collect-host.mjs';
import { normalizeHostObservation, hostComparison, hostPanel, hostReportQuality } from '../student/extension.mjs';

const T = Date.parse('2026-10-31T02:00:00Z');
const networkInterfaces = () => ({ eth0: [{ family: 'IPv6', address: 'fe80::1%eth0', internal: false }] });
const dnsServers = () => ['1.1.1.1'];
const firewallSample = { profiles: [
  { Name: 'Domain', Enabled: true, DefaultInboundAction: 'Block', DefaultOutboundAction: 'Allow' },
] };
async function report(platform = 'win32', time = T) {
  return collectHostObservation({ platform, clock: () => time, networkInterfaces, dnsServers, run: async (path, args) => {
    if (args.at(-1).includes('Get-NetFirewallProfile')) return JSON.stringify(firewallSample);
    if (args.at(-1).includes('Get-WinEvent')) return JSON.stringify({
      System: { status: 'ok', warning: 2, error: 1 },
      Application: { status: 'ok', warning: 1, error: 0 },
    });
    if (platform === 'darwin') return 'Firewall is disabled. (State = 0)';
    throw Object.assign(new Error('no service'), { code: 'ENOENT' });
  } });
}

test('a Windows local report displays sourced event counts as OS logs, not attack detections', async () => {
  const original = await report();
  const result = normalizeHostObservation(original, T);
  assert.equal(result.status, 'ok');
  assert.equal(result.network.status, 'ok');
  assert.equal(result.network.interfaces[0].addresses[0].address, 'fe80::1%eth0');
  assert.equal(result.firewall.status, 'ok');
  assert.equal(result.windowsEvents.status, 'ok');
  assert.deepEqual(result.windowsEvents.system, { status: 'ok', warning: 2, error: 1 });
  assert.equal(result.windowsEvents.detection, false);
  assert.ok(result.windowsEvents.source.startsWith('windows:'));
});
test('macOS/Linux clearly say Windows log is not applicable, not zero', async () => {
  for (const platform of ['darwin','linux']) {
    const result = normalizeHostObservation(await report(platform), T);
    assert.equal(result.status, 'ok');
    assert.equal(result.windowsEvents.status, 'not_applicable');
    assert.equal(result.windowsEvents.reason, 'WINDOWS_ONLY');
    assert.equal(result.windowsEvents.system, undefined);
  }
});
test('invalid fields fail independently, retaining valid network and firewall readings', async () => {
  const original = await report();
  const tampered = structuredClone(original);
  tampered.windowsEvents.System = 'injected';
  tampered.windowsEvents.system.warning = -1;
  tampered.firewall.profiles[0].inbound = 'Execute';
  const result = normalizeHostObservation(tampered, T);
  assert.equal(result.status, 'ok');
  assert.equal(result.network.status, 'ok');
  assert.equal(result.firewall.status, 'unavailable');
  assert.equal(result.windowsEvents.system.status, 'unavailable');
  assert.equal(result.windowsEvents.system.warning, null);
  assert.equal(result.windowsEvents.application.status, 'ok');
});
test('report identity and time claims are constrained; forged scheme and future time cannot pass', async () => {
  const original = await report();
  for (const alteration of [
    { schema: 'unrelated' }, { scope: 'whole-physical-pc' },
    { evidence: 'verified-authenticated-proof' }, { readOnly: false },
    { producedAt: new Date(T + 120000).toISOString() },
  ]) assert.equal(normalizeHostObservation({ ...original, ...alteration }, T).status, 'error');
  const stale = normalizeHostObservation({ ...original, producedAt: new Date(T - 2000000).toISOString() }, T);
  assert.equal(stale.status, 'ok');
  assert.equal(stale.network.status, 'unavailable');
});
test('trend compares two real report snapshots with same OS and valid 24h counts only', () => {
  const sample = { time: T, platform: 'win32', windowsEventCount: 9 };
  assert.equal(hostComparison([sample]), null);
  assert.equal(hostComparison([sample, { ...sample, time: T + 300000, windowsEventCount: 14 }]).delta, 5);
  assert.equal(hostComparison([sample, { ...sample, time: T + 300000, platform: 'linux' }]), null);
  assert.equal(hostComparison([sample, { ...sample, time: T + 300000, windowsEventCount: null }]), null);
  assert.equal(hostComparison([sample, { ...sample }]), null);
});

class ElementStub {
  constructor(tag) { this.tagName=tag.toUpperCase(); this._text=''; this.children=[]; this.listeners={}; this.style={}; this.attributes={}; this.files=[]; this.clickCount=0; this.className=''; }
  set textContent(value) { this._text=String(value); this.children=[]; }
  get textContent() { return this._text + this.children.map(child=>child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=[...children]; this._text=''; }
  setAttribute(key,value) { this.attributes[key]=String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name,fn) { (this.listeners[name]??=[]).push(fn); }
  async dispatch(name) { for(const fn of this.listeners[name]||[]) await fn(); }
  click() { this.clickCount++; return this.dispatch('click'); }
  find(predicate) { if(predicate(this)) return this; for(const child of this.children) { const match=child.find?.(predicate);if(match) return match; } return null; }
  findAll(predicate) { return [...(predicate(this)?[this]:[]),...this.children.flatMap(x=>x.findAll?.(predicate)||[])]; }
}

async function withDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new ElementStub(tag) };
  try { return await fn(); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document=previous; }
}
test('student cards retain four statuses, keyboard-native reload button, and no prior sample before selecting a file', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    const root = hostPanel(state, 'disconnected');
    assert.equal(root.findAll(el=>el.getAttribute('data-host-card')!=null).length, 4);
    assert.match(root.textContent, /SDP 미연결/);
    assert.match(root.textContent, /침해나 공격 탐지 결과가 아닙니다/);
    assert.match(root.textContent, /미조회/);
    const button = root.find(el=>el.tagName==='BUTTON');
    const input = root.find(el=>el.tagName==='INPUT');
    assert.equal(button.type,'button');
    assert.ok(button.getAttribute('aria-label').includes('다시 조회'));
    assert.equal(input.type,'file');
    await button.click();
    assert.equal(input.clickCount,1);
  });
});
test('local JSON selection displays real values and per-item timestamps without replacing SDP status', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    const root=hostPanel(state,'disconnected');
    const input=root.find(el=>el.tagName==='INPUT');
    const value=JSON.stringify(await report('win32', Date.now()));
    input.files=[{size:Buffer.byteLength(value),text:async()=>value}];
    await input.dispatch('change');
    assert.equal(state.pending,false);
    assert.equal(state.error,null);
    assert.equal(state.history.length,1);
    assert.equal(state.latest.windowsEvents.system.warning,2);
    assert.match(root.textContent,/SDP 미연결/);
    assert.match(root.textContent,/4건 \/ 24시간/);
    assert.match(root.textContent,/사용자 선택 파일/);
    assert.match(root.textContent,/수집/);
    assert.match(root.textContent,/침해나 공격 탐지 결과가 아닙니다/);
    assert.equal(root.getAttribute('aria-busy'),'false');
  });
});
test('invalid re-selected file removes formerly displayed current values and shows next action', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    const root = hostPanel(state,'demo');
    const input = root.find(el=>el.tagName==='INPUT');
    const value = JSON.stringify(await report('win32',Date.now()));
    input.files=[{size:value.length,text:async()=>value}];
    await input.dispatch('change');
    assert.equal(state.latest?.status,'ok');
    input.files=[{size:99,text:async()=>'{bad-json'}];
    await input.dispatch('change');
    assert.equal(state.latest,null);
    assert.match(root.textContent,/확인 불가/);
    assert.match(root.textContent,/새 보고서/);
    assert.match(root.textContent,/예제 DEMO/);
  });
});
test('oversized selected local report is never read or displayed', async () => {
  await withDocument(async () => {
    const state={pending:false,latest:null,history:[],error:null,requestId:0};
    const root=hostPanel(state,'unknown');
    const input=root.find(el=>el.tagName==='INPUT');
    let read=false;
    input.files=[{size:300000,text:async()=>{read=true;return '{}'}}];
    await input.dispatch('change');
    assert.equal(read,false);
    assert.equal(state.latest,null);
    assert.equal(state.error,'REPORT_TOO_LARGE');
  });
});

test('unreadable selected files report file access failure rather than incorrect measurement', async () => {
  await withDocument(async () => {
    const state={pending:false,latest:null,history:[],error:null,requestId:0};
    const root=hostPanel(state,'disconnected');
    const input=root.find(el=>el.tagName==='INPUT');
    input.files=[{size:128,text:async()=>{throw Error('file reader denied')}}];
    await input.dispatch('change');
    assert.equal(state.error,'FILE_READ_FAILED');
    assert.equal(state.latest,null);
    assert.match(root.textContent,/파일을 읽지 못했습니다/);
  });
});

test('OBS-inspired quality distinguishes per-source coverage, non-Windows and freshness', async () => {
  const windows = normalizeHostObservation(await report('win32', T), T);
  const now = hostReportQuality(windows, T + 1000);
  assert.equal(now.freshness, 'recent');
  assert.equal(now.coverage, 'observed');
  assert.equal(now.observedFeeds, 3);
  assert.equal(now.applicableFeeds, 3);
  assert.equal(now.feeds.windowsEvents.measuredAt, windows.windowsEvents.measuredAt);
  assert.match(now.authenticity, /unsigned/);
  const delayed = hostReportQuality(windows, T + 16 * 60_000);
  assert.equal(delayed.freshness, 'stale');
  assert.equal(delayed.coverage, 'unverifiable');
  const future = hostReportQuality(windows, T - 15_000);
  assert.equal(future.freshness, 'clock_skew');
  assert.equal(future.coverage, 'unverifiable');
  const linux = normalizeHostObservation(await report('linux', T), T);
  const quality = hostReportQuality(linux, T);
  assert.equal(quality.feeds.windowsEvents.state, 'not_applicable');
  assert.equal(quality.applicableFeeds, 2);
  assert.notEqual(quality.coverage, 'observed');
  assert.equal(hostReportQuality({ status: 'error' }).coverage, 'unavailable');
});

test('old local report never displays green present-tense PC status while retaining historical details', async () => {
  await withDocument(async () => {
    const producedAt = Date.now() - 16 * 60_000;
    const latest = normalizeHostObservation(await report('win32', producedAt), Date.now());
    assert.equal(latest.status, 'ok');
    const state = { pending: false, latest, history: [], error: null, requestId: 0 };
    const root = hostPanel(state, 'disconnected');
    const cards = root.findAll(el => el.getAttribute('data-host-card') !== undefined);
    assert.equal(cards.length, 4);
    for (const card of cards.slice(0, 3)) {
      assert.match(card.textContent, /확인 불가.*오래된 보고서/);
      assert.doesNotMatch(card.textContent, /실시간 정상/);
    }
    assert.match(cards[3].textContent, /SDP 미연결/);
    assert.match(root.textContent, /출처 범위.*최신성 검증 불가/);
    assert.match(root.textContent, /원천별 관측 상태/);
    assert.match(root.textContent, /원천 시각/);
    assert.match(root.textContent, /파일 원본 미인증/);
    assert.match(root.textContent, /현재 상태로 해석하지 마세요/);
  });
});
