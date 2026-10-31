import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectHostObservation } from '../student/collect-host.mjs';
import { normalizeHostObservation, hostComparison, hostPanel, hostReportQuality, buildClaireHostAggregateEvidence } from '../student/extension.mjs';

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
    const button = root.find(el => el.tagName === 'BUTTON' && el.textContent.includes('비식별 집계'));
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
  assert.equal(output.measurements.networkInterfaces.value, null);
  const json = JSON.stringify(output);
  assert.doesNotMatch(json, /private-address-secret|SENSITIVE_PAYLOAD/);
})

test('local report rejects non-IP interface and DNS strings instead of displaying fake network addresses', async () => {
  const original = await report('win32', T);
  for (const address of ['999.999.999.999', '127.0.0.999', '1.2.3.04', '2001:db8:::1']) {
    const changed = structuredClone(original);
    changed.network.interfaces[0].addresses[0].address = address;
    assert.equal(normalizeHostObservation(changed, T).network.status, 'unavailable', address);
  }
  for (const resolver of ['bad:ipv6', '999.999.999.999', '[::1]:70000']) {
    const changed = structuredClone(original);
    changed.network.dns = [resolver];
    assert.equal(normalizeHostObservation(changed, T).network.status, 'unavailable', resolver);
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
    assert.equal(original.find(el => el.tagName === 'BUTTON').disabled, true);
    const replacement = hostPanel(state,'disconnected');
    assert.equal(replacement.getAttribute('aria-busy'), 'true');
    finish(JSON.stringify(await report('win32', Date.now())));
    await reading;
    assert.equal(state.pending, false);
    assert.equal(state.error, null);
    assert.match(replacement.textContent, /4건 \/ 24시간/);
    assert.equal(replacement.find(el => el.tagName === 'BUTTON').disabled, false);
  });
});
