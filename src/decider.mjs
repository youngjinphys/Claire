// Student-owned rules. This input is attested by the ALEPH engine, not the browser.
// Keep the stage-6 device check before the stage-7 synthetic risk rule.
export const RULE_IDS = Object.freeze(['device_registered', 'step_up_required']);

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DEVICE_ID = /^[0-9a-f]{16}$/u;
const READ_PATH = /^\/notes\/[A-Za-z0-9._~-]{1,128}$/u;
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

export async function decide(request) {
  const inScope = request?.schema === 'aleph.decision.v1'
    && request?.service === 'notes'
    && request?.method === 'GET'
    && request?.route === 'GET /notes/:id'
    && typeof request?.path === 'string' && READ_PATH.test(request.path)
    && typeof request?.classId === 'string' && request.classId.length > 0
    && typeof request?.projectId === 'string' && request.projectId.length > 0;

  // This boolean must be attested by the engine for the subject/device pair.
  const registered = request?.deviceRegistered === true
    && typeof request?.subjectId === 'string' && SUBJECT.test(request.subjectId)
    && typeof request?.deviceId === 'string' && DEVICE_ID.test(request.deviceId);

  let decision = 'deny';
  let reasonCode = 'starter_not_ready';
  let ruleIds = [RULE_IDS[0]];

  if (inScope && !registered) {
    reasonCode = 'device_not_registered';
  } else if (inScope && registered) {
    const context = validatedContext(request);
    if (context) {
      decision = 'allow';
      reasonCode = 'approved';
      if (syntheticStepUpRequired(context)) {
        ruleIds = [RULE_IDS[0], RULE_IDS[1]];
        // Fixture-only replay: engine-provided 'verified' plus a recent age
        // is necessary, not proof that production reauthenticated THIS subject.
        const recentlyVerified = context.stepUp.verified === true
          && context.stepUp.authAgeSeconds <= 120;
        if (!recentlyVerified) {
          decision = 'step_up';
          reasonCode = 'step_up_required';
        }
      }
    }
  }

  return {
    schema: 'aleph.decision.v1',
    requestId: typeof request?.requestId === 'string' ? request.requestId : '',
    decision,
    reasonCode,
    ruleIds,
  };
}
