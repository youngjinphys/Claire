// Student-owned rules. This input is attested by the ALEPH engine, not the browser.
// Keep the stage-6 device check before the stage-7 synthetic risk rule.
export const RULE_IDS = Object.freeze(['device_registered', 'step_up_required', 'memo_zone', 'announcement_read', 'announcement_instructor_write']);

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DEVICE_ID = /^[0-9a-f]{16}$/u;
const MEMO_ITEM_PATH = /^\/notes\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|demo)$/iu;
const ANNOUNCEMENT_ITEM_PATH = /^\/announcements\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|notice-demo)$/iu;
const ANNOUNCEMENT_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EMPTY_QUERY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// The SDP contract contains no attested owner or instructor role.
// API handlers check persisted memo owner_id and verified instructor app_metadata.
// The SDP handles method + exact resource-zone path, not impersonable role aliases.
function classifyRequest(request) {
  if (request?.service !== 'notes' || typeof request?.path !== 'string'
      || request.queryLength !== 0 || request.querySha256 !== EMPTY_QUERY_SHA256) return null;
  const { path, method, route } = request;

  // ALL notice writes denied at SDP, including requests claiming to be instructors.
  const itemNotice = ANNOUNCEMENT_ITEM_PATH.test(path);
  if (ANNOUNCEMENT_WRITE_METHODS.has(method) && (itemNotice || path === '/announcements')) {
    const expected = path === '/announcements'
      ? method + ' /announcements' : method + ' /announcements/:id';
    return route === expected ? { kind: 'announcement_write' } : null;
  }
  if (itemNotice && method === 'GET' && route === 'GET /announcements/:id') {
    return { kind: 'announcement_read' };
  }

  // A SINGLE memo item is eligible. No /notes collection, /notes/export,
  // trailing segments, method query flags, or wildcard sibling endpoints.
  if (MEMO_ITEM_PATH.test(path) && ['GET', 'PUT'].includes(method)
      && route === method + ' /notes/:id') {
    return { kind: 'memo_item' };
  }
  return null;
}

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

// These values appear in scripts/fixture-7.mjs and docs/DECIDER_REQUEST.md.
// "none"/"unknown" is the real engine's explicit absence of location evidence.
// Do not interpret it as "local", "usual", or trustworthy geographic evidence.
function validatedContext(request) {
  const { at, signals, recentEvents, stepUp } = request ?? {};
  if (typeof at !== 'string' || !UTC_ISO.test(at)
      || !Number.isFinite(Date.parse(at))
      || !signals || typeof signals !== 'object' || Array.isArray(signals)
      || !Number.isInteger(signals.hour) || signals.hour < 0 || signals.hour > 23
      || !Array.isArray(recentEvents) || recentEvents.length > 12
      || !recentEvents.every(event => event && typeof event === 'object'
        && !Array.isArray(event) && typeof event.kind === 'string'
        && event.kind.length > 0 && Number.isInteger(event.ageSeconds)
        && event.ageSeconds >= 0 && Number.isInteger(event.count)
        && event.count >= 0)
      || !stepUp || typeof stepUp !== 'object' || Array.isArray(stepUp)
      || !(stepUp.verified === false && stepUp.authAgeSeconds === null
        || stepUp.verified === true && Number.isInteger(stepUp.authAgeSeconds)
          && stepUp.authAgeSeconds >= 0 && stepUp.authAgeSeconds <= 900)) {
    return null;
  }

  if (signals.source === 'none') {
    if (signals.region !== 'unknown' || signals.network !== 'unknown') return null;
    return { signalKind: 'unavailable', signals, recentEvents, stepUp };
  }

  if (signals.source === 'judge_fixture') {
    if (!['local', 'foreign'].includes(signals.region)
        || !['usual', 'unusual'].includes(signals.network)) return null;
    return { signalKind: 'virtual', signals, recentEvents, stepUp };
  }

  // Unrecognized provenance, browser headers and request.geo are not evidence.
  return null;
}

function syntheticStepUpRequired(context) {
  if (context.signalKind !== 'virtual') return false;
  const { signals, recentEvents } = context;
  // The fixture calls this kind "risk_signal"; it is NOT independent proof
  // of a high real-world document read volume.
  const unusualTime = signals.hour < 6 || signals.hour >= 22;
  const unfamiliarNetwork = signals.network === 'unusual';
  const recentBurst = recentEvents.some(item =>
    item.kind === 'risk_signal' && item.ageSeconds <= 120 && item.count >= 20);
  return unusualTime && unfamiliarNetwork && recentBurst;
}

export function decide(request) {
  const zone = classifyRequest(request);
  const inScope = request?.schema === 'aleph.decision.v1' && zone !== null
    && typeof request?.classId === 'string' && request.classId.length > 0
    && typeof request?.projectId === 'string' && request.projectId.length > 0;
  const registered = request?.deviceRegistered === true
    && typeof request?.subjectId === 'string' && SUBJECT.test(request.subjectId)
    && typeof request?.deviceId === 'string' && DEVICE_ID.test(request.deviceId);

  let decision = 'deny', reasonCode = 'starter_not_ready', ruleIds = [RULE_IDS[0]];

  if (inScope && !registered) {
    reasonCode = 'device_not_registered';
  } else if (inScope && registered) {
    // Preserve stage-7 validation. No authorization on malformed/untrusted context.
    const context = validatedContext(request);
    if (context) {
      const zoneRule = zone.kind === 'memo_item' ? 'memo_zone'
        : zone.kind === 'announcement_read' ? 'announcement_read'
          : 'announcement_instructor_write';
      ruleIds = [RULE_IDS[0], zoneRule];

      if (zone.kind !== 'announcement_write') {
        // Per-memo DB ownership is verified by the API, never invented here.
        decision = 'allow';
        reasonCode = 'approved';
        if (syntheticStepUpRequired(context)) {
          ruleIds = [RULE_IDS[0], RULE_IDS[1], zoneRule];
          const recentlyVerified = context.stepUp.verified === true
            && context.stepUp.authAgeSeconds <= 120;
          if (!recentlyVerified) {
            decision = 'step_up';
            reasonCode = 'step_up_required';
          }
        }
      }
    }
  }
  return {
    schema: 'aleph.decision.v1',
    requestId: typeof request?.requestId === 'string' ? request.requestId : '',
    decision, reasonCode, ruleIds,
  };
}
