import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectHostObservation } from '../student/collect-host.mjs';
import { normalizeHostObservation, hostComparison, hostPanel, hostReportQuality, buildClaireHostAggregateEvidence, hostHistoryTransition, createStudentView } from '../student/extension.mjs';

const T = Date.parse('2026-10-31T02:00:00Z');
const networkInterfaces = () => ({ eth0: [{ family: 'IPv6', address: 'fe80::1%eth0', internal: false }] });
const dnsServers = () => ['1.1.1.1'];
const firewallSample = { profiles: [
  { Name: 'Domain', Enabled: true, DefaultInboundAction: 'Block', DefaultOutboundAction: 'Allow' },
  { Name: 'Private', Enabled: 'False', DefaultInboundAction: 'Block', DefaultOutboundAction: 'Allow' },
  { Name: 'Public', Enabled: 'True', DefaultInboundAction: 'Block', DefaultOutboundAction: 'Allow' },
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
  const window = end => ({ windowStart: new Date(end - 86400000).toISOString(), windowEnd: new Date(end).toISOString() });
  const sample = { time: T, platform: 'win32', windowsEventCount: 9, ...window(T) };
  assert.equal(hostComparison([sample]), null);
  assert.equal(hostComparison([sample, { ...sample, time: T + 300000, windowsEventCount: 14, ...window(T + 300000) }]).delta, 5);
  assert.equal(hostComparison([sample, { ...sample, time: T + 300000, platform: 'linux' }]), null);
  assert.equal(hostComparison([sample, { ...sample, time: T + 300000, windowsEventCount: null }]), null);
  assert.equal(hostComparison([sample, { ...sample }]), null);
});

class ElementStub {
  constructor(tag) { this.tagName=tag.toUpperCase(); this._text=''; this.children=[]; this.listeners={}; this.style={}; this.attributes={}; this.files=[]; this.clickCount=0; this.className=''; this.parentElement=null; this.open=false; }
  set textContent(value) { this.replaceChildren(); this._text=String(value); }
  get textContent() { return this._text + this.children.map(child=>child.textContent).join(''); }
  get firstElementChild() { return this.children[0] || null; }
  get isConnected() { return this === globalThis.document?.body || this.parentElement?.isConnected === true; }
  append(...children) { for (const child of children) { if (child.parentElement) child.parentElement.children=child.parentElement.children.filter(item=>item!==child); child.parentElement=this; this.children.push(child); } }
  replaceChildren(...children) {
    if (this.children.some(child=>child.contains(globalThis.document?.activeElement))) globalThis.document.activeElement=globalThis.document.body;
    for (const child of this.children) child.parentElement=null;
    this.children=[]; this._text=''; this.append(...children);
  }
  contains(target) { return target === this || this.children.some(child=>child.contains(target)); }
  focus() { if (this.isConnected && !this.disabled) globalThis.document.activeElement=this; }
  querySelectorAll(selector) {
    return this.findAll(node => node !== this && selector.split(',').some(value => {
      const item = value.trim();
      if (item.startsWith('#')) return node.id === item.slice(1);
      if (item === 'details[open]') return node.tagName === 'DETAILS' && node.open;
      if (item === 'a[href]') return node.tagName === 'A' && Boolean(node.href);
      return node.tagName === item.toUpperCase();
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
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
  const body = new ElementStub('body');
  globalThis.document = { createElement: tag => new ElementStub(tag), body, activeElement: body };
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

test('OBS-style Claire export contains only counts and provenance, never local addresses or DNS values', async () => {
  const observed = normalizeHostObservation(await report('win32', T), T);
  const evidence = buildClaireHostAggregateEvidence(observed, new Date(T + 30_000).toISOString());
  assert.equal(evidence.schema, 'claire.host-aggregate-evidence.v1');
  assert.equal(evidence.provenance.authenticity, 'unsigned-user-download-not-host-attestation');
  assert.equal(evidence.provenance.freshness, 'recent');
  assert.equal(evidence.measurements.networkInterfaces.value, 1);
  assert.equal(evidence.measurements.dnsServers.value, 1);
  assert.equal(evidence.measurements.windowsSystemWarnings.value, 2);
  assert.equal(evidence.measurements.windowsApplicationErrors.value, 0);
  const json = JSON.stringify(evidence);
  for (const confidential of ['fe80::1', '1.1.1.1', 'eth0', 'interfaces":[', 'dns":[', 'MAC', 'username', 'sessionId']) {
    assert.equal(json.includes(confidential), false, confidential);
  }
  assert.equal(Object.hasOwn(evidence, 'network'), false);
  assert.equal(Object.hasOwn(evidence, 'firewall'), false);
});

test('stale, future-skew and non-Windows host evidence remain explicitly bounded', async () => {
  const win = normalizeHostObservation(await report('win32', T), T);
  const stale = buildClaireHostAggregateEvidence(win, new Date(T + 17 * 60_000).toISOString());
  assert.equal(stale.provenance.freshness, 'stale');
  assert.equal(stale.provenance.coverage, 'unverifiable');
  const skew = buildClaireHostAggregateEvidence(win, new Date(T - 10_000).toISOString());
  assert.equal(skew.provenance.freshness, 'clock_skew');
  const mac = normalizeHostObservation(await report('darwin', T), T);
  const other = buildClaireHostAggregateEvidence(mac, new Date(T + 30_000).toISOString());
  assert.equal(other.measurements.windowsSystemErrors.status, 'not_applicable');
  assert.equal(other.measurements.windowsSystemErrors.value, null);
  assert.throws(() => buildClaireHostAggregateEvidence(win, 'not-iso'), /HOST_EVIDENCE_INPUT_INVALID/);
});

test('Claire export is user-initiated; before selecting a report the button is disabled', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    const root = hostPanel(state, 'disconnected');
    const button = root.find(el => el.tagName === 'BUTTON' && el.textContent.includes('주소·식별자 제외 집계'));
    assert.ok(button);
    assert.equal(button.disabled, true);
    const selected = JSON.stringify(await report('win32', Date.now()));
    const input = root.find(el => el.tagName === 'INPUT' && el.type === 'file');
    input.files = [{ size:Buffer.byteLength(selected), text:async()=>selected }];
    await input.dispatch('change');
    assert.equal(button.disabled, false);
    assert.match(button.getAttribute('aria-label'), /식별자 없는/);
  });
});

test('aggregate export fails closed on forged source labels and never copies unknown reason text', async () => {
  const trusted = normalizeHostObservation(await report('win32', T), T);
  const tampered = structuredClone(trusted);
  tampered.network.source = 'private-address-secret';
  tampered.windowsEvents.reason = 'SENSITIVE_PAYLOAD';
  const output = buildClaireHostAggregateEvidence(tampered, new Date(T + 30_000).toISOString());
  assert.equal(output.sourceStatus.network.state, 'unavailable');
  assert.equal(output.provenance.coverage, 'partial');
  assert.equal(output.provenance.observedFeeds, 2);
  assert.equal(output.measurements.networkInterfaces.value, null);
  const json = JSON.stringify(output);
  assert.doesNotMatch(json, /private-address-secret|SENSITIVE_PAYLOAD/);
})

test('local report rejects non-IP interface and DNS strings instead of displaying fake network addresses', async () => {
  const original = await report('win32', T);
  for (const address of ['999.999.999.999', '127.0.0.999', '1.2.3.04', '2001:db8:::1']) {
    const changed = structuredClone(original);
    changed.network.interfaces[0].addresses[0].address = address;
    const result = normalizeHostObservation(changed, T).network;
    assert.equal(result.status, 'partial', address);
    assert.equal(result.parts.interfaces.status, 'unavailable');
    assert.equal(result.parts.dns.status, 'ok');
    assert.deepEqual(result.interfaces, []);
  }
  for (const resolver of ['bad:ipv6', '999.999.999.999', '[::1]:70000']) {
    const changed = structuredClone(original);
    changed.network.dns = [resolver];
    const result = normalizeHostObservation(changed, T).network;
    assert.equal(result.status, 'partial', resolver);
    assert.equal(result.parts.dns.status, 'unavailable');
    assert.equal(result.parts.interfaces.status, 'ok');
    assert.deepEqual(result.dns, []);
  }
  for (const resolver of ['127.0.0.1', '127.0.0.1:5353', '::1', '[::1]:5353']) {
    const changed = structuredClone(original);
    changed.network.dns = [resolver];
    assert.equal(normalizeHostObservation(changed, T).network.status, 'ok', resolver);
  }
  assert.equal(normalizeHostObservation(original, T).network.status, 'ok', 'existing scoped IPv6 remains supported');
});

test('Windows event envelope cannot claim success when System/Application results contradict it', async () => {
  const original = await report('win32', T);
  for (const status of ['partial', 'unavailable', 'not_applicable']) {
    const changed = structuredClone(original);
    changed.windowsEvents.status = status;
    const result = normalizeHostObservation(changed, T);
    assert.equal(result.windowsEvents.status, 'unavailable');
    assert.equal(result.windowsEvents.reason, 'EVENT_RESPONSE_INVALID');
    assert.equal(result.windowsEvents.system, undefined, 'contradictory totals must not be used');
  }
  const partial = structuredClone(original);
  partial.windowsEvents.system = { status: 'partial', reason: 'EVENT_LIMIT_EXCEEDED', warning: null, error: null };
  partial.windowsEvents.status = 'partial';
  const valid = normalizeHostObservation(partial, T);
  assert.equal(valid.windowsEvents.status, 'partial');
  assert.equal(valid.windowsEvents.system.warning, null);
  assert.equal(valid.windowsEvents.application.warning, 1);
  // Even when the outer file incorrectly claims success, preserve a separately
  // validated Application log and reject only the affected System fields.
  const inconsistent = structuredClone(original);
  inconsistent.windowsEvents.system.warning = -1;
  const degraded = normalizeHostObservation(inconsistent, T).windowsEvents;
  assert.equal(degraded.status, 'partial');
  assert.equal(degraded.reason, 'EVENT_RESPONSE_INVALID');
  assert.equal(degraded.system.status, 'unavailable');
  assert.equal(degraded.application.warning, 1);
});

test('Linux firewall reports reject duplicated and impossible management backend states', async () => {
  const original = await report('linux', T);
  const partial = structuredClone(original);
  partial.firewall = { status: 'partial', reason: 'OTHER_BACKEND_UNVERIFIED',
    measuredAt: original.firewall.measuredAt, source: 'linux:firewalld+ufw',
    backends: [{ backend: 'linux:firewall-cmd(--state)', state: 'running' }] };
  assert.equal(normalizeHostObservation(partial, T).firewall.status, 'partial');
  for (const change of [
    { ...partial.firewall, status: 'ok', reason: null },
    { ...partial.firewall, backends: [{ backend: 'linux:ufw(status)', state: 'running' }] },
    { ...partial.firewall, reason: null },
    { ...partial.firewall, status: 'ok', reason: null, backends: [
      { backend: 'linux:ufw(status)', state: 'enabled' }, { backend: 'linux:ufw(status)', state: 'disabled' }] },
  ]) {
    const altered = structuredClone(original);
    altered.firewall = change;
    assert.equal(normalizeHostObservation(altered, T).firewall.status, 'unavailable');
  }
});

test('selected local report stays pending and latest mounted student panel receives the completion', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    const original = hostPanel(state,'disconnected');
    const file = original.find(el => el.tagName === 'INPUT' && el.type === 'file');
    let finish;
    file.files = [{ size: 8000, text: () => new Promise(resolve => { finish = resolve; }) }];
    const reading = file.dispatch('change');
    assert.equal(state.pending, true);
    const choose = original.find(el => el.tagName === 'BUTTON');
    assert.notEqual(choose.disabled, true, 'keep the selection control focusable');
    assert.equal(choose.getAttribute('aria-disabled'), 'true');
    file.click = () => assert.fail('a pending read must not reopen the file chooser');
    await choose.dispatch('click');
    const replacement = hostPanel(state,'disconnected');
    assert.equal(replacement.getAttribute('aria-busy'), 'true');
    finish(JSON.stringify(await report('win32', Date.now())));
    await reading;
    assert.equal(state.pending, false);
    assert.equal(state.error, null);
    assert.match(replacement.textContent, /4건 \/ 24시간/);
    assert.equal(replacement.find(el => el.tagName === 'BUTTON').getAttribute('aria-disabled'), 'false');
  });
});


test('identical report re-selection preserves history; conflicting contents at same time never form a trend', async () => {
  const first = normalizeHostObservation(await report('win32', T), T);
  const added = hostHistoryTransition([], first, 'a'.repeat(64));
  assert.equal(added.history.length, 1);
  assert.equal(added.conflict, false);
  const repeated = hostHistoryTransition(added.history, first, 'a'.repeat(64));
  assert.equal(repeated.reason, 'DUPLICATE_REPORT');
  assert.deepEqual(repeated.history, added.history);
  const forgedSameTime = structuredClone(first);
  forgedSameTime.windowsEvents.system.warning += 3;
  const conflict = hostHistoryTransition(added.history, forgedSameTime, 'b'.repeat(64));
  assert.equal(conflict.reason, 'REPORT_TIME_CONFLICT');
  assert.equal(conflict.history.length, 1);
  assert.equal(conflict.history[0].windowsEventCount, null);
  assert.equal(conflict.history[0].conflict, true);
  assert.equal(hostComparison([{
    time: T - 60_000, platform: 'win32', windowsEventCount: 2,
  }, ...conflict.history]), null);
});

test('a current report with a stale individual sensor is partial rather than wholly verified', async () => {
  const original = normalizeHostObservation(await report('win32', T), T);
  const network = { ...original.network, measuredAt: new Date(T - 20_000).toISOString() };
  const delayed = { ...original, network };
  const quality = hostReportQuality(delayed, T + 15 * 60_000 - 5000);
  assert.equal(quality.freshness, 'recent');
  assert.equal(quality.feeds.network.freshness, 'stale');
  assert.equal(quality.feeds.firewall.freshness, 'recent');
  assert.equal(quality.coverage, 'partial');
  assert.equal(quality.observedFeeds, 2);
});

test('Windows-only nonapplicable status remains identifiable even when a macOS or Linux report is old', async () => {
  await withDocument(async () => {
    for (const platform of ['linux', 'darwin']) {
      const original = normalizeHostObservation(await report(platform, T), T);
      const root = hostPanel({ pending: false, latest: original, history: [], error: null, requestId: 0 }, 'disconnected');
      const card = root.find(el => el.getAttribute('data-host-card') === 'windows-events');
      assert.match(card.textContent, /해당 없음/);
      assert.match(card.textContent, /Windows 전용/);
      assert.match(root.textContent, /SDP 미연결/);
    }
  });
});

test('historical pairs can be explicitly bound to the consented pair, rather than a reused approval', () => {
  const window = end => ({ windowStart: new Date(end - 86400000).toISOString(), windowEnd: new Date(end).toISOString() });
  const rows = [{ time: T - 20_000, platform: 'win32', windowsEventCount: 8, fingerprint: 'a', ...window(T - 20_000) },
    { time: T, platform: 'win32', windowsEventCount: 12, fingerprint: 'b', ...window(T) }];
  assert.equal(hostComparison(rows).delta, 4);
  assert.equal(hostComparison(rows, 'nonmatching-previous-pair'), null);
  assert.equal(hostComparison(rows, [T - 20_000, 'a', T, 'b'].join(':')).delta, 4);
});


test('student host details remain expanded through a same-state redraw', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    const root = hostPanel(state,'disconnected');
    const input = root.find(el => el.tagName === 'INPUT' && el.type === 'file');
    const json = JSON.stringify(await report('win32', Date.now()));
    input.files = [{ size: Buffer.byteLength(json), text: async () => json }];
    await input.dispatch('change');
    const choose = () => root.find(el => el.tagName === 'DETAILS'
      && el.children.some(node => node.tagName === 'SUMMARY' && /네트워크 상세/.test(node.textContent)));
    const old = choose();
    assert.ok(old);
    old.open = true;
    state.hostRedraw();
    assert.equal(choose()?.open, true, 'refresh must keep keyboard-open disclosures open');
  });
});

test('older incomplete Windows profiles are downgraded and unknown Enabled remains unknown', async () => {
  const input = await report('win32', T);
  input.firewall.profiles = input.firewall.profiles.slice(0, 1);
  input.firewall.status = 'ok'; // older unsigned report overstated coverage
  input.firewall.profiles[0].enabled = null;
  const parsed = normalizeHostObservation(input, T);
  assert.equal(parsed.firewall.status, 'partial');
  assert.equal(parsed.firewall.profiles[0].enabled, null);
  assert.equal(parsed.firewall.reason, 'FIREWALL_PROFILE_INCOMPLETE');
  const evidence = buildClaireHostAggregateEvidence(parsed, new Date(T).toISOString());
  assert.equal(evidence.measurements.firewallBackends.status, 'partial');
  assert.equal(evidence.measurements.firewallBackends.unit, 'profiles');
});
test('per-tool Linux failures are retained without accepting arbitrary values', async () => {
  const input = await report('linux', T);
  const parsed = normalizeHostObservation(input, T);
  assert.equal(parsed.firewall.failures.length, 2);
  assert.ok(parsed.firewall.failures.every(row => row.reason === 'COMMAND_NOT_FOUND'));
  input.firewall.failures[0].reason = 'PRIVATE_DETAIL';
  const invalid = normalizeHostObservation(input, T);
  assert.equal(invalid.firewall.reason, 'INVALID_REPORT_FIELD');
  assert.doesNotMatch(JSON.stringify(invalid.firewall), /PRIVATE_DETAIL/);
});
test('aggregate includes each source freshness and the exact Windows window', async () => {
  const parsed = normalizeHostObservation(await report('win32', T), T);
  parsed.network.measuredAt = new Date(T - 20_000).toISOString();
  const at = new Date(T + 15 * 60_000 - 5000).toISOString();
  const evidence = buildClaireHostAggregateEvidence(parsed, at);
  assert.equal(evidence.provenance.freshness, 'recent');
  assert.equal(evidence.provenance.coverage, 'partial');
  assert.equal(evidence.sourceStatus.network.freshness, 'stale');
  assert.equal(evidence.measurements.networkInterfaces.freshness, 'stale');
  assert.equal(evidence.measurements.windowsSystemErrors.freshness, 'recent');
  assert.deepEqual(evidence.windowsEventWindow, { start: parsed.windowsEvents.windowStart, end: parsed.windowsEvents.windowEnd });
  assert.equal(evidence.provenance.platform, 'win32');
});

test('unknown report reason strings are not reflected into rendered or normalized output', async () => {
  const raw = await report('win32', T);
  raw.firewall = { status: 'unavailable', source: raw.firewall.source, measuredAt: raw.firewall.measuredAt, reason: 'PRIVATE_DIAGNOSTIC_TEXT' };
  const parsed = normalizeHostObservation(raw, T);
  assert.equal(parsed.firewall.reason, 'INVALID_REPORT_FIELD');
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE_DIAGNOSTIC_TEXT/);
});

test('host aggregate export removes its anchor when a browser click fails and retains the report',async t=>{
  await withDocument(async()=>{
    const latest=normalizeHostObservation(await report('win32',Date.now()));
    const state={pending:false,latest,history:[],error:null,requestId:0};
    const root=hostPanel(state,'disconnected');
    const output=root.find(el=>el.tagName==='BUTTON'&&el.textContent.includes('주소·식별자 제외 집계'));
    const attached=[],revoked=[],timers=[];
    document.body={append(link){attached.push(link);}};
    const create=document.createElement;
    document.createElement=tag=>{
      const element=create(tag);
      if(tag==='a'){
        element.click=()=>{throw Error('private blocked click');};
        element.remove=()=>{attached.splice(attached.indexOf(element),1);};
      }
      return element;
    };
    t.mock.method(URL,'createObjectURL',()=> 'blob:fixture-host');
    t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
    t.mock.method(globalThis,'setTimeout',(fn,delay)=>{timers.push({fn,delay});return 1;});
    await output.click();
    assert.equal(attached.length,0);
    assert.equal(state.latest,latest);
    assert.equal(output.disabled,false);
    assert.match(root.textContent,/집계 파일 저장 확인 불가/u);
    assert.doesNotMatch(root.textContent,/private blocked/u);
    assert.equal(revoked.length,0);
    assert.equal(timers.length,1);assert.equal(timers[0].delay,5000);
    timers[0].fn();assert.deepEqual(revoked,['blob:fixture-host']);
  });
});

test('independent network evidence retains a valid count and never exports a failed DNS array as zero', async () => {
  const raw = await report('win32', T);
  raw.network.dns = [];
  raw.network.status = 'partial';
  raw.network.reason = 'NETWORK_PARTIAL';
  raw.network.parts.dns.status = 'unavailable';
  raw.network.parts.dns.reason = 'NETWORK_DNS_READ_FAILED';
  const parsed = normalizeHostObservation(raw, T);
  assert.equal(parsed.network.parts.interfaces.status, 'ok');
  const evidence = buildClaireHostAggregateEvidence(parsed, new Date(T).toISOString());
  assert.equal(evidence.measurements.networkInterfaces.value, 1);
  assert.equal(evidence.measurements.networkInterfaces.status, 'observed');
  assert.equal(evidence.measurements.dnsServers.value, null);
  assert.equal(evidence.measurements.dnsServers.reason, 'NETWORK_DNS_READ_FAILED');
  assert.doesNotMatch(JSON.stringify(evidence), /fe80::1|eth0/);
});
test('legacy v1 report without parts keeps the old validation contract', async () => {
  const raw = await report('win32', T);
  delete raw.network.parts;
  assert.equal(normalizeHostObservation(raw, T).network.status, 'ok');
  raw.network.dns = ['not-an-address'];
  assert.equal(normalizeHostObservation(raw, T).network.status, 'unavailable');
});
test('different report generation times with the same Windows window are not a moving-window comparison', async () => {
  const raw = await report('win32', T);
  const first = normalizeHostObservation(raw, T);
  const second = structuredClone(raw);
  second.producedAt = new Date(T + 1000).toISOString();
  second.windowsEvents.system.warning += 3;
  let history = hostHistoryTransition([], first, 'a').history;
  history = hostHistoryTransition(history, normalizeHostObservation(second, T + 1000), 'b').history;
  assert.equal(hostComparison(history), null);
  const next = normalizeHostObservation(await report('win32', T + 5000), T + 5000);
  history = hostHistoryTransition(history, next, 'c').history;
  const compared = hostComparison(history);
  assert.equal(compared.from, T);
  assert.equal(compared.to, T + 5000);
  assert.equal(compared.delta, -3);
});

test('a future DNS observation cannot certify the aggregate network freshness', async () => {
  const raw = await report('win32', T);
  raw.network.parts.dns.measuredAt = new Date(T + 10_000).toISOString();
  const parsed = normalizeHostObservation(raw, T);
  assert.equal(hostReportQuality(parsed, T).feeds.network.freshness, 'clock_skew');
  const evidence = buildClaireHostAggregateEvidence(parsed, new Date(T).toISOString());
  assert.equal(evidence.measurements.dnsServers.freshness, 'clock_skew');
  assert.equal(evidence.measurements.networkInterfaces.freshness, 'recent');
});
test('two unavailable network sources retain independent reasons without reporting zero', async () => {
  const raw = await report('win32', T);
  raw.network.status = 'unavailable';
  raw.network.reason = 'NETWORK_READ_FAILED';
  raw.network.interfaces = [];
  raw.network.dns = [];
  Object.assign(raw.network.parts.interfaces, { status:'unavailable', reason:'NETWORK_INTERFACE_READ_FAILED' });
  Object.assign(raw.network.parts.dns, { status:'unavailable', reason:'PERMISSION_DENIED' });
  const evidence = buildClaireHostAggregateEvidence(normalizeHostObservation(raw, T), new Date(T).toISOString());
  assert.equal(evidence.measurements.networkInterfaces.value, null);
  assert.equal(evidence.measurements.networkInterfaces.reason, 'NETWORK_INTERFACE_READ_FAILED');
  assert.equal(evidence.measurements.dnsServers.value, null);
  assert.equal(evidence.measurements.dnsServers.reason, 'PERMISSION_DENIED');
});

test('provided status replacement preserves host disclosures and keyboard focus across controls', async () => {
  await withDocument(async () => {
    const view = createStudentView();
    let root = view.renderStatus({ mode: 'disconnected' });
    document.body.append(root);
    const select = async time => {
      const value = JSON.stringify(await report('win32', time));
      const file = root.find(el => el.tagName === 'INPUT' && el.type === 'file');
      file.files = [{ size: Buffer.byteLength(value), text: async () => value }];
      await file.dispatch('change');
    };
    await select(Date.now() - 5000); await select(Date.now());
    const network = () => root.querySelectorAll('details').find(el => el.firstElementChild.textContent.startsWith('네트워크 상세'));
    network().open = true;
    const controls = [
      () => network().firstElementChild,
      () => root.querySelector('#student-host-compare-consent'),
      () => root.querySelectorAll('button').find(el => el.textContent.includes('집계 JSON 저장')),
    ];
    for (const control of controls) {
      control().focus();
      root = view.renderStatus({ mode: 'demo' }); document.body.replaceChildren(root);
      await Promise.resolve();
      assert.equal(network().open, true);
      assert.ok(document.activeElement === control(), 'the corresponding new host control must receive focus');
    }
  });
});

test('queued host focus restoration respects a user move and skips superseded panels', async () => {
  await withDocument(async () => {
    const state = { pending:false, latest:null, history:[], error:null, requestId:0 };
    let root = hostPanel(state, 'disconnected'); document.body.append(root);
    root.querySelector('button').focus();
    root = hostPanel(state, 'demo'); document.body.replaceChildren(root);
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    await Promise.resolve();
    assert.ok(document.activeElement === outside, 'a later user destination must win over queued restoration');

    root.querySelector('button').focus();
    const intermediate = hostPanel(state, 'disconnected'); document.body.replaceChildren(intermediate);
    root = hostPanel(state, 'demo'); document.body.replaceChildren(root);
    await Promise.resolve();
    assert.ok(document.activeElement === root.querySelector('button'), 'rapid replacement must restore only the newest panel');
  });
});

test('host view preservation also covers dashboard-relocated details and pending file completion', async () => {
  await withDocument(async () => {
    const latest = normalizeHostObservation(await report('win32', Date.now()));
    const state = { pending:false, latest, history:[], error:null, requestId:0 };
    const root = hostPanel(state, 'disconnected'), detailMount = document.createElement('div');
    document.body.append(root, detailMount);
    const details = root.find(el => el.getAttribute('data-host-report-details') !== undefined);
    detailMount.append(details);
    const firewall = () => detailMount.querySelectorAll('details').find(el => el.firstElementChild.textContent.startsWith('방화벽 상세'));
    firewall().open = true; firewall().firstElementChild.focus();
    state.hostRedraw();
    assert.ok(details.parentElement === detailMount);
    assert.equal(firewall().open, true);
    assert.ok(document.activeElement === firewall().firstElementChild);

    let finish;
    const file = root.find(el => el.tagName === 'INPUT' && el.type === 'file');
    file.files = [{ size: 10_000, text: () => new Promise(resolve => { finish = resolve; }) }];
    root.querySelector('button').focus();
    const loading = file.dispatch('change');
    const replacement = hostPanel(state, 'demo'); document.body.replaceChildren(replacement);
    await Promise.resolve();
    assert.equal(replacement.getAttribute('aria-busy'), 'true');
    assert.ok(document.activeElement === replacement.querySelector('button'));
    finish(JSON.stringify(await report('win32', Date.now() + 1000))); await loading;
    assert.equal(replacement.getAttribute('aria-busy'), 'false');
    assert.match(replacement.textContent, /4건 \/ 24시간/);
    assert.match(replacement.textContent, /예제 DEMO/);
    assert.ok(document.activeElement === replacement.querySelector('button'));
  });
});

test('host freshness starts with the rendered signature and updates all source time states', async t => {
  await withDocument(async () => {
    const previousWindow = globalThis.window;
    let now = T, tick;
    t.mock.method(Date, 'now', () => now);
    globalThis.window = { location:{ pathname:'/' }, setInterval(fn) { tick = fn; return 1; }, clearInterval() {}, addEventListener() {} };
    try {
      const latest = normalizeHostObservation(await report('win32', T + 24_000), T);
      const state = { pending:false, latest, history:[], error:null, requestId:0 };
      const root = hostPanel(state, 'disconnected'); document.body.append(root);
      const network = () => root.find(el => el.getAttribute('data-host-card') === 'network');
      const initial = network(); now = T + 15_000; tick();
      assert.ok(network() === initial, 'the first unchanged timer tick must not rebuild the view');
      now = T + 30_000; tick(); assert.match(network().textContent, /1개 인터페이스/);
      now = T + 24_000 + 15 * 60_000 + 1; tick(); assert.match(network().textContent, /오래된 보고서 또는 원천/);
    } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
  });
});

test('host timer updates DNS detail freshness while its network aggregate is already stale', async t => {
  await withDocument(async () => {
    const previousWindow = globalThis.window;
    let now = T + 885_000, tick;
    t.mock.method(Date, 'now', () => now);
    globalThis.window = { location:{ pathname:'/' }, setInterval(fn) { tick = fn; return 1; }, clearInterval() {}, addEventListener() {} };
    try {
      const raw = await report('win32', T);
      raw.network.measuredAt = raw.network.parts.interfaces.measuredAt = new Date(T - 20_000).toISOString();
      raw.network.parts.dns.measuredAt = new Date(T - 5000).toISOString();
      const latest = normalizeHostObservation(raw, now);
      const root = hostPanel({ pending:false, latest, history:[], error:null, requestId:0 }, 'disconnected');
      document.body.append(root);
      const dnsLine = () => root.find(node => node.tagName === 'P' && node.textContent.startsWith('DNS resolver ·'));
      assert.equal(hostReportQuality(latest, now).feeds.network.freshness, 'stale');
      assert.match(dnsLine().textContent, /^DNS resolver · 조회됨/);
      now = T + 900_000; tick();
      const quality = hostReportQuality(latest, now);
      assert.equal(quality.freshness, 'recent');
      assert.equal(quality.feeds.network.freshness, 'stale');
      assert.match(dnsLine().textContent, /^DNS resolver · 과거 또는 시각 미확인/);
    } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
  });
});

test('Windows event envelope failure already includes specific next-step guidance in the host UI', async () => {
  await withDocument(async () => {
    const raw = await report('win32', Date.now()); raw.windowsEvents.status = 'unavailable';
    const latest = normalizeHostObservation(raw);
    const root = hostPanel({ pending:false, latest, history:[], error:null, requestId:0 }, 'disconnected');
    assert.match(root.textContent, /Windows 이벤트 집계 형식이 잘못됐습니다\. 수집기로 새 보고서를 생성하세요\./);
    assert.match(root.textContent, /1개 인터페이스/);
    assert.doesNotMatch(root.textContent, /4건 \/ 24시간/);
  });
});
