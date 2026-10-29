export const HISTORY_WINDOW_MS = 10 * 60 * 1000;
export const MAX_SAMPLES = 120;
export const MAX_MEASUREMENT_AGE_MS = 30_000;
export const MAX_CONTIGUOUS_GAP_MS = 15_000;

const METRIC_UNITS = Object.freeze({ cpu: '%', memory: '%', disk: 'GiB' });
const SOURCES = Object.freeze({ cpu: 'os.cpus', memory: 'os.totalmem/os.freemem', disk: 'fs.statfs' });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const int = value => Number.isSafeInteger(value);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
const isText = value => typeof value === 'string' && value.length <= 2000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIdentityStatus = (field, value) => field === 'device' ? ['compliant','noncompliant','unknown'].includes(value) : ['active','expired','revoked','unknown'].includes(value);
const isEvidence = row => isObject(row) && isId(row.id) && isText(row.text);
const isEventState = state => isObject(state)
  && ['allowed','denied','unknown'].includes(state.access)
  && isIdentityStatus('session',state.session) && isIdentityStatus('device',state.device);
const validReason = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value);
const invalid = (key, reason, measuredAt = null) => ({
  status: 'unavailable', value: null, unit: METRIC_UNITS[key], source: SOURCES[key], measuredAt, reason,
});

export function isIso(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function parseMetric(metric, key, checkedAt) {
  if (!metric || metric.unit !== METRIC_UNITS[key] || metric.source !== SOURCES[key] || !isIso(metric.measuredAt)) {
    return invalid(key, 'MEASUREMENT_CONTRACT_INVALID');
  }
  const stamp = Date.parse(metric.measuredAt), observed = Date.parse(checkedAt);
  if (stamp > observed + 1000 || observed - stamp > 15000) return invalid(key, 'MEASUREMENT_TIME_INVALID', metric.measuredAt);
  if (metric.status === 'unavailable') {
    if (metric.value !== null || !validReason(metric.reason)) return invalid(key, 'MEASUREMENT_CONTRACT_INVALID', metric.measuredAt);
    return invalid(key, metric.reason, metric.measuredAt);
  }
  if (metric.status !== 'ok' || !finite(metric.value) || metric.value < 0
      || (key !== 'disk' && metric.value > 100)) return invalid(key, 'MEASUREMENT_INVALID', metric.measuredAt);
  if (key === 'memory') {
    if (!finite(metric.usedGiB) || !finite(metric.totalGiB) || metric.totalGiB <= 0
      || metric.usedGiB < 0 || metric.usedGiB > metric.totalGiB
      || Math.abs(metric.usedGiB / metric.totalGiB * 100 - metric.value) > 3) {
      return invalid(key, 'MEMORY_INVALID', metric.measuredAt);
    }
  }
  if (key === 'cpu' && (!isIso(metric.measuredFrom) || Date.parse(metric.measuredFrom) > stamp
    || !finite(metric.windowMs) || metric.windowMs < 100 || metric.windowMs > 5000
    || stamp - Date.parse(metric.measuredFrom) > 6000)) {
    return invalid(key, 'CPU_INTERVAL_INVALID', metric.measuredAt);
  }
  if (key === 'disk' && metric.scope !== 'project-filesystem') return invalid(key, 'DISK_SCOPE_UNVERIFIED', metric.measuredAt);
  return {
    status: 'ok', value: metric.value, unit: METRIC_UNITS[key], source: SOURCES[key], measuredAt: metric.measuredAt,
    ...(key === 'memory' ? { usedGiB: metric.usedGiB, totalGiB: metric.totalGiB } : {}),
    ...(key === 'cpu' ? { measuredFrom: metric.measuredFrom, windowMs: metric.windowMs } : {}),
  };
}

export function normalizeSnapshot(response) {
  const data = response?.data;
  if (response?.ok !== true || data?.schema !== 'claire.local-pc.v1'
    || data?.scope !== 'local-machine' || !isIso(data.checkedAt)
    || !data.metrics || typeof data.metrics !== 'object' || Array.isArray(data.metrics)) {
    return { status: 'error', reason: 'PC_MEASUREMENT_RESPONSE_INVALID' };
  }
  const metrics = Object.fromEntries(Object.keys(METRIC_UNITS)
    .map(key => [key, parseMetric(data.metrics[key], key, data.checkedAt)]));
  return { status: 'ok', checkedAt: data.checkedAt, metrics };
}

const withinAge = (stamp, now) => isIso(stamp) && Date.parse(stamp) <= now + 1000 && now - Date.parse(stamp) <= MAX_MEASUREMENT_AGE_MS;
function trimHistory(history, now) {
  return (Array.isArray(history) ? history : [])
    .filter(point => finite(point?.time) && point.time > now - HISTORY_WINDOW_MS && point.time <= now + 1000)
    .slice(-(MAX_SAMPLES - 1));
}
export function appendGap(history, now = Date.now()) {
  const recent = trimHistory(history, now);
  if (recent.length && recent[recent.length - 1].time >= now) return recent;
  return [...recent, { time: now, cpu: null, memory: null }];
}
export function appendSample(history, snapshot, now = Date.now()) {
  const recent = trimHistory(history, now);
  if (snapshot?.status !== 'ok' || !withinAge(snapshot.checkedAt, now)) return appendGap(recent, now);
  const time = Date.parse(snapshot.checkedAt);
  if (recent.length && time <= recent[recent.length - 1].time) return recent;
  const percent = key => {
    const metric = snapshot.metrics?.[key];
    return metric?.status === 'ok' && withinAge(metric.measuredAt, now) ? metric.value : null;
  };
  return [...recent, { time, cpu: percent('cpu'), memory: percent('memory') }];
}
// Keep rendering segments consistent with change-analysis baselines: never connect
// samples across failures, clock reversals or extended data-collection gaps.
export function seriesSegments(history, key) {
  if (!Array.isArray(history) || !['cpu', 'memory'].includes(key)) return [];
  const segments = [];
  let segment = [];
  const flush = () => { if (segment.length) segments.push(segment); segment = []; };
  for (const point of history) {
    if (!finite(point?.time) || !finite(point[key]) || point[key] < 0 || point[key] > 100) {
      flush();
      continue;
    }
    if (segment.length) {
      const gap = point.time - segment[segment.length - 1].time;
      if (gap <= 0 || gap > MAX_CONTIGUOUS_GAP_MS) flush();
    }
    segment.push({ time: point.time, value: point[key] });
  }
  flush();
  return segments;
}
export function pairedSamples(history) {
  if (!Array.isArray(history)) return [];
  return history.filter(point => finite(point?.time) && finite(point?.cpu)
    && finite(point?.memory) && point.cpu >= 0 && point.cpu <= 100
    && point.memory >= 0 && point.memory <= 100);
}
export function trendSummary(history) {
  if (!Array.isArray(history)) return null;
  // Only compare continuous, paired samples; a failed or partial read breaks the baseline.
  let segment = [];
  for (const point of history) {
    if (!finite(point?.time) || !finite(point?.cpu) || !finite(point?.memory) || point.cpu < 0 || point.cpu > 100 || point.memory < 0 || point.memory > 100) segment = [];
    else if (segment.length && (point.time <= segment.at(-1).time || point.time - segment.at(-1).time > MAX_CONTIGUOUS_GAP_MS)) segment = [point];
    else segment.push(point);
  }
  if (segment.length < 2) return null;
  const from = segment[0], to = segment.at(-1);
  return {
    cpuDelta: Number((to.cpu - from.cpu).toFixed(1)),
    memoryDelta: Number((to.memory - from.memory).toFixed(1)),
    cpuSamples: segment.length, memorySamples: segment.length,
    from: from.time, to: to.time,
  };
}

export function normalizeSecurity(response) {
  const mode = response?.meta?.mode;
  const checkedAt = isIso(response?.meta?.checkedAt) ? response.meta.checkedAt : null;
  if (!['connected','demo','disconnected'].includes(mode)) return { status:'unavailable', reason:'SOURCE_MODE_UNVERIFIED', mode:'unknown', checkedAt };
  if (response?.ok !== true) return {
    status:'unavailable', mode, checkedAt,
    reason:validReason(response?.error?.code) ? response.error.code : 'SECURITY_LOOKUP_FAILED',
  };
  if (mode === 'disconnected' || !checkedAt) return { status:'unavailable', mode, checkedAt, reason:'SOURCE_MODE_UNVERIFIED' };
  // Match the supplied Claire identity validator. A partial object is not
  // evidence that the operating-system or SDP device is compliant.
  const { user, device, session } = response.data ?? {};
  if (!isObject(user) || !isObject(device) || !isObject(session)
    || !isId(user.id) || !isText(user.label)
    || !isId(device.id) || !isText(device.label) || !isIdentityStatus('device',device.status)
    || !isId(session.id) || !isIdentityStatus('session',session.status)) {
    return { status:'unavailable', mode, checkedAt, reason:'DEVICE_STATUS_UNVERIFIED' };
  }
  return { status:'ok', mode, checkedAt, value:device.status, sessionStatus:session.status };
}

// A valid measurement/SDP response is not necessarily a healthy security state.
// The presentation must never color 'noncompliant' as safe or hide revoked sessions.
export function securityCardState(info, now = Date.now()) {
  if (info?.status !== 'ok' || !isIso(info.checkedAt)) return 'unavailable';
  const delta = now - Date.parse(info.checkedAt);
  if (!Number.isFinite(delta) || delta < -1000 || delta > MAX_MEASUREMENT_AGE_MS) return 'unavailable';
  if (info.mode === 'demo') return 'demo';
  if (info.mode !== 'connected' || !isIdentityStatus('device',info.value)
      || !isIdentityStatus('session',info.sessionStatus)) return 'unavailable';
  if (info.value === 'noncompliant') return 'risk';
  if (info.value === 'unknown') return 'unavailable';
  return info.sessionStatus === 'active' ? 'ok' : 'warning';
}

function coverageValid(coverage, expected, checkedAt, timing) {
  if (!coverage) return true;
  const keys = ['schema','kind','scope','limit','total','returned','truncated','observedAtMs'];
  if (typeof coverage !== 'object' || Array.isArray(coverage) || Object.keys(coverage).length !== keys.length || keys.some(k => !Object.hasOwn(coverage,k))) return false;
  if (coverage.schema !== 'alekov.sdp.coverage.v1' || coverage.kind !== 'events' || coverage.scope !== 'own-recorded-events'
    || coverage.limit !== 40 || !int(coverage.total) || !int(coverage.returned) || coverage.returned !== expected
    || coverage.total < expected || coverage.total < 0 || typeof coverage.truncated !== 'boolean'
    || coverage.truncated !== (coverage.total > expected) || !int(coverage.observedAtMs) || coverage.observedAtMs <= 0) return false;
  const delta = Date.parse(checkedAt) - coverage.observedAtMs;
  if (delta < -5000 || delta > 20000) return false;
  // When request timestamps are available, enforce the original Claire
  // requestedAt/receivedAt source-generation window, not just response metadata.
  return !timing || Number.isFinite(timing.requestedAt) && Number.isFinite(timing.receivedAt)
    && timing.receivedAt >= timing.requestedAt
    && coverage.observedAtMs >= timing.requestedAt - 5000
    && coverage.observedAtMs <= timing.receivedAt + 5000
    && timing.receivedAt - coverage.observedAtMs <= 20000;
}

export function normalizeEvents(response, timing = null) {
  const mode = response?.meta?.mode;
  const checkedAt = isIso(response?.meta?.checkedAt) ? response.meta.checkedAt : null;
  if (!['connected', 'demo', 'disconnected'].includes(mode)) return { status: 'unavailable', reason: 'SOURCE_MODE_UNVERIFIED', checkedAt, mode: 'unknown', events: [] };
  if (response?.ok !== true) return { status: 'unavailable', reason: validReason(response?.error?.code) ? response.error.code : 'EVENT_LOOKUP_FAILED', checkedAt, mode, events: [] };
  if (mode === 'disconnected' || !checkedAt) return { status: 'unavailable', reason: 'SOURCE_MODE_UNVERIFIED', checkedAt, mode, events: [] };
  if (!Array.isArray(response.data) || response.data.length > 40 || !coverageValid(response.coverage, response.data.length, checkedAt, timing)) {
    return { status: 'unavailable', reason: 'EVENT_RESPONSE_INVALID', checkedAt, mode, events: [] };
  }
  const seen = new Set();
  const events = [];
  for (const row of response.data) {
    // Preserve the complete supplied event contract even though this dashboard
    // displays only a projection. No malformed or non-owned response can appear
    // as a verified security event.
    if (!isObject(row) || !isId(row.id)
      || seen.has(row.id) || !['access', 'xdr'].includes(row.kind) || !isIso(row.at)
      || !isText(row.summary) || (row.appId != null && !isId(row.appId))
      || !Array.isArray(row.evidence) || !row.evidence.every(isEvidence)
      || !Array.isArray(row.rules) || !row.rules.every(isEvidence)
      || !isEventState(row.state)
      || !Array.isArray(row.supportedActions) || !row.supportedActions.every(isId)) {
      return { status: 'unavailable', reason: 'EVENT_RESPONSE_INVALID', checkedAt, mode, events: [] };
    }
    seen.add(row.id);
    events.push({ id: row.id, kind: row.kind, at: row.at, summary: row.summary.slice(0, 500), appId: row.appId ?? null });
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { status: 'ok', checkedAt, mode, events,
    total: response.coverage?.total ?? null, truncated: response.coverage?.truncated === true };
}
