// 이 파일은 학생이 같은 프로젝트에서 이어서 구현합니다.
// 제공 UI를 받은 것만으로 단계 완료를 인정하지 않습니다.

const DEVICE_STATES = Object.freeze({
  compliant: '보안 기준 충족',
  noncompliant: '보안 기준 미충족',
  unknown: '확인 불가',
});

const SESSION_STATES = Object.freeze({
  active: '활성',
  expired: '만료',
  revoked: '철회됨',
  unknown: '확인 불가',
});

const ACCESS_STATES = Object.freeze({
  allowed: '접속 허용',
  denied: '접속 거부',
  unknown: '확인 불가',
});

const EVENT_KINDS = Object.freeze({
  access: '접속 기록',
  xdr: 'XDR 경보',
});

const DECISION_LABELS = Object.freeze({
  allow: '접근 허용(allow)',
  deny: '접근 거부(deny)',
  challenge: '추가 확인 필요(challenge)',
  unknown: '확인 불가(unknown)',
});

const SCAN_STATUS_LABELS = Object.freeze({
  complete: '모두 조회(complete) · 승인된 공개 조회 대상의 조회가 완료됐습니다.',
  partial: '일부 조회 실패(partial) · 확인된 결과만 표시하며 전체 조회 완료로 보지 않습니다.',
  not_checked: '아직 조회 안 함(not_checked) · 승인된 공개 조회 대상 패키지가 없습니다.',
  not_configured: '조회 준비 미완료(not_configured) · 조회 대상 프로젝트 설정이 필요합니다.',
  unverifiable: '잠금 파일 확인 불가(unverifiable) · 설치 목록과 버전을 검증할 수 없습니다.',
});

const PACKAGE_STATUS_LABELS = Object.freeze({
  known_vulnerabilities: '알려진 항목 있음(known_vulnerabilities)',
  none_found: '조회 범위에서 알려진 항목 없음(none_found)',
  unverifiable: '조회 확인 불가(unverifiable)',
});

const AI_ERROR_GUIDANCE = Object.freeze({
  ON_AI_PROVISIONING_PENDING: '학생 계정 연결 또는 앱 권한 발급이 준비 중입니다. 담당자에게 준비 상태를 확인하세요.',
  SUBJECT_SCOPE_UNVERIFIED: '현재 로그인·프로젝트 연결을 확인할 수 없습니다. 계정 연결을 다시 확인하고 담당자에게 문의하세요.',
  ON_AI_AUTHORIZATION_CHANGED: '점검 도중 앱 이용 권한이 변경됐습니다. 현재 계정과 권한을 담당자에게 확인하세요.',
  WB_CLCO_AUTH_REQUIRED: '앱 인증에 실패했습니다. 계정 연결을 확인하고 담당자에게 인증 상태를 문의하세요.',
  WB_CLCO_ACCESS_BLOCKED: '앱 접근 권한이 제한됐습니다. 담당자에게 앱 이용 권한을 확인하세요.',
  WB_CLCO_COHORT_BUDGET_EXHAUSTED: '반의 AI 사용량이 소진됐습니다. 담당자에게 이용 가능 여부를 확인하세요.',
  WB_CLCO_LIMIT_REACHED: 'AI 이용 한도에 도달했습니다. 담당자에게 한도를 확인하세요.',
  WB_CLCO_SESSION_CLOSED: '현재 AI 이용 시간이 아닙니다. 수업 이용 시간을 확인하세요.',
  WB_CLCO_RATE_LIMITED: 'AI 요청이 일시적으로 제한됐습니다. 잠시 뒤 직접 다시 점검하세요.',
  WB_CLCO_TIMEOUT: 'AI 응답 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
  REQUEST_TIMEOUT: '서버 AI 응답 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
  ENGINE_TIMEOUT: '서버 점검 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
  TIMEOUT: 'AI 점검 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
  WB_CLCO_CANCELLED: 'AI 점검이 취소됐습니다. 이전 응답은 현재 결과가 아닙니다.',
  CANCELLED: 'AI 점검이 취소됐습니다. 이전 응답은 현재 결과가 아닙니다.',
  REQUEST_CANCELLED: 'AI 점검이 취소됐습니다. 이전 응답은 현재 결과가 아닙니다.',
  ON_AI_MODEL_LIST_EMPTY: '현재 앱 권한으로 사용할 수 있는 모델이 없습니다. 담당자에게 모델 허용 설정을 확인하세요.',
  MODEL_NOT_CONFIGURED: 'AI 모델 설정이 없습니다. 담당자에게 모델 설정을 확인하세요.',
  ON_AI_INVALID_INPUT: 'AI 점검 요청의 입력을 확인할 수 없습니다. 담당자에게 계약 확인을 요청하세요.',
  ON_AI_INVALID_OUTPUT: 'AI 점검 결과의 형식을 확인할 수 없습니다. 성공으로 간주하지 않습니다.',
  AI_REQUEST_UNVERIFIED: 'AI 연결·네트워크 또는 응답을 확인할 수 없습니다. 연결 상태를 확인한 후 직접 재점검하세요.',
});

const ACTION_STATUS_MESSAGES = Object.freeze({
  idle: '아직 미실행(idle): 조치 준비 또는 집행을 요청하지 않았습니다.',
  loading: '조치 준비 또는 원천 결과 조회 중(loading) · 처리 완료나 효과 확인이 아닙니다.',
  prepared: '조치 준비됨·미실행(prepared): 실제 대상과 확인 기한을 검토해야 합니다.',
  executing: '사람 확인 후 서버에 전달 중(executing) · 접수 및 실제 효과는 아직 확인되지 않았습니다.',
  pending: '서버 접수·처리 중(pending) · ACK는 요청 접수 사실이며 조치 효과 확인이 아닙니다.',
  denied: '원천 정책에 따라 거절됨(denied) · 조치 효과를 확인한 상태가 아닙니다.',
  failed: '원천 처리 실패(failed) · 조치 효과를 확인하지 못했습니다.',
  unknown: '결과 불명(unknown) · 성공이나 효과 없음으로 판단하지 마세요.',
  expired: '확인 기한 만료(expired) · 해당 준비로는 집행할 수 없습니다. 현재 기록에서 다시 준비하세요.',
  error: '요청이 처리되지 않았습니다(error) · 서버 오류를 확인하세요.',
});

const KNOWN_ACTION_CODES = new Set([
  'ACTION_UNSUPPORTED', 'ACTION_DENIED', 'ACTION_CONFIRMATION_EXPIRED',
  'ACTION_CONFIRMATION_INVALID', 'ACTION_SCOPE_CHANGED', 'ACTION_SCOPE_UNVERIFIED',
  'SUBJECT_SCOPE_UNVERIFIED', 'ACTION_SNAPSHOT_CHANGED', 'ACTION_EVENT_UNAVAILABLE',
  'ACTION_TIMEOUT', 'ACTION_STORE_FAILED', 'ACTION_RESULT_UNVERIFIED',
]);

const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SENSITIVE_PATTERN = /(?:Bearer\s+\S+|\b(?:sk-|sb_)[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|authorization|password|비밀번호|토큰)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,})/iu;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;

function isSafeString(value, maxLength = 400) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !SENSITIVE_PATTERN.test(value)
    && !CONTROL_CHAR_PATTERN.test(value);
}

function safeText(value, fallback = '확인 불가', maxLength = 400) {
  return isSafeString(value, maxLength) ? value : fallback;
}

function formatDateText(value, fallback = '시각 정보 없음') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return isSafeString(value, 80) ? value : fallback;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
}

function stateWithCode(labels, value, spaceBeforeParen = false) {
  const code = isSafeString(value, 80) ? value.trim() : 'unknown';
  const description = Object.hasOwn(labels, code) ? labels[code] : '확인 불가';
  return `${description}${spaceBeforeParen ? ' ' : ''}(${code})`;
}

function appendMessage(parent, text, className = '') {
  const p = document.createElement('p');
  if (className) p.className = className;
  p.textContent = text;
  parent.append(p);
  return p;
}

function appendHeading(parent, tagName, text) {
  const heading = document.createElement(tagName);
  heading.textContent = text;
  parent.append(heading);
  return heading;
}

function createKeyValueList() {
  const dl = document.createElement('dl');
  dl.className = 'kv';
  return dl;
}

function appendField(dl, termText, descriptionText) {
  if (descriptionText === null || descriptionText === undefined || descriptionText === '') return;
  const dt = document.createElement('dt');
  dt.textContent = termText;
  const dd = document.createElement('dd');
  dd.textContent = String(descriptionText);
  dl.append(dt, dd);
}

function compareEventTimeDesc(a, b) {
  const timeA = Date.parse(a?.at ?? '');
  const timeB = Date.parse(b?.at ?? '');
  const validA = Number.isFinite(timeA);
  const validB = Number.isFinite(timeB);
  if (validA && validB) return timeB - timeA;
  if (validB) return 1;
  if (validA) return -1;
  return 0;
}

// Student-only, importable local report reader. The supplied app API is not extended.
// This file's contents are incorporated into student/extension.mjs; no new browser route.
const HOST_OBSERVATION_SCHEMA = 'claire.host-observation.v1';
const HOST_MAX_FILE_BYTES = 128 * 1024;
const HOST_HISTORY_LIMIT = 10;
const HOST_REASON_GUIDANCE = Object.freeze({
  PERMISSION_DENIED: '현재 일반 사용자 계정에서 읽을 수 없습니다. 관리자 권한으로 실행하거나 설정을 변경하지 말고, 필요한 경우 담당자에게 조회 권한을 문의하세요.',
  COMMAND_NOT_FOUND: '운영체제의 해당 관리 도구가 없습니다. 시스템 구성을 확인하고, 없는 도구의 결과를 정상으로 판단하지 마세요.',
  FIREWALL_BACKEND_NOT_FOUND: 'firewalld/UFW 조회 도구가 없습니다. 다른 방화벽의 활성 여부는 확인되지 않았습니다.',
  FIREWALL_READ_FAILED: '방화벽 관리자 상태 조회에 실패했습니다. OS에서 읽을 수 있는 범위를 확인하세요.',
  OTHER_BACKEND_UNVERIFIED: '일부 방화벽 관리 도구만 확인됐습니다. 다른 백엔드의 상태를 확인하기 전에는 전체 상태로 해석하지 마세요.',
  NETWORK_READ_FAILED: '인터페이스·DNS를 읽을 수 없습니다. Node 실행 환경과 일반 사용자 권한을 확인하세요.',
  READ_FAILED: '조회 프로그램이 실패했습니다. 현재 사용자 권한과 OS 지원 여부를 확인하세요.',
  QUERY_TIMEOUT: '조회 시간이 초과됐습니다. OS 상태를 점검한 후 수집기를 직접 다시 실행하세요.',
  RESULT_LIMIT: '네트워크 항목 상한을 초과했습니다. 이 결과는 일부만 표시합니다.',
  RESULT_TOO_LARGE: '관리 도구 결과가 제한 용량을 초과했습니다. 완전한 조회로 해석하지 마세요.',
  EVENT_LIMIT_EXCEEDED: '최근 24시간 경고·오류가 2,000건 조회 상한을 초과했습니다. 정확한 총건수는 확인할 수 없습니다.',
  EVENT_READ_FAILED: 'Windows 이벤트 로그를 읽지 못했습니다. Event Log 서비스·현재 사용자 권한을 확인하세요.',
  EVENT_RESPONSE_INVALID: 'Windows 이벤트 집계 형식이 잘못됐습니다. 수집기로 새 보고서를 생성하세요.',
  GATEWAY_NOT_COLLECTED: '기본 게이트웨이는 이번 일반 권한 수집 대상에 포함하지 않았습니다. 미조회는 기본 경로 없음이 아닙니다.',
  FIREWALL_RESPONSE_INVALID: '방화벽 조회 출력 형식을 확인할 수 없습니다. 설정을 변경하지 말고 수집기를 다시 실행하세요.',
  PLATFORM_UNSUPPORTED: '현재 OS의 조회 경로는 지원하지 않습니다.',
  WINDOWS_ONLY: 'Windows System·Application 로그 전용입니다. macOS·Linux에서 0건으로 간주하지 않습니다.',
  INVALID_REPORT_FIELD: '보고서 내부의 값·시각·출처를 검증하지 못했습니다. 공식 수집기로 새 보고서를 만들고 다시 선택하세요.',
  INVALID_REPORT: '보고서의 스키마 또는 출처를 검증하지 못했습니다. 공식 수집기로 새 보고서를 생성한 뒤 다시 선택하세요.',
  REPORT_TOO_LARGE: '보고서 크기가 128 KiB 제한을 초과했습니다. 기록 본문을 포함한 파일은 사용하지 마세요.',
  FILE_READ_FAILED: '파일을 읽지 못했습니다. 현재 계정에서 접근 가능한 수집기 보고서를 다시 선택하세요.',
  NOT_SELECTED: '먼저 일반 권한으로 수집기를 실행한 다음 observation.json 파일을 선택하세요.',
});
const hostSafeString = (value, max = 100) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/u.test(value);
const hostIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;
const hostReason = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value)
  ? value : 'INVALID_REPORT_FIELD';
const hostUnavailable = (reason = 'INVALID_REPORT_FIELD', source = null, measuredAt = null) => ({ status: 'unavailable', reason, source, measuredAt });
const hostTime = value => hostIso(value) ? new Date(value).toLocaleString('ko-KR') : '시각 확인 불가';

function hostParseNetwork(data, platform, produced) {
  if (!data || !hostIso(data.measuredAt) || Math.abs(Date.parse(data.measuredAt) - produced) > 30000
    || data.source !== 'node:os.networkInterfaces+node:dns.getServers') return hostUnavailable();
  if (data.status === 'unavailable') return hostUnavailable(hostReason(data.reason), data.source, data.measuredAt);
  if (!['ok', 'partial'].includes(data.status) || !Array.isArray(data.interfaces) || data.interfaces.length > 32
    || !Array.isArray(data.dns) || data.dns.length > 12) return hostUnavailable();
  const interfaces = [];
  for (const item of data.interfaces) {
    if (!hostSafeString(item?.name, 90) || !Array.isArray(item.addresses) || item.addresses.length > 8) return hostUnavailable();
    const addresses = [];
    for (const entry of item.addresses) {
      if (!['IPv4', 'IPv6'].includes(entry?.family) || !hostSafeString(entry.address, 90)
        || !/^[0-9a-fA-F:.]+(?:%[a-zA-Z0-9_.-]+)?$/u.test(entry.address) || typeof entry.internal !== 'boolean') return hostUnavailable();
      addresses.push({ family: entry.family, address: entry.address, internal: entry.internal });
    }
    interfaces.push({ name: item.name, addresses });
  }
  if (!data.dns.every(item => hostSafeString(item, 90) && /^[0-9a-fA-F:.%\[\]]+$/u.test(item))) return hostUnavailable();
  return { status: data.status, reason: data.status === 'partial' ? hostReason(data.reason) : null,
    measuredAt: data.measuredAt, source: data.source, interfaces, dns: [...data.dns],
    gateway: { status: 'unavailable', reason: 'GATEWAY_NOT_COLLECTED' } };
}

function hostParseFirewall(data, platform, produced) {
  if (!data || !hostIso(data.measuredAt) || Math.abs(Date.parse(data.measuredAt) - produced) > 30000) return hostUnavailable();
  const source = platform === 'win32' ? 'windows:Get-NetFirewallProfile(ActiveStore)'
    : platform === 'darwin' ? 'macos:socketfilterfw(--getglobalstate)'
      : platform === 'linux' ? 'linux:firewalld+ufw' : 'host:unsupported';
  if (data.source !== source) return hostUnavailable();
  if (data.status === 'unavailable' || data.status === 'not_applicable') return hostUnavailable(hostReason(data.reason), data.source, data.measuredAt);
  if (!['ok', 'partial'].includes(data.status)) return hostUnavailable();
  if (platform === 'win32') {
    if (data.status !== 'ok' || !Array.isArray(data.profiles) || data.profiles.length < 1 || data.profiles.length > 3) return hostUnavailable();
    const names = new Set();
    for (const row of data.profiles) {
      if (!['Domain', 'Private', 'Public'].includes(row?.name) || names.has(row.name)
        || typeof row.enabled !== 'boolean' || !['Allow', 'Block', 'NotConfigured'].includes(row.inbound)
        || !['Allow', 'Block', 'NotConfigured'].includes(row.outbound)) return hostUnavailable();
      names.add(row.name);
    }
    return { status: 'ok', source, measuredAt: data.measuredAt,
      profiles: data.profiles.map(row => ({ name: row.name, enabled: row.enabled, inbound: row.inbound, outbound: row.outbound })) };
  }
  if (platform === 'darwin') return ['enabled', 'disabled'].includes(data.state) && data.status === 'ok'
    ? { status: 'ok', source, measuredAt: data.measuredAt, state: data.state } : hostUnavailable();
  if (platform === 'linux') {
    if (!Array.isArray(data.backends) || data.backends.length < 1 || data.backends.length > 2) return hostUnavailable();
    for (const item of data.backends) if (!['linux:firewall-cmd(--state)', 'linux:ufw(status)'].includes(item?.backend)
      || !['running', 'not-running', 'enabled', 'disabled'].includes(item.state)) return hostUnavailable();
    return { status: data.status, reason: data.status === 'partial' ? hostReason(data.reason) : null, source,
      measuredAt: data.measuredAt, backends: data.backends.map(x => ({ ...x })) };
  }
  return hostUnavailable('PLATFORM_UNSUPPORTED');
}

function hostParseEventLog(row) {
  if (row?.status === 'ok' && Number.isSafeInteger(row.warning) && row.warning >= 0 && row.warning <= 2000
    && Number.isSafeInteger(row.error) && row.error >= 0 && row.error <= 2000
    && row.warning + row.error <= 2000) return { status: 'ok', warning: row.warning, error: row.error };
  if (['unavailable', 'partial'].includes(row?.status) && row.warning === null && row.error === null)
    return { status: row.status, warning: null, error: null, reason: hostReason(row.reason) };
  return { status: 'unavailable', warning: null, error: null, reason: 'INVALID_REPORT_FIELD' };
}
function hostParseEvents(data, platform, produced) {
  if (!data || data.detection !== false || !hostIso(data.measuredAt) || Math.abs(Date.parse(data.measuredAt) - produced) > 30000) return hostUnavailable();
  if (platform !== 'win32') return data.status === 'not_applicable' && data.reason === 'WINDOWS_ONLY'
    && data.source === 'windows:NotApplicable'
    ? { status: 'not_applicable', reason: 'WINDOWS_ONLY', measuredAt: data.measuredAt, source: data.source } : hostUnavailable();
  if (data.source !== 'windows:Get-WinEvent(System+Application)' || !hostIso(data.windowStart)
    || !hostIso(data.windowEnd) || Date.parse(data.windowEnd) - Date.parse(data.windowStart) !== 86400000
    || data.measuredAt !== data.windowEnd || data.windowHours !== 24 || data.limitPerLog !== 2000) return hostUnavailable();
  const system = hostParseEventLog(data.system), application = hostParseEventLog(data.application);
  const status = system.status === 'ok' && application.status === 'ok' ? 'ok'
    : system.status === 'unavailable' && application.status === 'unavailable' ? 'unavailable' : 'partial';
  return { status, source: data.source, measuredAt: data.measuredAt, windowStart: data.windowStart,
    windowEnd: data.windowEnd, system, application, detection: false };
}

/** Returns only validated projections, never raw arbitrary JSON content. */
export function normalizeHostObservation(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== HOST_OBSERVATION_SCHEMA
    || !['win32', 'darwin', 'linux'].includes(raw.platform)
    || raw.scope !== 'local-node-runtime' || raw.evidence !== 'user-generated-local-file-not-authenticated'
    || raw.readOnly !== true || !hostIso(raw.producedAt)
    || Date.parse(raw.producedAt) > now + 60000) return { status: 'error', reason: 'INVALID_REPORT' };
  const produced = Date.parse(raw.producedAt);
  return { status: 'ok', platform: raw.platform, producedAt: raw.producedAt,
    scope: raw.scope, evidence: raw.evidence, network: hostParseNetwork(raw.network, raw.platform, produced),
    firewall: hostParseFirewall(raw.firewall, raw.platform, produced),
    windowsEvents: hostParseEvents(raw.windowsEvents, raw.platform, produced) };
}

export function hostComparison(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const last = history.at(-1), previous = [...history].slice(0, -1).reverse().find(row => row.time < last.time);
  if (!previous || previous.platform !== last.platform) return null;
  if (last.windowsEventCount == null || previous.windowsEventCount == null) return null;
  return { from: previous.time, to: last.time, delta: last.windowsEventCount - previous.windowsEventCount,
    note: '각 시점의 이전 24시간 경고·오류 총건수 차이. 그 사이 새 발생 건수가 아님' };
}

function hostNode(tag, text, className = '') {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}
export function hostPanel(state, mode) {
  const region = hostNode('section');
  region.className = 'student-host-panel';
  region.setAttribute('aria-label', '학생 추가 PC 상태');
  region.style.marginBottom = '20px';
  const heading = hostNode('h3', '내 PC 관제 · 학생 추가 기능');
  region.append(heading);
  const disclaimer = hostNode('p', '최근 Windows System·Application의 경고·오류 건수는 OS 기록 집계입니다. 침해나 공격 탐지 결과가 아닙니다.', 'muted');
  region.append(disclaimer);
  const actionBar = hostNode('div');
  actionBar.style.display = 'flex';
  actionBar.style.flexWrap = 'wrap';
  actionBar.style.gap = '8px';
  actionBar.style.alignItems = 'center';
  const retry = hostNode('button', '다시 조회 · 보고서 선택', 'btn');
  retry.type = 'button';
  retry.setAttribute('aria-label', '다시 조회, 로컬 관측 보고서 선택');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.tabIndex = -1;
  fileInput.setAttribute('aria-label', '로컬 관측 JSON 보고서');
  const help = hostNode('p', '수집: 프로젝트 폴더에서 node student/collect-host.mjs 실행 → 출력된 임시 observation.json 파일을 이 버튼으로 선택', 'muted');
  const progress = hostNode('p', state.pending ? '로컬 보고서를 읽고 검증하는 중입니다.'
    : state.error ? '확인 불가 — ' + (HOST_REASON_GUIDANCE[state.error] || HOST_REASON_GUIDANCE.INVALID_REPORT)
      : state.latest ? '선택한 보고서를 표시합니다. 사용자 제공 파일의 진위는 이 앱이 인증하지 않습니다.'
        : HOST_REASON_GUIDANCE.NOT_SELECTED, 'muted');
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const dataRoot = hostNode('div');
  actionBar.append(retry, fileInput);
  region.append(actionBar, help, progress, dataRoot);

  const card = (title, value, details, kind) => {
    const node = hostNode('article');
    node.style.padding = '12px';
    node.style.border = '1px solid #6f8095';
    node.style.borderRadius = '10px';
    node.style.minWidth = '0';
    node.style.background = 'rgba(19, 37, 54, .07)';
    node.setAttribute('data-host-card', kind);
    node.append(hostNode('h4', title));
    const strong = hostNode('strong', value);
    strong.style.display = 'block';
    strong.style.marginBottom = '8px';
    strong.style.overflowWrap = 'anywhere';
    node.append(strong);
    for (const item of details) node.append(hostNode('p', item, 'muted'));
    return node;
  };
  const reasonLine = row => row?.status === 'unavailable' || row?.status === 'partial'
    ? '사유: ' + (HOST_REASON_GUIDANCE[row.reason] || '확인 불가 · 코드 ' + hostReason(row.reason)) : '';
  const networkText = row => row?.status === 'ok' ? row.interfaces.length + '개 인터페이스'
    : row?.status === 'partial' ? '일부 조회 · ' + row.interfaces.length + '개' : '확인 불가';
  const firewallText = row => row?.status === 'ok' ? '조회 완료'
    : row?.status === 'partial' ? '일부 조회' : '확인 불가';
  const eventTotal = row => {
    if (row?.status === 'not_applicable') return 'Windows 전용';
    if (row?.system?.status !== 'ok' || row?.application?.status !== 'ok') return '확인 불가';
    return String(row.system.warning + row.system.error + row.application.warning + row.application.error) + '건 / 24시간';
  };
  const security = () => mode === 'disconnected' ? ['SDP 미연결', 'PC 보고서 성공과 무관하게 SDP 연결 없음']
    : mode === 'demo' ? ['예제 DEMO', 'SDP 실연결 아님 · 보안 정보는 설명용 예제']
      : mode === 'connected' ? ['SDP 어댑터 연결 구성', '실제 서버 응답·기기 정책은 기존 제공 화면에서 별도 확인']
        : ['SDP 확인 불가', '기존 제공 화면에서 로그인과 연결 상태를 확인'];

  const draw = () => {
    dataRoot.replaceChildren();
    const latest = state.latest, sdp = security();
    const grid = hostNode('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))';
    grid.style.gap = '10px';
    const net = latest?.network, fw = latest?.firewall, logs = latest?.windowsEvents;
    grid.append(
      card('01 · 네트워크', latest ? networkText(net) : '미조회', [
        latest ? '수집 ' + hostTime(net?.measuredAt) : '보고서 미선택',
        '출처: ' + (net?.source || '조회 전'), reasonLine(net),
      ].filter(Boolean), 'network'),
      card('02 · 방화벽', latest ? firewallText(fw) : '미조회', [
        latest ? '수집 ' + hostTime(fw?.measuredAt) : '보고서 미선택',
        '출처: ' + (fw?.source || '조회 전'), reasonLine(fw),
      ].filter(Boolean), 'firewall'),
      card('03 · Windows 기록', latest ? eventTotal(logs) : '미조회', [
        latest ? '수집 ' + hostTime(logs?.measuredAt) : '보고서 미선택',
        'System·Application, 경고(Level 3)·오류(Level 2)', reasonLine(logs),
      ].filter(Boolean), 'windows-events'),
      card('04 · SDP', sdp[0], [sdp[1], '로컬 PC 보고서와 독립된 연결 상태'], 'sdp'),
    );
    dataRoot.append(grid);
    if (!latest) return;
    const source = hostNode('p', '보고서 수집 시각: ' + hostTime(latest.producedAt)
      + ' · 실행 OS: ' + latest.platform + ' · 대상: 수집기 Node 실행 환경 · 사용자 선택 파일(원본 인증 불가)', 'muted');
    dataRoot.append(source);
    if (Date.now() - Date.parse(latest.producedAt) > 15 * 60 * 1000) {
      dataRoot.append(hostNode('p', '오래된 보고서입니다. 현재 상태로 해석하지 마세요. 수집기를 직접 재실행해 새 파일을 선택하세요.', 'state state-error'));
    }
    const netSection = hostNode('section');
    netSection.append(hostNode('h4', '네트워크 구성 · 인터페이스 및 DNS'));
    if (net?.status === 'ok' || net?.status === 'partial') {
      for (const iface of net.interfaces) netSection.append(hostNode('p', iface.name + ': '
        + (iface.addresses.length ? iface.addresses.map(item => item.family + ' ' + item.address + (item.internal ? ' (loopback)' : '')).join(' · ') : 'IP 주소 확인 불가'), 'muted'));
      netSection.append(hostNode('p', 'DNS: ' + (net.dns.length ? net.dns.join(', ') : '확인 불가') + ' · 기본 게이트웨이: 확인 불가(이번 수집 대상 제외)', 'muted'));
    } else netSection.append(hostNode('p', reasonLine(net), 'state state-error'));
    dataRoot.append(netSection);
    const fwSection = hostNode('section');
    fwSection.append(hostNode('h4', '방화벽 설정 · 읽기 전용'));
    if (fw?.status === 'ok' || fw?.status === 'partial') {
      if (fw.profiles) for (const p of fw.profiles) fwSection.append(hostNode('p', p.name + ' · 사용 ' + (p.enabled ? '켜짐' : '꺼짐')
        + ' · 기본 인바운드 ' + p.inbound + ' · 기본 아웃바운드 ' + p.outbound, 'muted'));
      if (fw.state) fwSection.append(hostNode('p', 'macOS Application Firewall: ' + fw.state + ' · pf 별도', 'muted'));
      if (fw.backends) for (const b of fw.backends) fwSection.append(hostNode('p', b.backend + ': ' + b.state, 'muted'));
      if (fw.status === 'partial') fwSection.append(hostNode('p', reasonLine(fw), 'state state-error'));
      fwSection.append(hostNode('p', '표시된 관리 도구 외의 방화벽, 모든 규칙 적용, 시스템 전체의 안전은 확인한 것이 아닙니다.', 'muted'));
    } else fwSection.append(hostNode('p', reasonLine(fw), 'state state-error'));
    dataRoot.append(fwSection);
    const logsSection = hostNode('section');
    logsSection.append(hostNode('h4', '최근 Windows System·Application 기록 · 지난 24시간'));
    logsSection.append(hostNode('p', '집계 구간: ' + hostTime(logs?.windowStart) + ' ~ ' + hostTime(logs?.windowEnd)
      + ' · 경고·오류 건수는 침해나 공격 탐지 결과가 아닙니다.', 'muted'));
    if (logs?.status === 'not_applicable') logsSection.append(hostNode('p', HOST_REASON_GUIDANCE.WINDOWS_ONLY, 'muted'));
    else for (const [name, row] of [['System', logs?.system], ['Application', logs?.application]]) {
      const text = row?.status === 'ok' ? '경고 ' + row.warning + '건 · 오류 ' + row.error + '건'
        : '확인 불가 · ' + (HOST_REASON_GUIDANCE[row?.reason] || '로그를 읽지 못했습니다.');
      logsSection.append(hostNode('p', name + ' — ' + text, row?.status === 'ok' ? 'muted' : 'state state-error'));
    }
    dataRoot.append(logsSection);
    const historySection = hostNode('section');
    historySection.append(hostNode('h4', '조회 추이 · 선택한 로컬 보고서'));
    const comparison = hostComparison(state.history);
    historySection.append(hostNode('p', comparison ? '마지막 두 보고서의 24시간 집계 차이: '
      + (comparison.delta > 0 ? '+' : '') + comparison.delta + '건. ' + comparison.note
      : '비교 가능한 서로 다른 시각의 완전한 Windows 보고서 2개가 필요합니다.', 'muted'));
    const list = hostNode('ol');
    for (const h of state.history.slice(-HOST_HISTORY_LIMIT).reverse()) {
      list.append(hostNode('li', hostTime(new Date(h.time).toISOString()) + ' · OS ' + h.platform
        + ' · 네트워크 ' + h.networkStatus + ' · 방화벽 ' + h.firewallStatus
        + ' · 24시간 기록 ' + (h.windowsEventCount === null ? '확인 불가' : h.windowsEventCount + '건'), 'muted'));
    }
    historySection.append(list);
    dataRoot.append(historySection);
  };
  const redraw = () => {
    progress.textContent = state.pending ? '로컬 보고서를 읽고 검증하는 중입니다.'
      : state.error ? '확인 불가 — ' + (HOST_REASON_GUIDANCE[state.error] || HOST_REASON_GUIDANCE.INVALID_REPORT)
        : state.latest ? '수집기에서 만든 파일을 표시합니다. 파일 원본은 별도 인증하지 않았으며 예제 수치를 만들지 않습니다.'
          : HOST_REASON_GUIDANCE.NOT_SELECTED;
    region.setAttribute('aria-busy', state.pending ? 'true' : 'false');
    draw();
  };
  retry.addEventListener('click', () => {
    if (state.pending) return;
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const id = ++state.requestId;
    state.pending = true; state.error = null; state.latest = null; redraw();
    try {
      if (file.size > HOST_MAX_FILE_BYTES) throw Error('REPORT_TOO_LARGE');
      let text;
      try { text = await file.text(); } catch { throw Error('FILE_READ_FAILED'); }
      if (new TextEncoder().encode(text).length > HOST_MAX_FILE_BYTES) throw Error('REPORT_TOO_LARGE');
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw Error('INVALID_REPORT'); }
      const report = normalizeHostObservation(parsed);
      if (report.status !== 'ok') throw Error(report.reason);
      if (id !== state.requestId) return;
      state.latest = report;
      const time = Date.parse(report.producedAt);
      const total = report.windowsEvents?.system?.status === 'ok' && report.windowsEvents?.application?.status === 'ok'
        ? report.windowsEvents.system.warning + report.windowsEvents.system.error
          + report.windowsEvents.application.warning + report.windowsEvents.application.error : null;
      if (!state.history.some(row => row.time === time)) state.history = [...state.history, {
        time, platform: report.platform, networkStatus: report.network.status, firewallStatus: report.firewall.status,
        windowsEventCount: total,
      }].sort((a,b) => a.time - b.time).slice(-HOST_HISTORY_LIMIT);
    } catch (error) {
      if (id !== state.requestId) return;
      state.latest = null; // Never keep old verified-looking readings after a failed selection.
      state.error = ['REPORT_TOO_LARGE','INVALID_REPORT','FILE_READ_FAILED'].includes(error?.message) ? error.message : 'INVALID_REPORT_FIELD';
    } finally {
      if (id === state.requestId) { state.pending = false; redraw(); }
    }
  });
  draw();
  return region;
}


export function createStudentView() {
  const hostState = { pending: false, latest: null, history: [], error: null, requestId: 0 };
  return {
    renderIdentity({ me, devices, sessions } = {}) {
      const root = document.createElement('div');
      const modeLabels = {
        connected: '연결됨(connected)',
        demo: '예제 자료',
        disconnected: '연결 없음',
        unknown: '확인 불가',
      };
      const deviceState = (value) => stateWithCode(DEVICE_STATES, value, true);
      const sessionState = (value) => stateWithCode(SESSION_STATES, value, true);

      let sectionIndex = 0;
      const renderSection = (title, resource, showData) => {
        const group = document.createElement('section');
        if (sectionIndex++ > 0 && group.style) group.style.marginTop = '14px';
        appendHeading(group, 'h3', title);

        // 연결 모드는 요청 상태와 독립적으로 표시한다.
        if (Object.hasOwn(modeLabels, resource?.mode)) {
          appendMessage(group, modeLabels[resource.mode], 'muted');
        }
        if (resource?.status === 'loading') {
          appendMessage(group, '불러오는 중', 'state state-loading');
        } else if (resource?.status === 'error') {
          const unverified = ['CONTRACT_MISMATCH', 'ENGINE_RESULT_UNVERIFIED'].includes(resource.error?.code);
          const detail = safeText(resource.error?.message, '서버 응답을 확인할 수 없습니다.');
          appendMessage(group, `${unverified ? '확인 불가' : '연결 실패'}: ${detail}`, 'state state-error');
        } else if (resource?.status === 'ok' && resource.data != null) {
          showData(group, resource.data);
        } else {
          appendMessage(group, '확인 불가', 'state state-empty');
        }
        root.append(group);
      };

      renderSection('현재 계정·기기·로그인 세션', me, (group, data) => {
        if (!data.user || !data.device || !data.session) {
          appendMessage(group, '확인 불가: 로그인 정보를 확인할 수 없습니다.', 'state state-error');
          return;
        }
        const list = createKeyValueList();
        appendField(list, '사용자', `${safeText(data.user.label)} · ID: ${safeText(data.user.id)}`);
        appendField(list, '기기', `${safeText(data.device.label)} · ID: ${safeText(data.device.id)}`);
        appendField(list, '기기 상태', deviceState(data.device.status));
        appendField(list, '세션 ID', safeText(data.session.id));
        appendField(list, '세션 상태', sessionState(data.session.status));
        group.append(list);
        if (data.device.status !== 'compliant' || data.session.status !== 'active') {
          appendMessage(
            group,
            '주의: 기기 보안 기준 미충족·만료·철회·확인 불가 상태는 정상 보안 상태로 간주하지 않습니다.',
            'muted',
          );
        }
      });

      renderSection('본인 등록 기기', devices, (group, data) => {
        if (!Array.isArray(data)) return appendMessage(group, '확인 불가', 'state state-empty');
        if (data.length === 0) return appendMessage(group, '등록된 기기 없음', 'state state-empty');
        const list = document.createElement('ul');
        list.className = 'plain-list';
        for (const device of data) {
          const item = document.createElement('li');
          item.textContent = `${safeText(device?.label)} · ID: ${safeText(device?.id)} · ${deviceState(device?.status)}`;
          list.append(item);
        }
        group.append(list);
      });

      renderSection('확인된 로그인 세션', sessions, (group, data) => {
        if (!Array.isArray(data)) return appendMessage(group, '확인 불가', 'state state-empty');
        if (data.length === 0) return appendMessage(group, '확인된 세션 없음', 'state state-empty');
        const list = document.createElement('ul');
        list.className = 'plain-list';
        for (const session of data) {
          const item = document.createElement('li');
          item.textContent = `ID: ${safeText(session?.id)} · ${sessionState(session?.status)}`;
          list.append(item);
        }
        group.append(list);
      });

      return root;
    },

    renderDecision({ status = 'idle', mode, data, error, appId } = {}) {
      const root = document.createElement('div');
      const modeLabels = {
        connected: '연결됨(connected)',
        demo: '예제 데이터(demo) · 실제 업무 앱 접속 결과가 아닙니다.',
        disconnected: '연결 없음(disconnected)',
        unknown: '연결 상태 확인 불가(unknown)',
      };
      if (mode != null) {
        appendMessage(root, Object.hasOwn(modeLabels, mode) ? modeLabels[mode] : modeLabels.unknown, 'muted');
      }
      if (status === 'idle') {
        appendMessage(root, '업무 앱 하나를 선택한 뒤 접속 요청을 누르세요.', 'state state-empty');
        return root;
      }
      const selectedApp = isSafeString(appId, 80)
        ? appId.trim()
        : isSafeString(data?.appId, 80) ? data.appId.trim() : null;
      if (selectedApp) appendMessage(root, '업무 앱 ID: ' + selectedApp);

      if (status === 'loading') {
        appendMessage(root, '접속 판정 확인 중입니다.', 'state state-loading');
        return root;
      }
      if (status === 'error') {
        const detail = safeText(error?.message, '서버 오류 메시지를 확인할 수 없습니다.');
        appendMessage(root, '접속 판정 요청 실패: ' + detail, 'decision decision-failed');
        appendMessage(root, '요청 실패는 접근 거부(deny) 판정이 아니며, 접근 허용도 확인되지 않았습니다.', 'muted');
        return root;
      }
      if (status !== 'ok' || !isSafeString(data?.appId, 80)
          || (selectedApp && data.appId.trim() !== selectedApp)) {
        appendMessage(root, '접속 판정: 확인 불가(unknown)', 'decision decision-unknown');
        appendMessage(root, '요청 상태나 판정 대상 앱을 확인할 수 없어 접근 허용으로 간주하지 않습니다.', 'muted');
        return root;
      }

      const decision = Object.hasOwn(DECISION_LABELS, data.decision) ? data.decision : 'unknown';
      appendMessage(root, '접속 판정: ' + DECISION_LABELS[decision], `decision decision-${decision}`);
      if (decision === 'allow') {
        appendMessage(root, '정책상 접근 허용이며 실제 업무 앱 접속 성공을 보장하지 않습니다.');
      } else if (decision === 'deny') {
        appendMessage(root, '정책상 해당 업무 앱 접근이 거부되었습니다.');
      } else if (decision === 'challenge') {
        appendMessage(root, '추가 인증 또는 확인이 필요합니다. 이 앱은 확인 절차를 대신 수행하지 않습니다.');
      } else {
        appendMessage(root, '판정을 확인할 수 없으므로 접근 허용으로 간주하지 않습니다.');
      }
      const details = createKeyValueList();
      appendField(details, '판정 이유', safeText(data.reason, '사유 정보 없음', 2000));
      appendField(details, '판정 시각', formatDateText(data.checkedAt));
      root.append(details);
      return root;
    },

    renderEvents({ status = 'idle', mode, data, error } = {}) {
      const root = document.createElement('section');
      const modeLabels = {
        connected: '연결됨(connected)',
        demo: '예제 자료(demo)',
        disconnected: '연결 없음(disconnected)',
        unknown: '확인 불가(unknown)',
      };
      if (Object.hasOwn(modeLabels, mode)) {
        appendMessage(root, '연결 모드: ' + modeLabels[mode], 'muted');
      }
      if (status === 'loading') {
        appendMessage(root, '보안 기록을 불러오는 중입니다.', 'state state-loading');
        return root;
      }
      if (status === 'error') {
        const detail = safeText(error?.message, '서버 응답을 확인할 수 없습니다.');
        const prefix = error?.code === 'CONTRACT_MISMATCH' ? '확인 불가(CONTRACT_MISMATCH): ' : '';
        appendMessage(root, prefix + '기록을 불러오지 못했습니다: ' + detail, 'state state-error');
        return root;
      }
      if (status !== 'ok' || !Array.isArray(data)) {
        appendMessage(root, '보안 기록 상태를 확인할 수 없습니다.', 'state state-empty');
        return root;
      }
      if (data.length === 0) {
        appendMessage(root, '표시할 기록이 없습니다', 'state state-empty');
        return root;
      }

      // 제공된 본인 기록만 복사해서 최신순 정렬한다. 서버나 입력 배열은 변경하지 않는다.
      const events = [...data].sort(compareEventTimeDesc);
      const appLabel = (id) => (id == null || id === '' ? '앱 ID 확인 불가' : safeText(String(id), '앱 ID 확인 불가', 80));
      const kindLabel = (kind) => stateWithCode(EVENT_KINDS, kind, false);
      const accessLabel = (access) => stateWithCode(ACCESS_STATES, access, false);

      const filters = document.createElement('div');
      filters.className = 'row';
      const count = document.createElement('p');
      count.className = 'muted';
      count.setAttribute('role', 'status');
      const list = document.createElement('ul');
      list.className = 'records';

      const createFilter = (title, values, describe) => {
        const label = document.createElement('label');
        label.textContent = title + ': ';
        const select = document.createElement('select');
        select.setAttribute('aria-label', title);
        const all = document.createElement('option');
        all.value = 'all';
        all.textContent = '전체';
        select.append(all);
        for (const value of new Set(values)) {
          const normalized = typeof value === 'string' ? value : '';
          const option = document.createElement('option');
          option.value = normalized;
          option.textContent = describe(normalized);
          select.append(option);
        }
        label.append(select);
        filters.append(label);
        return select;
      };

      const kindFilter = createFilter('기록 종류', data.map((event) => event?.kind ?? 'unknown'), kindLabel);
      const appFilter = createFilter('업무 앱', data.map((event) => event?.appId ?? ''), appLabel);
      const accessFilter = createFilter('접속 상태', data.map((event) => event?.state?.access ?? 'unknown'), accessLabel);
      root.append(filters, count, list);

      const renderItemGroup = (parent, title, items) => {
        appendHeading(parent, 'h4', title);
        const safeItems = Array.isArray(items) ? items : [];
        if (safeItems.length === 0) {
          appendMessage(parent, title + ' 없음', 'muted');
          return;
        }
        const entries = document.createElement('ul');
        for (const entry of safeItems) {
          const row = document.createElement('li');
          row.textContent = 'ID: ' + safeText(entry?.id, '확인 불가', 80) + ' · ' + safeText(entry?.text, '내용 확인 불가', 2000);
          entries.append(row);
        }
        parent.append(entries);
      };

      const makeDetail = (event) => {
        const detail = document.createElement('section');
        detail.setAttribute('data-student-event-detail', safeText(event?.id, 'unknown', 80));
        appendHeading(detail, 'h4', '기록 상세');
        const identity = createKeyValueList();
        appendField(identity, '사건 ID', safeText(event?.id, '확인 불가', 80));
        appendField(identity, '앱 ID', appLabel(event?.appId));
        detail.append(identity);
        renderItemGroup(detail, '근거', event?.evidence);
        renderItemGroup(detail, '규칙', event?.rules);
        const states = createKeyValueList();
        appendField(states, '접속 상태', accessLabel(event?.state?.access));
        appendField(states, '세션 상태', stateWithCode(SESSION_STATES, event?.state?.session, false));
        appendField(states, '기기 상태', stateWithCode(DEVICE_STATES, event?.state?.device, false));
        detail.append(states);
        if (Array.isArray(event?.supportedActions) && event.supportedActions.length > 0) {
          const actions = document.createElement('div');
          actions.className = 'event-actions';
          appendHeading(actions, 'h4', '미지원 조치');
          for (const action of event.supportedActions) {
            const actionName = safeText(action, 'unknown', 80);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn';
            button.textContent = actionName + ' 미지원';
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
            actions.append(button);
          }
          appendMessage(actions, '조치 실행 연결은 준비 중입니다. 이 화면에서 조치 요청을 보내지 않습니다.', 'muted');
          detail.append(actions);
        }
        return detail;
      };

      let openButton = null;
      let openDetail = null;
      const renderList = () => {
        list.replaceChildren();
        openButton = null;
        openDetail = null;
        const filtered = events.filter((event) =>
          (kindFilter.value === 'all' || (event?.kind ?? 'unknown') === kindFilter.value)
          && (appFilter.value === 'all' || (event?.appId ?? '') === appFilter.value)
          && (accessFilter.value === 'all' || (event?.state?.access ?? 'unknown') === accessFilter.value));
        count.textContent = '표시 중 ' + filtered.length + '건 / 받은 기록 ' + events.length + '건';
        if (filtered.length === 0) {
          appendMessage(list, '필터 조건에 맞는 기록이 없습니다.', 'state state-empty');
          return;
        }
        for (const event of filtered) {
          const eventId = safeText(event?.id, 'unknown', 80);
          const row = document.createElement('li');
          row.className = 'event';
          row.setAttribute('data-student-event-id', eventId);
          const fields = createKeyValueList();
          appendField(fields, '사건 ID', eventId);
          appendField(fields, '시각', formatDateText(event?.at));
          appendField(fields, '기록 종류', kindLabel(event?.kind));
          appendField(fields, '업무 앱', appLabel(event?.appId));
          appendField(fields, '요약', safeText(event?.summary, '요약 없음', 2000));
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = eventId + ' 상세 보기';
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('click', () => {
            if (openDetail) {
              openDetail.remove();
              openButton.setAttribute('aria-expanded', 'false');
              openButton.textContent = openButton.dataset.eventId + ' 상세 보기';
            }
            if (openButton === button) {
              openButton = null;
              openDetail = null;
              return;
            }
            openDetail = makeDetail(event);
            row.append(openDetail);
            button.setAttribute('aria-expanded', 'true');
            button.dataset.eventId = eventId;
            button.textContent = eventId + ' 상세 접기';
            openButton = button;
          });
          row.append(fields, button);
          list.append(row);
        }
      };

      for (const select of [kindFilter, appFilter, accessFilter]) {
        select.addEventListener('change', renderList);
      }
      renderList();
      return root;
    },

    renderStatus({ devices, sessions, notifications, diagnostics, mode } = {}) {
      const root = document.createElement('section');
      root.append(hostPanel(hostState, mode));
      const stateText = (labels, value) => stateWithCode(labels, value, false);

      const renderFailure = (section, label, resource, retryControl) => {
        const code = resource?.error?.code;
        const detail = safeText(resource?.error?.message, '서버 응답을 확인할 수 없습니다.');
        const unverified = code === 'CONTRACT_MISMATCH' || code === 'ENGINE_RESULT_UNVERIFIED';
        const subject = label === '등록 기기' ? '등록 기기를'
          : label === '현재 로그인 세션' ? '현재 로그인 세션을' : '진단 정보를';
        appendMessage(
          section,
          unverified ? label + ' 확인 불가: ' + detail : subject + ' 불러오지 못했습니다: ' + detail,
          'state state-error',
        );
        if ((typeof code === 'string' && /TIMEOUT/i.test(code)) || /시간\s*초과/u.test(detail)) {
          appendMessage(section, '요청 시간이 초과됐습니다.');
        }
        appendMessage(section, '다시 시도하려면 위쪽 「' + retryControl + '」 버튼을 직접 누르세요. 자동 재요청은 하지 않습니다.', 'muted');
      };

      const renderListResource = (title, resource, emptyText, rowText, needsAttention) => {
        const section = document.createElement('section');
        appendHeading(section, 'h3', title);
        if (resource?.status === 'loading') {
          appendMessage(section, (title === '등록 기기' ? '등록 기기를' : '현재 로그인 세션을') + ' 불러오는 중입니다.', 'state state-loading');
        } else if (resource?.status === 'error') {
          renderFailure(section, title, resource, '다시 불러오기');
        } else if (resource?.status === 'ok' && Array.isArray(resource.data)) {
          if (resource.data.length === 0) {
            appendMessage(section, emptyText, 'state state-empty');
          } else {
            const list = document.createElement('ul');
            list.className = 'plain-list';
            let attentionCount = 0;
            for (const row of resource.data) {
              const item = document.createElement('li');
              item.textContent = rowText(row);
              if (needsAttention(row)) attentionCount += 1;
              list.append(item);
            }
            section.append(list);
            if (attentionCount > 0) {
              appendMessage(
                section,
                `주의·확인 필요 항목 ${attentionCount}건: 보안 기준 미충족·만료·철회·확인 불가 상태는 정상으로 간주하지 않습니다.`,
                'muted',
              );
            }
          }
        } else if (resource?.status === 'ok') {
          appendMessage(section, title + ' 형식을 확인할 수 없습니다.', 'state state-error');
        } else {
          appendMessage(section, title + ' 조회 전입니다.', 'state state-empty');
        }
        root.append(section);
      };

      const modes = {
        connected: '연결됨(connected)',
        demo: '예제 자료(demo)',
        disconnected: '연결 없음(disconnected)',
        unknown: '확인 불가(unknown)',
      };
      if (mode != null) {
        appendMessage(root, '연결 모드: ' + (Object.hasOwn(modes, mode) ? modes[mode] : modes.unknown), 'muted');
      }

      renderListResource(
        '등록 기기',
        devices,
        '등록된 기기가 없습니다.',
        (device) => '기기: ' + safeText(device?.label) + ' · 상태: ' + stateText(DEVICE_STATES, device?.status),
        (device) => device?.status !== 'compliant',
      );
      renderListResource(
        '현재 로그인 세션',
        sessions,
        '현재 연결이 없습니다.',
        (session) => '세션 ID: ' + safeText(session?.id) + ' · 상태: ' + stateText(SESSION_STATES, session?.status),
        (session) => session?.status !== 'active',
      );
      appendMessage(root, '세션 조회는 현재 검증된 연결 한 건만 대상으로 하며, 과거 세션 전체 목록이 아닙니다.', 'muted');

      const notices = document.createElement('section');
      if (notices.style) notices.style.marginTop = '14px';
      appendHeading(notices, 'h3', '주의 알림');
      if (!Array.isArray(notifications) || notifications.length === 0) {
        appendMessage(notices, '주의할 알림이 없습니다.', 'state state-empty');
      } else {
        const list = document.createElement('ul');
        list.className = 'plain-list';
        for (const notice of notifications) {
          const item = document.createElement('li');
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = safeText(notice?.resource, '알림', 80);
          const body = document.createElement('span');
          body.textContent = safeText(notice?.message, '확인 불가', 500);
          item.append(tag, body);
          list.append(item);
        }
        notices.append(list);
      }
      root.append(notices);

      const diagnosticSection = document.createElement('section');
      if (diagnosticSection.style) diagnosticSection.style.marginTop = '14px';
      appendHeading(diagnosticSection, 'h3', '진단 정보');
      appendMessage(
        diagnosticSection,
        '도움 요청에 사용할 수 있는 진단 정보만 복사합니다. 비밀번호·토큰·API 키는 포함하지 않습니다.',
        'muted',
      );
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'btn';
      copyButton.textContent = '도움정보 복사';
      copyButton.disabled = true;
      const copyResult = document.createElement('p');
      copyResult.className = 'muted';
      if (copyResult.style) copyResult.style.marginTop = '8px';
      copyResult.setAttribute('role', 'status');

      if (diagnostics?.status === 'loading') {
        appendMessage(diagnosticSection, '진단 정보를 불러오는 중입니다.', 'state state-loading');
      } else if (diagnostics?.status === 'error') {
        renderFailure(diagnosticSection, '진단 정보', diagnostics, '도움정보 불러오기');
      } else if (diagnostics?.status === 'ok' && diagnostics.data && typeof diagnostics.data === 'object') {
        // 사용자가 실제 복사를 누를 때만, 제공된 진단 결과의 6개 안전한 필드만 복사한다.
        const safeDiagField = (value) => typeof value === 'string'
          && /^[A-Za-z0-9._:+-]{1,128}$/u.test(value)
          && !/^(?:eyJ|sk-|sb_)/iu.test(value) ? value : '확인 불가';
        const data = diagnostics.data;
        const exported = {
          requestId: safeDiagField(data.requestId),
          component: safeDiagField(data.component),
          version: safeDiagField(data.version),
          checkedAt: safeDiagField(data.checkedAt),
          engine: {
            mode: safeDiagField(data.engine?.mode),
            code: safeDiagField(data.engine?.code),
          },
        };
        const details = createKeyValueList();
        appendField(details, 'requestId', exported.requestId);
        appendField(details, 'component', exported.component);
        appendField(details, 'version', exported.version);
        appendField(details, 'checkedAt', exported.checkedAt);
        appendField(details, 'engine.mode', exported.engine.mode);
        appendField(details, 'engine.code', exported.engine.code);
        diagnosticSection.append(details);
        copyButton.disabled = false;
        copyButton.addEventListener('click', async () => {
          try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
              throw new Error('CLIPBOARD_UNAVAILABLE');
            }
            await navigator.clipboard.writeText(JSON.stringify(exported, null, 2));
            copyResult.textContent = '도움정보를 클립보드에 복사했습니다. 필요한 경우 직접 도움 요청에 사용하세요.';
          } catch {
            copyResult.textContent = '도움정보 복사에 실패했습니다. 브라우저의 클립보드 권한을 확인하세요.';
          }
        });
      } else if (diagnostics?.status === 'ok') {
        appendMessage(diagnosticSection, '진단 정보 형식을 확인할 수 없습니다.', 'state state-error');
      } else {
        appendMessage(diagnosticSection, '진단 정보를 아직 조회하지 않았습니다. 위쪽 「도움정보 불러오기」를 직접 누르세요.', 'state state-empty');
      }
      diagnosticSection.append(copyButton, copyResult);
      root.append(diagnosticSection);
      return root;
    },

    renderVulnerabilities({ status = 'idle', mode, data, error } = {}) {
      const root = document.createElement('section');
      root.className = 'vulnerabilities-result';
      const modes = {
        connected: '연결됨(connected)',
        demo: '예제 자료(demo) · 실제 프로젝트 조회가 아닙니다.',
        disconnected: '연결 없음(disconnected)',
        unknown: '확인 불가(unknown)',
      };
      if (Object.hasOwn(modes, mode)) appendMessage(root, '조회 모드: ' + modes[mode], 'muted');

      // 호출마다 빈 DOM을 새로 만든다. 진행 중·실패에는 이전 성공 표나 결과를 재사용하지 않는다.
      if (status === 'idle') {
        appendMessage(root, '설치 패키지 취약점 조회 전(idle)입니다.', 'state state-empty');
        return root;
      }
      if (status === 'loading') {
        appendMessage(root, '설치 패키지 취약점 조회 중(loading)입니다. 아직 조회 결과가 아닙니다.', 'state state-loading');
        return root;
      }
      if (status === 'error') {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
          ? error.code : null;
        const detail = safeText(error?.message, '안전한 오류 메시지를 확인할 수 없습니다.');
        appendMessage(root, '설치 패키지 취약점 조회 실패(error): ' + detail, 'state state-error');
        if (code) appendMessage(root, '오류 코드: ' + code);
        appendMessage(root, '조회 실패는 취약점이 없다는 뜻이 아닙니다. 이전 결과는 현재 조회 결과가 아닙니다.', 'muted');
        appendMessage(root, '다시 조회하려면 제공 화면의 「설치 패키지 조회」 버튼을 직접 누르세요. 자동 재요청은 하지 않습니다.', 'muted');
        return root;
      }

      if (status !== 'ok' || data == null || !Object.hasOwn(SCAN_STATUS_LABELS, data.status)
          || !Array.isArray(data.packages)) {
        appendMessage(root, '패키지 조회 상태 또는 응답 형식을 확인할 수 없습니다. 현재 결과로 표시하지 않습니다.', 'state state-error');
        return root;
      }
      appendMessage(root, '전체 조회 상태: ' + SCAN_STATUS_LABELS[data.status]);
      const meta = createKeyValueList();
      appendField(meta, '잠금 버전', data.lockfileVersion);
      appendField(meta, '잠금 해시', data.lockfileHash);
      appendField(meta, '확인 시각', formatDateText(data.checkedAt));
      if (meta.childNodes.length) root.append(meta);

      if (data.packages.length === 0) {
        appendMessage(root, '현재 표시할 패키지 조회 결과가 없습니다. 미조회 또는 결과 없음은 취약점이 없다는 증거가 아닙니다.', 'state state-empty');
        return root;
      }

      // 제공 화면에서 검증된 설치 버전을 다시 가공하거나 버전 범위를 설치값으로 치환하지 않는다.
      const valid = data.packages.every((pkg) => typeof pkg?.name === 'string' && pkg.name.trim()
        && typeof pkg.version === 'string' && EXACT_SEMVER.test(pkg.version)
        && Object.hasOwn(PACKAGE_STATUS_LABELS, pkg.status) && Array.isArray(pkg.vulnerabilities)
        && typeof pkg.source === 'string' && typeof pkg.checkedAt === 'string'
        && pkg.vulnerabilities.every((v) => typeof v?.id === 'string'
          && typeof v.modified === 'string'));
      if (!valid) {
        appendMessage(root, '설치 패키지 버전이나 OSV 조회 결과를 확인할 수 없습니다. ^1.2.0 같은 범위를 실제 설치 버전으로 표시하지 않습니다.', 'state state-error');
        return root;
      }

      const table = document.createElement('table');
      const caption = document.createElement('caption');
      caption.textContent = '승인된 공개 패키지의 설치 버전과 OSV 조회 결과';
      table.append(caption);
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['패키지', '설치 버전', '조회 상태', '출처', '패키지 확인 시각', '취약점 ID·수정 시각']) {
        const th = document.createElement('th');
        th.textContent = label;
        th.setAttribute('scope', 'col');
        headRow.append(th);
      }
      head.append(headRow);
      table.append(head);
      const body = document.createElement('tbody');
      const addCell = (row, text) => {
        const td = document.createElement('td');
        td.textContent = text;
        row.append(td);
        return td;
      };
      for (const pkg of data.packages) {
        const row = document.createElement('tr');
        row.setAttribute('data-student-package-name', pkg.name);
        row.setAttribute('data-student-package-version', pkg.version);
        addCell(row, pkg.name);
        addCell(row, pkg.version);
        const partialFindings = pkg.status === 'unverifiable' && pkg.vulnerabilities.length > 0;
        addCell(
          row,
          PACKAGE_STATUS_LABELS[pkg.status] + (partialFindings ? ' · 일부 확인·전체 조회 확인 불가' : ''),
        );
        addCell(row, pkg.source);
        addCell(row, pkg.checkedAt);
        const vulns = document.createElement('td');
        if (pkg.vulnerabilities.length > 0) {
          const entries = document.createElement('ul');
          for (const item of pkg.vulnerabilities) {
            const li = document.createElement('li');
            li.textContent = 'ID: ' + item.id + ' · modified(수정 시각): ' + item.modified;
            entries.append(li);
          }
          vulns.append(entries);
        } else if (pkg.status === 'none_found') {
          appendMessage(vulns, '해당 버전의 OSV 조회 범위에서 알려진 취약점 항목이 없습니다. 안전하다는 보장은 아닙니다.');
        } else if (pkg.status === 'unverifiable') {
          appendMessage(vulns, '전체 조회 확인 불가 · 알려진 취약점이 없다고 판단할 수 없습니다.');
        } else {
          appendMessage(vulns, '취약점 상세 결과를 확인할 수 없습니다.');
        }
        row.append(vulns);
        body.append(row);
      }
      table.append(body);
      root.append(table);
      appendMessage(root, 'OSV는 알려진 취약점 데이터베이스입니다. 조회 결과만으로 패키지나 앱 전체의 안전을 보장할 수 없습니다.', 'muted');
      return root;
    },

    renderAiConnection({ status = 'idle', mode, data, error, checkedAt, explanationAccepted = false } = {}) {
      const root = document.createElement('section');
      const modes = {
        connected: '연결됨(connected)',
        demo: '예제 데이터(demo) · 실제 AI 게이트 연결 증거가 아닙니다.',
        disconnected: '연결 없음(disconnected)',
        unknown: '연결 상태 확인 불가(unknown)',
      };
      if (Object.hasOwn(modes, mode)) appendMessage(root, '연결 모드: ' + modes[mode], 'muted');

      if (status === 'idle') {
        appendMessage(root, 'AI 연결 점검 전', 'state state-empty');
        appendMessage(root, '이전 점검 결과는 현재 상태가 아닙니다. 연결 확인 후 「현재 API 연결 점검」을 직접 누르세요.', 'muted');
        return root;
      }
      if (status === 'loading') {
        appendMessage(root, 'AI 연결 점검 중', 'state state-loading');
        appendMessage(root, '현재 계정과 앱 이용 권한, 모델 응답을 확인하고 있습니다. 아직 사건 설명을 실행하지 않았습니다.', 'muted');
        return root;
      }
      if (status === 'ok') {
        if (data?.transportChecked !== true || !['test', 'verified'].includes(data?.audienceAuthorization)
            || !Number.isInteger(data?.modelCount) || data.modelCount < 0
            || typeof checkedAt !== 'string' || !checkedAt.trim()) {
          appendMessage(root, 'AI 연결 점검 결과를 확인할 수 없습니다. 연결 성공으로 간주하지 않습니다.', 'state state-error');
          return root;
        }
        appendMessage(
          root,
          'AI 연결 점검 결과: ' + (data.audienceAuthorization === 'test'
            ? '시험 연결 점검(test) · 실제 앱 이용 권한 확인 아님'
            : '앱 권한 확인 후 점검(verified) · 점검 시각 기준'),
          'state state-ok',
        );
        appendMessage(root, '응답 모델 수: ' + data.modelCount + '개');
        appendMessage(root, '점검 시각: ' + checkedAt);
        appendMessage(root, '현재 API 연결과 모델 목록만 점검했습니다. 사건 설명은 아직 실행하지 않았습니다.', 'muted');
        appendMessage(root, '사건 설명은 보안 기록에서 별도로 직접 요청하고 응답을 확인해야 합니다.', 'muted');
        return root;
      }
      if (status === 'error') {
        const code = Object.hasOwn(AI_ERROR_GUIDANCE, error?.code) ? error.code : 'AI_REQUEST_UNVERIFIED';
        const detail = safeText(error?.message, '안전한 오류 메시지를 확인할 수 없습니다.');
        appendMessage(root, 'AI 연결 점검 실패 · 코드: ' + code + ' · 메시지: ' + detail, 'state state-error');
        appendMessage(root, AI_ERROR_GUIDANCE[code]);
        appendMessage(root, '사건 설명이 성공한 것이 아닙니다. 「현재 API 연결 점검」을 직접 눌러 다시 점검하세요. 자동 재요청은 하지 않습니다.', 'muted');
        return root;
      }
      appendMessage(root, 'AI 연결 점검 상태를 확인할 수 없습니다. 이전 결과를 현재 성공으로 간주하지 않습니다.', 'state state-empty');
      return root;
    },

    renderExplanation({ event, explanation, checkedAt } = {}) {
      const root = document.createElement('section');
      const renderFailure = (why, code = 'ON_AI_INVALID_OUTPUT') => {
        appendMessage(root, 'AI 설명 확인 불가 · 코드: ' + code + ' · ' + why, 'state state-error');
        appendMessage(root, '기록은 그대로입니다. 근거가 부족하거나 일치하지 않는 설명을 성공으로 표시하지 않습니다.', 'muted');
        return root;
      };
      const status = explanation?.status ?? 'idle';

      // 실제 사건이 선택되지 않았더라도 서버 오류부터 구분해 표시한다.
      if (status === 'error') {
        const code = Object.hasOwn(AI_ERROR_GUIDANCE, explanation?.error?.code)
          ? explanation.error.code : 'AI_REQUEST_UNVERIFIED';
        const message = safeText(explanation?.error?.message, '안전한 오류 메시지를 확인할 수 없습니다.');
        appendMessage(root, 'AI 설명 실패: ' + code + ' · ' + message, 'state state-error');
        if (['ON_AI_INVALID_INPUT', 'ON_AI_INVALID_OUTPUT'].includes(code)) {
          appendMessage(root, '사건 근거 부족, 인용 근거 ID 불일치 또는 설명 결과 형식을 확인할 수 없습니다.');
        }
        appendMessage(root, '기록은 그대로입니다. AI 설명 실패는 업무 앱 판정이나 과제 실패가 아닙니다.', 'muted');
        return root;
      }
      if (typeof event?.id !== 'string' || !event.id.trim()) {
        appendMessage(root, '보안 기록에서 기록을 먼저 고르세요. AI 설명은 아직 실행하지 않았습니다.', 'state state-empty');
        return root;
      }
      if (status === 'loading') {
        appendMessage(root, '사건 ID: ' + event.id);
        appendMessage(root, 'AI 설명 요청 중입니다. 결과는 아직 확인되지 않았습니다.', 'state state-loading');
        return root;
      }
      if (status !== 'ok') {
        appendMessage(root, '사건 ID: ' + event.id);
        appendMessage(
          root,
          status === 'idle'
            ? 'AI 설명은 아직 실행하지 않았습니다. 보안 기록에서 「AI 설명 요청」을 직접 누르세요.'
            : 'AI 설명 상태를 확인할 수 없습니다. 이전 결과는 현재 설명이 아닙니다.',
          'state state-empty',
        );
        return root;
      }

      const result = explanation?.data;
      if (result?.executed !== false) {
        return renderFailure(result?.executed === true
          ? 'AI가 이미 실행했다고 표시한 설명은 사용할 수 없습니다. 보안 조치 완료로 인정하지 않습니다.'
          : '설명의 미실행 여부를 확인할 수 없습니다.');
      }
      if (result.requiresHumanConfirmation !== true) {
        return renderFailure('사람 확인 필요 여부가 명확하지 않아 설명을 사용할 수 없습니다.');
      }
      if (!isSafeString(result.summary, 1500)) {
        return renderFailure('요약이 없거나 형식을 확인할 수 없어 AI 설명을 사용할 수 없습니다.');
      }
      if (!Array.isArray(event.evidence) || !event.evidence.length) {
        return renderFailure('선택한 기록에 근거가 부족합니다.', 'ON_AI_INVALID_INPUT');
      }
      if (!Array.isArray(event.rules) || !event.rules.length
          || event.rules.some((rule) => typeof rule?.id !== 'string' || !rule.id
            || typeof rule.text !== 'string')) {
        return renderFailure('선택한 기록의 규칙 ID와 규칙 글을 확인할 수 없습니다.', 'ON_AI_INVALID_INPUT');
      }

      const evidence = new Map();
      for (const item of event.evidence) {
        if (typeof item?.id !== 'string' || !item.id || typeof item.text !== 'string'
            || evidence.has(item.id)) {
          return renderFailure('근거 ID·근거 글이 누락되었거나 근거 ID가 중복되었습니다.', 'ON_AI_INVALID_INPUT');
        }
        evidence.set(item.id, item.text);
      }
      const references = result.evidenceIds;
      if (!Array.isArray(references) || references.length !== evidence.size
          || new Set(references).size !== references.length
          || references.some((id) => typeof id !== 'string' || !evidence.has(id))) {
        return renderFailure('AI가 인용한 근거 ID가 선택한 사건의 근거와 일치하지 않습니다. 근거를 만들어 내지 않습니다.');
      }
      if (!event.state || !['access', 'session', 'device'].every(
        (key) => typeof event.state[key] === 'string')) {
        return renderFailure('접속·세션·기기 상태를 확인할 수 없습니다.', 'ON_AI_INVALID_INPUT');
      }
      if (!Array.isArray(event.supportedActions) || !Array.isArray(result.proposals)) {
        return renderFailure('연동 시스템의 지원 조치 또는 AI 제안 형식을 확인할 수 없습니다.');
      }
      const proposalsValid = result.proposals.every((proposal) =>
        typeof proposal?.action === 'string' && event.supportedActions.includes(proposal.action)
        && isSafeString(proposal.reason, 500)
        && Array.isArray(proposal.evidenceIds) && proposal.evidenceIds.length > 0
        && new Set(proposal.evidenceIds).size === proposal.evidenceIds.length
        && proposal.evidenceIds.every((id) => evidence.has(id) && references.includes(id)));
      if (!proposalsValid) {
        return renderFailure('제안된 조치가 지원 목록에 없거나 제안의 근거 ID가 현재 사건과 맞지 않습니다.');
      }

      // 모든 검증을 통과한 현재 선택 사건에만 성공 속성을 부여한다.
      root.className = 'explanation';
      root.setAttribute('data-student-explanation-event', event.id);
      appendHeading(root, 'h3', 'AI 설명(참고용)');
      appendMessage(root, '사건 ID: ' + event.id);
      if (isSafeString(checkedAt, 80)) appendMessage(root, '설명 확인 시각: ' + checkedAt, 'muted');
      appendMessage(root, 'AI 요약: ' + result.summary);
      appendMessage(root, 'AI 요약은 해석입니다. 사실 판단은 사건 근거·규칙과 연동 시스템 상태를 따릅니다.', 'muted');

      appendHeading(root, 'h3', '인용한 근거');
      const evidenceList = document.createElement('ul');
      for (const id of references) {
        const li = document.createElement('li');
        li.textContent = id + ' — ' + evidence.get(id);
        evidenceList.append(li);
      }
      root.append(evidenceList);

      appendHeading(root, 'h3', '적용 규칙');
      const ruleList = document.createElement('ul');
      for (const rule of event.rules) {
        const li = document.createElement('li');
        li.textContent = rule.id + ' — ' + rule.text;
        ruleList.append(li);
      }
      root.append(ruleList);

      appendHeading(root, 'h3', '확인 불가 상태');
      const unknown = document.createElement('ul');
      const stateNames = { access: '접속', session: '세션', device: '기기' };
      for (const key of ['access', 'session', 'device']) {
        if (event.state[key] === 'unknown') {
          const li = document.createElement('li');
          li.textContent = stateNames[key] + ': 확인 불가(unknown)';
          unknown.append(li);
        }
      }
      if (unknown.childNodes.length) root.append(unknown);
      else appendMessage(root, '없음', 'muted');

      appendHeading(root, 'h3', 'AI 조치 제안');
      if (!result.proposals.length) {
        appendMessage(
          root,
          event.supportedActions.length === 0
            ? '연동 시스템이 지원하는 조치가 없어 제안이 없습니다(정상).'
            : 'AI가 이 기록에 제안한 조치가 없습니다.',
          'muted',
        );
      } else {
        const proposals = document.createElement('ul');
        for (const proposal of result.proposals) {
          const li = document.createElement('li');
          li.textContent = '조치: ' + proposal.action + ' · 이유: ' + proposal.reason
            + ' · 근거 ID: ' + proposal.evidenceIds.join(', ')
            + ' · 사람 확인이 필요하며 아직 실행되지 않았습니다.';
          proposals.append(li);
        }
        root.append(proposals);
      }
      appendMessage(root, 'AI 설명과 제안만으로 보안 조치는 실행되지 않습니다.', 'muted');
      return root;
    },

    renderAction({ status = 'idle', event, actionId, target, receipt, observation, message,
      confirmationExpiresAt, error } = {}) {
      const root = document.createElement('section');
      const addFieldLine = (name, value) => {
        if ((typeof value !== 'string' || !value.trim()) && !Number.isFinite(value)) return;
        appendMessage(root, name + ': ' + value);
      };
      const safeMsg = (value) => (isSafeString(value, 500) ? value : null);
      const code = typeof error?.code === 'string' && KNOWN_ACTION_CODES.has(error.code)
        ? error.code : 'ACTION_RESULT_UNVERIFIED';

      // 새 호출마다 새 DOM만 만들며, idle에는 옛 사건·대상·영수증을 남기지 않는다.
      if (status === 'idle') {
        appendMessage(root, ACTION_STATUS_MESSAGES.idle, 'state state-empty');
        if (safeMsg(message)) appendMessage(root, '현재 안내: ' + safeMsg(message), 'muted');
        appendMessage(root, '「조치 화면 취소」는 이미 서버에 전달된 조치의 실제 효과를 되돌리지 않습니다.', 'muted');
        return root;
      }

      const eventId = isSafeString(event?.id, 80) ? event.id.trim() : null;
      const currentActionId = isSafeString(actionId, 80) ? actionId.trim() : null;
      const requestId = isSafeString(receipt?.requestId, 80) ? receipt.requestId.trim() : null;
      const inconsistent = (receipt?.eventId != null && eventId !== receipt.eventId)
        || (receipt?.actionId != null && currentActionId !== receipt.actionId)
        || (receipt?.target?.id != null && target?.id !== receipt.target.id)
        || (receipt?.target?.generation != null && target?.generation !== receipt.target.generation);
      if (inconsistent) {
        appendMessage(root, '결과 불명(unknown): 응답의 사건·조치·대상 정보가 현재 선택한 요청과 일치하지 않습니다.', 'state state-error');
        appendMessage(root, '기존 응답을 현재 사건의 성공으로 표시하지 않습니다. 「원천 결과만 재조회」로 확인하세요.', 'muted');
        return root;
      }

      const effectConfirmed = status === 'succeeded'
        && observation?.effectApplied === true
        && typeof observation.observedAt === 'string' && observation.observedAt.trim()
        && Number.isFinite(Date.parse(observation.observedAt))
        && typeof receipt?.receiptId === 'string' && receipt.receiptId.trim()
        && receipt.superseded !== true
        && (receipt.status == null || receipt.status === 'succeeded');

      if (status === 'succeeded') {
        appendMessage(
          root,
          effectConfirmed
            ? '연동 시스템 효과 확인(succeeded) · 실제 원천 관측에 따른 결과입니다.'
            : '결과 불명(unknown): succeeded 상태를 받았지만 실제 효과·관측 시각·영수증을 확인할 수 없습니다.',
          effectConfirmed ? 'action-observed' : 'state state-error',
        );
      } else {
        const bannerClass = ['loading', 'executing', 'pending'].includes(status)
          ? 'state state-loading'
          : ['denied', 'failed', 'error', 'expired'].includes(status)
            ? 'state state-error'
            : 'state state-empty';
        appendMessage(
          root,
          Object.hasOwn(ACTION_STATUS_MESSAGES, status)
            ? ACTION_STATUS_MESSAGES[status]
            : '조치 상태 확인 불가(unknown) · 성공이나 효과 없음으로 판단하지 마세요.',
          bannerClass,
        );
      }

      if (eventId) root.setAttribute('data-student-action-event', eventId);
      if (requestId) root.setAttribute('data-student-action-request', requestId);
      addFieldLine('사건 ID', eventId);
      if (Array.isArray(event?.evidence) && event.evidence.length) {
        const ids = event.evidence
          .filter((row) => isSafeString(row?.id, 80))
          .map((row) => row.id.trim());
        if (ids.length) addFieldLine('근거 ID', ids.join(', '));
      }
      addFieldLine('조치 ID', currentActionId);
      addFieldLine('실제 대상 ID', safeMsg(target?.id));
      addFieldLine('대상 세대(generation)', target?.generation);
      addFieldLine('요청 ID(requestId)', requestId);
      addFieldLine('영수증 ID(receiptId)', safeMsg(receipt?.receiptId));
      addFieldLine('영수증 버전(version)', receipt?.version);

      if (status === 'prepared') {
        addFieldLine('사람 확인 기한', safeMsg(confirmationExpiresAt));
        appendMessage(root, '아직 실행되지 않았습니다. 제공 화면에서 대상과 조치를 확인한 뒤에만 집행을 요청할 수 있습니다.', 'muted');
      }
      if (receipt?.replayed === true) {
        appendMessage(root, '중복 응답(replayed: true): 기존 requestId에 대한 응답입니다. 새로운 조치 집행의 증거가 아닙니다.', 'muted');
      }
      if (receipt?.superseded === true) {
        appendMessage(root, '이전 응답(superseded): 최신 원천 결과를 대신하지 않습니다.', 'muted');
      }
      if (effectConfirmed) {
        addFieldLine('실제 효과 관측 시각(observedAt)', observation.observedAt);
        appendMessage(root, 'effectApplied: true', 'action-observed');
      } else if (status === 'succeeded' || status === 'unknown') {
        appendMessage(root, '조치 효과가 없다고 단정할 수 없습니다. 제공 화면의 「원천 결과만 재조회」로 직접 확인하세요.', 'muted');
      }
      if (status === 'pending' || status === 'executing' || status === 'loading') {
        appendMessage(root, '현재 응답은 집행 완료 또는 효과 확인 결과가 아닙니다.', 'muted');
      }
      if (status === 'denied' || status === 'failed') {
        if (safeMsg(message)) addFieldLine('연동 시스템 안내', safeMsg(message));
      }
      if (status === 'error' || (error && ['denied', 'failed', 'unknown', 'expired'].includes(status))) {
        addFieldLine('오류 코드', code);
        addFieldLine('오류 메시지', safeMsg(error?.message) || '안전한 오류 메시지를 확인할 수 없습니다.');
      }
      if (status === 'unknown') {
        appendMessage(root, '이미 전달된 조치에 대해 효과 없음이나 성공을 추정하지 않고, 결과만 다시 조회하세요.', 'muted');
      }
      if (status === 'expired') {
        appendMessage(root, '만료된 확인 정보는 다시 사용하지 말고 새로운 조치 준비부터 확인하세요.', 'muted');
      }
      if (Array.isArray(event?.supportedActions) && event.supportedActions.length === 0) {
        appendMessage(root, '이 기록은 연동 시스템에서 지원하는 조치가 없어 조치 준비 버튼이 나오지 않는 것이 정상입니다.', 'muted');
      }
      appendMessage(root, '이 학생 화면은 조치 요청을 보내지 않습니다. 조치 확인·전달·재조회는 제공 화면에서만 진행됩니다.', 'muted');
      return root;
    },
  };
}
