// The engine authenticates and binds subject, device and route before calling
// this student policy. Browser-supplied identities are never trusted here.
export const RULE_IDS = Object.freeze(['device_registered']);
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DEVICE_ID = /^[0-9a-f]{16}$/u;
const READ_PATH = /^\/notes\/[A-Za-z0-9._~-]{1,128}$/u;

export async function decide(request) {
  const inScope = request?.schema === 'aleph.decision.v1'
    && request?.service === 'notes'
    && request?.method === 'GET'
    && request?.route === 'GET /notes/:id'
    && typeof request?.path === 'string'
    && READ_PATH.test(request.path)
    && typeof request?.classId === 'string' && request.classId.length > 0
    && typeof request?.projectId === 'string' && request.projectId.length > 0;

  // deviceRegistered must be an ENGINE attestation for this subject-device
  // pair. V1 contains no independent ownership proof for an arbitrary pair.
  const registered = request?.deviceRegistered === true
    && typeof request?.subjectId === 'string' && SUBJECT.test(request.subjectId)
    && typeof request?.deviceId === 'string' && DEVICE_ID.test(request.deviceId);

  return {
    schema: 'aleph.decision.v1',
    requestId: typeof request?.requestId === 'string' ? request.requestId : '',
    decision: inScope && registered ? 'allow' : 'deny',
    reasonCode: !inScope ? 'starter_not_ready'
      : registered ? 'approved' : 'device_not_registered',
    ruleIds: [RULE_IDS[0]],
  };
}
