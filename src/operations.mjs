// Evidence calculations shared by the API, visual dashboard and isolated tests.
// Never accept UI labels, fixtures or a local PASS string as official judgement.
import { RULE_IDS } from './decider.mjs';

export const STAGES_REQUIRED = 12;
export const ATTACK_TYPES_REQUIRED = 41;
export const PROBES = Object.freeze([
  { id: 'deployment_manifest', stage: 12, mode: 'normal',
    method: 'GET', path: '/aleph.json', expected: 'HTTP 200, 배포 단계 12 및 서명 없는 공개 배포 식별자 일치' },
  { id: 'static_redaction', stage: 2, mode: 'normal',
    method: 'GET', path: '/data.json', expected: 'HTTP 200, 공개 메모는 빈 배열이며 no-store' },
  { id: 'anonymous_notes', stage: 3, mode: 'forbidden',
    method: 'GET', path: '/api/notes', expected: 'HTTP 401 UNAUTHORIZED, Bearer 인증 요구, 내용 미노출' },
  { id: 'anonymous_restore', stage: 10, mode: 'forbidden',
    method: 'GET', path: '/api/restore/notes/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expected: '인증 없는 복구 불허; 준비 전 503은 복구 성공으로 볼 수 없음' },
  { id: 'authenticated_notes', stage: 5, mode: 'normal',
    method: 'GET', path: '/api/notes', expected: '유효한 학생 세션으로 HTTP 200, X-Resource-Zone: memo' },
]);

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/u;
const TRACE = /^[A-Za-z0-9:._-]{1,160}$/u;
const OUTCOMES = Object.freeze(['verified', 'failed', 'inconclusive', 'unrun']);
export function redactResponse(response, errorCode = null) {
  const read = (name) => response?.headers?.get?.(name) ?? null;
  const ref = read('x-vercel-id') ?? read('x-request-id');
  return {
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    requestId: typeof ref === 'string' && TRACE.test(ref) ? ref : null,
    errorCode: typeof errorCode === 'string' && REASON.test(errorCode) ? errorCode : null,
  };
}

export function summarizeObservations(records) {
  const counts = { verified: 0, failed: 0, inconclusive: 0, unrun: 0 };
  for (const r of records) {
    if (OUTCOMES.includes(r.outcome)) counts[r.outcome]++;
    else counts.inconclusive++;
  }
  return { ...counts, observed: records.length - counts.unrun,
    httpCount: records.filter(r => Number.isInteger(r.httpStatus)).length };
}

export function operationsSnapshot(records, { target, commit = null } = {}) {
  const safe = records.map(r => {
    const probe = PROBES.find(c => c.id === r.id);
    if (!probe) throw new Error('unknown_operations_probe');
    return {
      id: probe.id, stage: probe.stage, mode: probe.mode,
      method: probe.method, path: probe.path, expected: probe.expected,
      httpStatus: Number.isInteger(r.httpStatus) ? r.httpStatus : null,
      requestId: typeof r.requestId === 'string' && TRACE.test(r.requestId) ? r.requestId : null,
      errorCode: typeof r.errorCode === 'string' && REASON.test(r.errorCode) ? r.errorCode : null,
      checkedAt: /^\d{4}-\d{2}-\d{2}T/.test(r.checkedAt || '') ? r.checkedAt : null,
      outcome: OUTCOMES.includes(r.outcome) ? r.outcome : 'inconclusive',
      source: Number.isInteger(r.httpStatus) ? 'server_http_response' : 'not_observed',
    };
  });
  return {
    schema: 'aleph.operations.snapshot.v1',
    target: typeof target === 'string' && /^https:\/\/[a-z0-9.-]+$/iu.test(target) ? target : null,
    deployCommit: /^[a-f0-9]{40}$/iu.test(commit || '') ? commit : null,
    policy: { source: 'student_decider_code', rules: [...RULE_IDS],
      liveEngineDecisions: null, verifiedByEngine: false },
    detection: { source: 'student_detector_code', rule: 'burst_read',
      condition: 'GET > 120 / 10 min / verified subject', eventCount: null,
      liveEventObserved: false },
    revocation: { source: 'ALEPH_SDP_engine_not_connected_to_snapshot',
      executed: null, effectiveAt: null },
    recovery: { verifiedBackupVersion: null, restoredVersion: null,
      readbackVerified: false, liveRestored: false },
    verdict: {
      stagesVerified: 0, stagesRequired: STAGES_REQUIRED,
      attackTypesVerified: 0, attackTypesRequired: ATTACK_TYPES_REQUIRED,
      officialJudgeEvidence: false, complete: false,
    },
    records: safe,
    summary: summarizeObservations(safe),
  };
}
