import {
  appendSample, appendGap, trendSummary, normalizeSnapshot, normalizeSecurity, normalizeEvents,
  HISTORY_WINDOW_MS, MAX_MEASUREMENT_AGE_MS, seriesSegments, pairedSamples,
  requestDashboardJson, exportMeasurements,
} from '/dashboard-model.mjs';
import { hostPanel } from '/student/extension.mjs';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const REASONS = Object.freeze({
  NOT_STARTED: '측정을 시작하지 않았습니다.',
  CPU_SAMPLE_UNAVAILABLE: 'CPU 누적 시간이 충분히 변하지 않아 사용률을 계산할 수 없습니다.',
  CPU_INTERVAL_INVALID: 'CPU 측정 구간의 단조시계·측정 시각을 확인할 수 없습니다.',
  CPU_READ_TIMEOUT: 'CPU 측정이 제한 시간 안에 끝나지 않았습니다.',
  DISK_READ_TIMEOUT: '디스크 조회 시간이 초과됐습니다. 다른 정상 측정값은 유지합니다.',
  DISK_READ_IN_PROGRESS: '앞선 디스크 조회가 OS에서 아직 끝나지 않았습니다. 자동 재요청하지 않습니다.',
  DISK_PERMISSION_DENIED: '일반 사용자 권한으로 디스크 정보를 읽지 못했습니다. 권한 상승은 하지 않습니다.',
  DISK_UNSUPPORTED: '현재 운영체제가 이 파일시스템의 조회를 지원하지 않습니다.',
  CPU_READ_FAILED: 'CPU 사용 시간을 읽지 못했습니다(일반 권한 또는 OS API 확인).',
  MEMORY_READ_FAILED: '운영체제의 메모리 정보를 읽지 못했습니다.',
  MEMORY_INVALID: '운영체제 메모리 값의 형식 또는 범위를 검증할 수 없습니다.',
  DISK_READ_FAILED: '앱 파일시스템의 사용 가능 블록 정보를 읽지 못했습니다.',
  DISK_INVALID: '디스크 응답 값의 범위를 검증할 수 없습니다.',
  PC_MEASUREMENT_RESPONSE_INVALID: 'PC 측정 API 응답을 확인할 수 없습니다.',
  MEASUREMENT_CONTRACT_INVALID: '측정값의 단위·출처·시각을 검증할 수 없습니다.',
  MEASUREMENT_INVALID: '측정값의 유효 범위를 확인할 수 없습니다.',
  MEASUREMENT_UNAVAILABLE: '측정 결과를 확인할 수 없습니다.',
  SOURCE_MODE_UNVERIFIED: '조회 결과의 연결 출처를 확인할 수 없습니다.',
  ENGINE_NOT_CONNECTED: '기존 SDP 보안 엔진이 연결되지 않았습니다.',
  DEVICE_STATUS_UNVERIFIED: '현재 기기의 보안 상태를 검증할 수 없습니다.',
  SECURITY_LOOKUP_FAILED: '기기 보안 정보 조회에 실패했습니다.',
  EVENT_LOOKUP_FAILED: '보안 기록 조회에 실패했습니다.',
  EVENT_RESPONSE_INVALID: '보안 기록의 응답 형식을 검증할 수 없습니다.',
  RESPONSE_TOO_LARGE: '응답 크기가 허용 범위를 넘었습니다. 일부만 정상으로 표시하지 않습니다.',
  RESPONSE_CONTRACT_INVALID: 'HTTP 응답의 형식을 검증할 수 없습니다.',
  LOCAL_FETCH_FAILED: '로컬 서버에 접속할 수 없거나 요청 시간이 초과됐습니다.',
  MEASUREMENT_STALE: '이 값은 오래된 관측입니다. 새 측정이 필요합니다.',
  MEASUREMENT_TIME_INVALID: '센서의 관측 시각과 응답 시각이 일치하지 않습니다.',
  DISK_SCOPE_UNVERIFIED: '디스크 측정 대상 파일시스템이 확인되지 않았습니다.',
  SECURITY_STALE: '보안 상태 조회 시각이 오래됐습니다. 기록을 직접 재조회하세요.',
});
const reasonText = reason => REASONS[reason] || (typeof reason === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(reason)
  ? '조회가 실패했습니다. 상태 코드: ' + reason : '측정값의 원인 정보를 확인할 수 없습니다.');
const dateText = iso => {
  if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) return '시각 확인 불가';
  return new Date(iso).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', timeZoneName: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const titleIso = (element, iso) => { element.title = typeof iso === 'string' ? iso : ''; };
const set = (id, value) => { $(id).textContent = String(value); };
const safeDuration = (ms) => Number.isFinite(ms) ? Math.round(ms) + ' ms' : '확인 불가';

let latestSnapshot = null;
let latestSecurity = null;
let latestEvents = { status: 'unavailable', reason: 'NOT_STARTED', mode: 'unknown', events: [] };
let history = [];
let observing = false;
let busy = false;
let generation = 0;
let eventGeneration = 0;
let activeRequest = null;
let activeEventRequest = null;
let scheduled = null;
let freshnessTimer = null;

// One host-report reader, shared with the provided student expansion. The OS
// collector is an explicit user-launched CLI, NOT an HTTP endpoint or background scan.
const hostState = { pending: false, latest: null, history: [], error: null, requestId: 0 };
let displayedHostMode = null;

function renderHostObservation(mode) {
  const normalizedMode = ['connected', 'demo', 'disconnected'].includes(mode) ? mode : 'unknown';
  if (displayedHostMode === normalizedMode) return;
  const panel = hostPanel(hostState, normalizedMode);
  const details = panel.querySelector('[data-host-report-details]');
  if (details) {
    $('host-report-content').replaceChildren(details);
  } else {
    const notice = document.createElement('p');
    notice.textContent = '보고서 상세 연결을 확인할 수 없습니다. 기존 Claire 화면에서 보고서를 선택해 확인하세요.';
    $('host-report-content').replaceChildren(notice);
  }
  $('integrated-host-root').replaceChildren(panel);
  displayedHostMode = normalizedMode;
}

function headerClock() { set('header-clock', new Date().toLocaleString('ko-KR', { hour12: false })); }
headerClock();

async function fetchJson(path, controller) {
  return requestDashboardJson(path, { signal: controller.signal, fetchImpl: fetch });
}

function updateControls() {
  $('start').disabled = observing || busy;
  $('stop').disabled = !observing && !busy;
  $('sample-once').disabled = observing || busy;
  document.body.dataset.running = String(observing);
  set('live-state', observing ? '실측 진행 중' : busy ? '측정 중' : latestSnapshot ? '관측 중지 · 마지막 값' : '관측 대기');
}

function showMetric(key, snapshot) {
  const element = $(key + '-card');
  const metric = snapshot?.metrics?.[key];
  const valid = metric?.status === 'ok' && Date.now() - Date.parse(metric.measuredAt) <= MAX_MEASUREMENT_AGE_MS
    && Date.parse(metric.measuredAt) - Date.now() <= 1000;
  element.dataset.state = valid ? 'ok' : 'unavailable';
  set(key + '-value', valid ? metric.value.toFixed(key === 'disk' ? 2 : 1) : '확인 불가');
  set(key + '-unit', key === 'disk' ? 'GiB' : '%');
  const stamp = metric?.measuredAt || null;
  set(key + '-time', stamp ? (metric.status === 'ok' ? '' : '조회 시도 ') + dateText(stamp) : '미측정');
  titleIso($(key + '-time'), stamp);
  const reason = !metric ? 'NOT_STARTED' : metric.status !== 'ok' ? metric.reason
    : !valid ? 'MEASUREMENT_STALE' : null;
  set(key + '-reason', reason ? reasonText(reason) : observing ? '현재 관측 · OS 원천' : '마지막 실측 · 관측 중지');
  if (key === 'cpu') set('cpu-detail', valid ? '두 OS 표본의 간격 ' + safeDuration(metric.windowMs) + ' · 시스템 전체 CPU' : '두 시점의 OS 누적 시간 차이');
  if (key === 'memory') set('memory-detail', valid
    ? '사용 ' + metric.usedGiB.toFixed(2) + ' / 총 ' + metric.totalGiB.toFixed(2) + ' GiB · free 기준'
    : 'os.freemem 기준 · OS별 캐시 처리 방식이 다름');
  if (key === 'disk') set('disk-detail', '앱 파일시스템의 OS 보고 여유 공간 · 할당량/네트워크 드라이브 예외 별도');
}

function showSecurity() {
  const info = latestSecurity;
  const mode = info?.mode || 'unknown';
  renderHostObservation(mode);
  const checkedAt = info?.checkedAt;
  const current = typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt))
    && Date.now() - Date.parse(checkedAt) <= MAX_MEASUREMENT_AGE_MS
    && Date.parse(checkedAt) - Date.now() <= 1000;
  const labels = { compliant: '기준 충족', noncompliant: '기준 미충족', unknown: '확인 불가' };
  const sessions = { active: '활성', expired: '만료', revoked: '철회', unknown: '확인 불가' };
  const time = checkedAt ? dateText(checkedAt) : '조회 시각 확인 불가';
  let description;
  if (mode === 'demo') {
    description = 'SDP 예제 DEMO · 실제 보안 정책 판정이 아닙니다. ' + time;
  } else if (mode === 'disconnected') {
    description = 'SDP 미연결 · PC 자원 측정이나 로컬 보고서 조회 성공과 무관합니다. ' + time;
  } else if (mode !== 'connected') {
    description = 'SDP 연결 확인 불가 · 원천 응답을 검증할 수 없습니다.';
  } else if (info?.status !== 'ok' || !current) {
    description = 'SDP 어댑터 연결 구성 · 정책 결과 확인 불가. '
      + (current ? reasonText(info?.reason || 'SECURITY_LOOKUP_FAILED') : reasonText('SECURITY_STALE'))
      + ' · ' + time;
  } else {
    description = 'SDP 기기 정책 ' + labels[info.value]
      + ' · 세션 ' + sessions[info.sessionStatus] + ' · 조회 ' + time
      + ' · 이 값은 원천 정책 보고이며 OS 전체의 안전을 뜻하지 않습니다.';
  }
  set('sdp-policy-detail', description);
}

function svg(tag, attrs = {}, label = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (label !== null) el.textContent = label;
  return el;
}

function renderChart() {
  const plot = $('resource-chart');
  plot.replaceChildren();
  const left = 36, top = 16, right = 901, bottom = 232;
  const now = Date.now();
  history = history.filter(point => point.time >= now - HISTORY_WINDOW_MS && point.time <= now + 1000);
  for (const percent of [0, 25, 50, 75, 100]) {
    const y = bottom - percent / 100 * (bottom - top);
    plot.append(svg('line', { x1: left, y1: y, x2: right, y2: y, stroke: 'rgba(164,195,223,.16)', 'stroke-dasharray': percent ? '3 6' : 'none' }));
    plot.append(svg('text', { x: 2, y: y + 4, fill: '#8195ae', 'font-size': 12 }, percent + '%'));
  }
  const chartSeries = [
    { key: 'cpu', color: '#85efd7' },
    { key: 'memory', color: '#7faaff', dash: '7 5' },
  ];
  const t0 = now - HISTORY_WINDOW_MS;
  const x = time => left + Math.max(0, Math.min(1, (time - t0) / HISTORY_WINDOW_MS)) * (right - left);
  const y = value => bottom - value / 100 * (bottom - top);
  for (const item of chartSeries) {
    for (const segment of seriesSegments(history, item.key)) {
      const points = segment.map(point => x(point.time).toFixed(2) + ',' + y(point.value).toFixed(2));
      if (points.length >= 2) {
        plot.append(svg('polyline', {
          points: points.join(' '), fill: 'none', stroke: item.color,
          'stroke-dasharray': item.dash || 'none', 'stroke-width': 2.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }));
      } else if (points.length === 1) {
        const [cx, cy] = points[0].split(',');
        plot.append(svg('circle', { cx, cy, r: 3, fill: item.color }));
      }
    }
  }
  renderMeasurementRecords();
  const trend = trendSummary(history);
  $('chart-empty').hidden = ['cpu', 'memory'].some(key => seriesSegments(history, key).length > 0);
  const verified = pairedSamples(history);
  set('sample-count', verified.length + '개');
  set('last-sample', verified.length ? dateText(new Date(verified.at(-1).time).toISOString()) : '없음');
  if (!trend) {
    set('trend-headline', '표본 대기');
    set('trend-copy', 'CPU와 메모리 각각 유효 표본 2개 이상이 있어야 비교할 수 있습니다. 측정 실패와 미측정 구간은 0%로 채우지 않습니다.');
    return;
  }
  const signed = n => (n > 0 ? '+' : '') + n.toFixed(1);
  set('trend-headline', 'CPU ' + signed(trend.cpuDelta) + ' %p');
  set('trend-copy', '메모리 ' + signed(trend.memoryDelta) + ' %p · 최근 10분 내 실측 CPU ' + trend.cpuSamples + '개, 메모리 ' + trend.memorySamples + '개. 비교 구간 ' + dateText(new Date(trend.from).toISOString()) + ' → ' + dateText(new Date(trend.to).toISOString()) + '. 보안 위협이나 원인 판정이 아닙니다.');
}

let lastRenderedHistoryPoint = null;
let lastRenderedHistoryLength = -1;

function renderMeasurementRecords(force = false) {
  const currentLast = history.length > 0 ? history[history.length - 1].time : null;
  if (!force && lastRenderedHistoryLength === history.length && lastRenderedHistoryPoint === currentLast) return;
  lastRenderedHistoryLength = history.length;
  lastRenderedHistoryPoint = currentLast;

  const target = $('measurement-body');
  target.replaceChildren();
  $('export-measurements').disabled = history.length === 0;
  set('measurement-note', '최근 10분 이 탭 기록 ' + history.length + '개 · 화면은 최근 20개, JSON은 보관 중인 전체(최대 120개) · 계정/보안 로그 제외');
  const rows = history.slice(-20).reverse();
  if (!rows.length) {
    const row = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = 5; cell.textContent = '관측 기록 없음 · 예시 수치를 채우지 않습니다.';
    row.append(cell); target.append(row); return;
  }
  for (const point of rows) {
    const row = document.createElement('tr'), stamp = document.createElement('td');
    stamp.textContent = dateText(new Date(point.time).toISOString());
    row.append(stamp);
    if (!point.metrics) {
      const gap = document.createElement('td'); gap.colSpan = 4;
      gap.textContent = '관측 중단/실패 구간 · 사용률 0%가 아닙니다.'; row.append(gap);
    } else {
      for (const key of ['cpu', 'memory', 'disk']) {
        const metric = point.metrics[key], cell = document.createElement('td');
        const value = document.createElement('div');
        value.textContent = metric?.status === 'ok' ? metric.value.toFixed(key === 'disk' ? 2 : 1) + ' ' + metric.unit
          : '확인 불가 · ' + reasonText(metric?.reason);
        const time = document.createElement('time');
        if (metric?.measuredAt) { time.dateTime = metric.measuredAt; time.title = metric.measuredAt; }
        time.textContent = metric?.measuredAt ? (metric.status === 'ok' ? '' : '조회 시도 ') + dateText(metric.measuredAt) : '측정 시각 없음';
        cell.append(value, time); row.append(cell);
      }
      const source = document.createElement('td'); source.textContent = 'PC 실측 · Node OS 원천'; row.append(source);
    }
    target.append(row);
  }
}
function downloadMeasurements() {
  if (!history.length) return;
  const data = exportMeasurements(history);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'claire-measurements-' + Date.now() + '.json';
  document.body.append(anchor); anchor.click(); anchor.remove();
  // Revoke after the browser has had a chance to start the user-requested download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function redrawEvents() {
  const data = latestEvents;
  const mode = data.mode;
  set('events-origin', mode === 'demo' ? '예제 DEMO · 실제 사건 아님'
    : mode === 'connected' ? 'SDP 본인 기록' : '원천 연결 없음');
  const body = $('events-body');
  body.replaceChildren();
  if (data.status !== 'ok') {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = '확인 불가 — ' + reasonText(data.reason || 'EVENT_LOOKUP_FAILED');
    tr.append(td); body.append(tr);
    set('events-note', '기록을 읽지 못했습니다. 빈 기록이나 안전 상태로 간주하지 않습니다.' + (data.checkedAt ? ' · 조회 ' + dateText(data.checkedAt) : ''));
    return;
  }
  const selected = $('event-filter').value;
  const items = data.events.filter(row => selected === 'all' || row.kind === selected);
  set('events-note', '받은 기록 ' + data.events.length + '건 중 ' + items.length + '건 표시 · '
    + (mode === 'demo' ? '전부 설명용 예제' : '본인 범위 최대 40건')
    + (data.total !== null ? ' · 원천 전체 ' + data.total + '건' + (data.truncated ? ' (나머지 생략)' : '') : '')
    + ' · 마지막 조회 ' + (data.checkedAt ? dateText(data.checkedAt) : '시각 확인 불가')
    + (data.checkedAt && Date.now() - Date.parse(data.checkedAt) > MAX_MEASUREMENT_AGE_MS ? ' · 조회 오래됨 (수동 재조회 필요)' : ''));
  if (!items.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 5; td.textContent = '표시할 기록이 없습니다. 전체 환경에 사건이 없다는 뜻은 아닙니다.';
    tr.append(td); body.append(tr); return;
  }
  for (const row of items) {
    const tr = document.createElement('tr');
    const eventTime = document.createElement('time'); eventTime.dateTime = row.at; eventTime.textContent = dateText(row.at);
    const cells = [eventTime, row.kind === 'xdr' ? 'XDR' : '접속', row.id, row.summary || '요약 없음', row.appId || '확인 불가'];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      if (i === 0) td.append(cells[i]);
      else if (i === 1) {
        const tag = document.createElement('span'); tag.className = 'event-tag' + (row.kind === 'xdr' ? ' xdr' : ''); tag.textContent = cells[i]; td.append(tag);
      } else td.textContent = cells[i];
      tr.append(td);
    }
    body.append(tr);
  }
}

async function refreshSecurity() {
  $('refresh-security').disabled = true;
  set('events-note', '기록 재조회 중 · 이전 값은 마지막 조회 결과입니다.');
  const token = ++eventGeneration;
  activeEventRequest?.abort();
  const controller = new AbortController();
  activeEventRequest = controller;
  const read = async path => {
    const requestedAt = Date.now();
    let response;
    try { response = await fetchJson(path, controller); }
    catch { response = { ok: false, error: { code: 'LOCAL_FETCH_FAILED' }, meta: { mode: 'unknown' } }; }
    return { response, timing: { requestedAt, receivedAt: Date.now() } };
  };
  const [identity, events] = await Promise.all([read('/api/me'), read('/api/events')]);
  if (token !== eventGeneration) return;
  activeEventRequest = null;
  $('refresh-security').disabled = false;
  latestSecurity = normalizeSecurity(identity.response);
  latestEvents = normalizeEvents(events.response, events.timing);
  showSecurity();
  redrawEvents();
}

async function measureOnce() {
  if (busy) return;
  busy = true;
  updateControls();
  const token = generation;
  const startedMono = performance.now();
  const controller = new AbortController();
  activeRequest = controller;
  try {
    const requestedAt = Date.now();
    const response = await fetchJson('/api/local-pc', controller);
    const receivedAt = Date.now();
    if (token !== generation) return;
    const snapshot = normalizeSnapshot(response, { requestedAt, receivedAt });
    latestSnapshot = snapshot.status === 'ok' ? snapshot : { status: 'error', reason: snapshot.reason };
    history = snapshot.status === 'ok' ? appendSample(history, snapshot) : appendGap(history);
    // A failed read is not permission to retry. The user must explicitly restart monitoring.
    const unreliable = snapshot.status !== 'ok' || snapshot.status === 'ok'
      && (Math.abs(Date.now() - Date.parse(snapshot.checkedAt)) > 30000
        || ['cpu','memory','disk'].some(key => snapshot.metrics[key]?.status !== 'ok'));
    if (unreliable && observing) observing = false;
    for (const key of ['cpu', 'memory', 'disk']) showMetric(key, latestSnapshot.status === 'ok' ? latestSnapshot : { metrics: { [key]: { reason: latestSnapshot.reason } } });
    renderChart();
    set('page-notice', snapshot.status === 'ok'
      ? 'PC 실측 · ' + dateText(snapshot.checkedAt) + ' · 각 카드에는 독립된 측정 시각과 단위를 표시합니다. 기기 보안 상태는 SDP 원천 조회입니다.'
        + (unreliable ? ' · 일부 측정 실패 또는 시각 불일치: 관측 중단, 사용자가 다시 시작해야 합니다.' : '')
      : 'PC 측정 실패: ' + reasonText(snapshot.reason) + ' · 자동 재시도하지 않습니다.');
  } catch (error) {
    if (token !== generation) return;
    const reason = ['RESPONSE_TOO_LARGE', 'RESPONSE_CONTRACT_INVALID'].includes(error?.message) ? error.message : 'LOCAL_FETCH_FAILED';
    latestSnapshot = { status: 'error', reason };
    if (observing) observing = false;
    for (const key of ['cpu', 'memory', 'disk']) showMetric(key, { metrics: { [key]: { reason: latestSnapshot.reason } } });
    history = appendGap(history);
    renderChart();
    set('page-notice', reasonText(reason) + ' · 이전 값을 정상 측정으로 표시하지 않습니다.');
  } finally {
    if (token === generation) {
      busy = false;
      activeRequest = null;
      updateControls();
      if (observing) scheduled = setTimeout(measureOnce, Math.max(0, 5000 - (performance.now() - startedMono)));
    }
  }
}

function stopObserving(message = '관측이 중지됐습니다. 이전 측정값은 마지막 실측으로만 표시합니다.') {
  observing = false;
  generation += 1;
  if (scheduled) clearTimeout(scheduled);
  scheduled = null;
  activeRequest?.abort();
  busy = false;
  updateControls();
  if (latestSnapshot?.status === 'ok') for (const key of ['cpu','memory','disk']) showMetric(key, latestSnapshot);
  set('page-notice', message);
}

// Repaint stale markers locally without polling the OS, SDP, or AI; this is not an automatic retry.
function startFreshnessTimer() {
  if (freshnessTimer !== null) clearInterval(freshnessTimer);
  freshnessTimer = setInterval(() => {
  headerClock();
  if (latestSnapshot?.status === 'ok') for (const key of ['cpu','memory','disk']) showMetric(key, latestSnapshot);
  if (latestSecurity) showSecurity();
  // Repaint freshness without replacing the rows on every tick.
  if (latestEvents.status === 'ok' && latestEvents.checkedAt) {
    $('events-origin').textContent = (latestEvents.mode === 'demo' ? '예제 DEMO · 실제 사건 아님' : 'SDP 본인 기록')
      + (Date.now() - Date.parse(latestEvents.checkedAt) > MAX_MEASUREMENT_AGE_MS ? ' · 조회 오래됨' : '');
  }
  renderChart();
  }, 1000);
}
startFreshnessTimer();

$('start').addEventListener('click', () => {
  if (observing || busy) return;
  // A new user-initiated observation session must never join an earlier stopped interval.
  if (history.length) history = appendGap(history);
  observing = true;
  generation += 1;
  updateControls();
  renderChart();
  set('page-notice', '실제 PC 자원 측정 중 · 최초 CPU 사용률을 얻기 위해 두 OS 표본을 관측합니다.');
  void measureOnce();
});
$('stop').addEventListener('click', () => stopObserving());
$('sample-once').addEventListener('click', () => {
  if (!observing && !busy) { generation += 1; void measureOnce(); }
});
$('refresh-security').addEventListener('click', () => { void refreshSecurity(); });
$('event-filter').addEventListener('change', redrawEvents);
$('export-measurements').addEventListener('click', downloadMeasurements);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (observing || busy)) stopObserving('브라우저 탭이 숨겨져 관측을 중지했습니다. 재개하려면 관측 시작을 누르세요.');
});
window.addEventListener('pagehide', () => {
  stopObserving('페이지를 떠나 관측을 중지했습니다. 복원 후에는 직접 다시 시작하세요.');
  eventGeneration += 1;
  activeRequest?.abort();
  activeEventRequest?.abort();
  activeEventRequest = null;
  $('refresh-security').disabled = false;
  if (scheduled) clearTimeout(scheduled);
  if (freshnessTimer !== null) clearInterval(freshnessTimer);
  freshnessTimer = null;
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  // BFCache restores the existing module, not a new initialization. Reset local
  // controls/timers only; never poll, re-authorize, or resume measurement here.
  updateControls();
  startFreshnessTimer();
  for (const key of ['cpu', 'memory', 'disk']) if (latestSnapshot?.status === 'ok') showMetric(key, latestSnapshot);
  showSecurity();
  renderChart();
});

updateControls();
for (const key of ['cpu', 'memory', 'disk']) showMetric(key, null);
showSecurity();
renderChart();
void refreshSecurity();