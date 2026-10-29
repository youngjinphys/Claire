import {
  appendSample, appendGap, trendSummary, normalizeSnapshot, normalizeSecurity, normalizeEvents,
  HISTORY_WINDOW_MS, MAX_MEASUREMENT_AGE_MS,
} from '/dashboard-model.mjs';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const REASONS = Object.freeze({
  NOT_STARTED: '측정을 시작하지 않았습니다.',
  CPU_SAMPLE_UNAVAILABLE: 'CPU 누적 시간이 충분히 변하지 않아 사용률을 계산할 수 없습니다.',
  CPU_INTERVAL_INVALID: 'CPU 측정 구간의 단조시계·측정 시각을 확인할 수 없습니다.',
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
  return new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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

function headerClock() { set('header-clock', new Date().toLocaleString('ko-KR', { hour12: false })); }
headerClock();

async function fetchJson(path, controller) {
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw Error('BAD_RESPONSE');
    const body = await response.json();
    return body && typeof body === 'object' ? body : { ok: false, error: { code: 'LOCAL_FETCH_FAILED' }, meta: { mode: 'unknown' } };
  } finally {
    clearTimeout(timeout);
  }
}

function updateControls() {
  $('start').disabled = observing;
  $('stop').disabled = !observing;
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
  set(key + '-time', stamp ? dateText(stamp) : '미측정');
  titleIso($(key + '-time'), stamp);
  const reason = !metric ? 'NOT_STARTED' : metric.status !== 'ok' ? metric.reason
    : !valid ? 'MEASUREMENT_STALE' : null;
  set(key + '-reason', reason ? reasonText(reason) : observing ? '현재 관측 · OS 원천' : '마지막 실측 · 관측 중지');
  if (key === 'cpu') set('cpu-detail', valid ? '두 OS 표본의 간격 ' + safeDuration(metric.windowMs) + ' · 시스템 전체 CPU' : '두 시점의 OS 누적 시간 차이');
  if (key === 'memory') set('memory-detail', valid
    ? '사용 ' + metric.usedGiB.toFixed(2) + ' / 총 ' + metric.totalGiB.toFixed(2) + ' GiB · free 기준'
    : 'os.freemem 기준 · OS별 캐시 처리 방식이 다름');
  if (key === 'disk') set('disk-detail', '앱 폴더가 위치한 파일시스템의 일반 사용자 사용 가능 공간');
}

function showSecurity() {
  const info = latestSecurity;
  const card = $('security-card');
  const mode = info?.mode || 'unknown';
  const isDemo = info?.status === 'ok' && mode === 'demo';
  const fresh = info?.checkedAt && Date.now() - Date.parse(info.checkedAt) <= MAX_MEASUREMENT_AGE_MS
    && Date.parse(info.checkedAt) - Date.now() <= 1000;
  const recognized = info?.status === 'ok' && fresh;
  const state = recognized && !isDemo && info.value !== 'unknown' ? 'ok' : isDemo ? 'demo' : 'unavailable';
  card.dataset.state = state;
  const labels = { compliant: '기준 충족', noncompliant: '기준 미충족', unknown: '확인 불가' };
  set('security-value', recognized ? labels[info.value] : '확인 불가');
  set('security-source', isDemo ? '예제 DEMO' : mode === 'connected' ? 'SDP 원천 조회' : 'SDP 미연결');
  set('security-detail', '제공 기기 보안 상태 · 정책 코드' + (recognized ? ' ' + info.value : ''));
  set('security-time', info?.checkedAt ? dateText(info.checkedAt) : '미조회');
  titleIso($('security-time'), info?.checkedAt);
  set('security-reason', !info ? reasonText('NOT_STARTED') : info.status === 'ok' && !fresh ? reasonText('SECURITY_STALE')
    : isDemo ? '가상 기기 상태입니다. 실제 PC 보안 판정이 아닙니다.'
    : recognized && info.value === 'unknown' ? 'SDP가 기기 상태를 알 수 없다고 응답했습니다.'
    : recognized ? 'SDP 제공 상태이며 CPU·메모리 상태를 뜻하지 않습니다.'
    : reasonText(info?.reason || 'SECURITY_LOOKUP_FAILED'));
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
    { key: 'memory', color: '#7faaff' },
  ];
  const t0 = now - HISTORY_WINDOW_MS;
  const x = time => left + Math.max(0, Math.min(1, (time - t0) / HISTORY_WINDOW_MS)) * (right - left);
  const y = value => bottom - value / 100 * (bottom - top);
  for (const item of chartSeries) {
    let points = [];
    const flush = () => {
      if (points.length >= 2) plot.append(svg('polyline', {
        points: points.join(' '), fill: 'none', stroke: item.color,
        'stroke-width': 2.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
      else if (points.length === 1) {
        const [cx, cy] = points[0].split(','); plot.append(svg('circle', { cx, cy, r: 3, fill: item.color }));
      }
      points = [];
    };
    for (const point of history) {
      if (typeof point[item.key] === 'number' && Number.isFinite(point[item.key])) points.push(x(point.time).toFixed(2) + ',' + y(point[item.key]).toFixed(2));
      else flush();
    }
    flush();
  }
  const trend = trendSummary(history);
  $('chart-empty').hidden = trend !== null;
  set('sample-count', history.length + '개');
  set('last-sample', history.length ? dateText(new Date(history.at(-1).time).toISOString()) : '없음');
  if (!trend) {
    set('trend-headline', '표본 대기');
    set('trend-copy', 'CPU와 메모리 각각 유효 표본 2개 이상이 있어야 비교할 수 있습니다. 측정 실패와 미측정 구간은 0%로 채우지 않습니다.');
    return;
  }
  const signed = n => (n > 0 ? '+' : '') + n.toFixed(1);
  set('trend-headline', 'CPU ' + signed(trend.cpuDelta) + ' %p');
  set('trend-copy', '메모리 ' + signed(trend.memoryDelta) + ' %p · 최근 10분 내 실측 CPU ' + trend.cpuSamples + '개, 메모리 ' + trend.memorySamples + '개. 변화 폭은 관측값 차이이며 보안 위협이나 원인을 추정하지 않습니다.');
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
  const token = ++eventGeneration;
  activeEventRequest?.abort();
  const controller = new AbortController();
  activeEventRequest = controller;
  const read = async path => {
    try { return await fetchJson(path, controller); }
    catch { return { ok: false, error: { code: 'LOCAL_FETCH_FAILED' }, meta: { mode: 'unknown' } }; }
  };
  const [identity, events] = await Promise.all([read('/api/me'), read('/api/events')]);
  if (token !== eventGeneration) return;
  latestSecurity = normalizeSecurity(identity);
  latestEvents = normalizeEvents(events);
  showSecurity();
  redrawEvents();
}

async function measureOnce() {
  if (busy) return;
  busy = true;
  updateControls();
  const token = generation;
  const controller = new AbortController();
  activeRequest = controller;
  try {
    const response = await fetchJson('/api/local-pc', controller);
    if (token !== generation) return;
    const snapshot = normalizeSnapshot(response);
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
  } catch {
    if (token !== generation) return;
    latestSnapshot = { status: 'error', reason: 'LOCAL_FETCH_FAILED' };
    if (observing) observing = false;
    for (const key of ['cpu', 'memory', 'disk']) showMetric(key, { metrics: { [key]: { reason: latestSnapshot.reason } } });
    history = appendGap(history);
    renderChart();
    set('page-notice', reasonText('LOCAL_FETCH_FAILED') + ' · 이전 값을 정상 측정으로 표시하지 않습니다.');
  } finally {
    if (token === generation) {
      busy = false;
      activeRequest = null;
      updateControls();
      if (observing) scheduled = setTimeout(measureOnce, 5000);
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
freshnessTimer = setInterval(() => {
  headerClock();
  if (latestSnapshot?.status === 'ok') for (const key of ['cpu','memory','disk']) showMetric(key, latestSnapshot);
  if (latestSecurity) showSecurity();
  if (latestEvents.status === 'ok') redrawEvents();
  renderChart();
}, 10000);

$('start').addEventListener('click', () => {
  if (observing) return;
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
  if (!observing) { generation += 1; void measureOnce(); }
});
$('refresh-security').addEventListener('click', () => { void refreshSecurity(); });
$('event-filter').addEventListener('change', redrawEvents);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && observing) stopObserving('브라우저 탭이 숨겨져 관측을 중지했습니다. 재개하려면 관측 시작을 누르세요.');
});
window.addEventListener('pagehide', () => {
  generation += 1;
  eventGeneration += 1;
  activeRequest?.abort();
  activeEventRequest?.abort();
  if (scheduled) clearTimeout(scheduled);
  if (freshnessTimer) clearInterval(freshnessTimer);
});

updateControls();
for (const key of ['cpu', 'memory', 'disk']) showMetric(key, null);
showSecurity();
renderChart();
void refreshSecurity();
