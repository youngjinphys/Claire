# 9단계 선택적 엔진 검증 확장 · 학생 로컬 실험

이 문서는 제공된 docs/DETECT_EVENTS.md 계약의 일부가 아닙니다.


아래 확장은 제공된 \`aleph.decision.v1\` 또는 위 3필드 탐지 계약의 **공식 입력이 아닙니다**. 실제 엔진에 적용하려면 별도의 신뢰된 사건 전달/검증 계약을 먼저 제공받아야 합니다.

\`detectVerifiedDeviceAnomaly(events, {verifyEngineEvent})\`의 검증 콜백은 각 사건을 서버·엔진에서 인증한 후 다음 **최소 투영**만 반환해야 합니다.

\`\`\`js
{
  at: '2026-10-01T00:00:00.000Z',
  method: 'GET',
  subject: 'learner_fixture',
  deviceId: 'aaaaaaaaaaaaaaaa',
  decision: 'allow',
  networkBaselineVerified: true,
  networkDeviation: 'unusual'
}
\`\`\`

검증 콜백이 없으면 \`observe\`만 반환합니다. 브라우저에서 보낸 \`deviceId\`, \`network\`, \`decision\`, \`headers\` 등은 직접 입력 증거가 아닙니다. 사용자와 기기를 정확히 매핑하고, 사전에 신뢰할 수 있는 네트워크 기준선과 비교했다는 책임은 콜백을 제공하는 엔진에 있습니다.

동일 가명 사용자·동일 기기의 *검증된 비정상 네트워크상 허용된 GET* 사건이 10분에 **120건 초과**할 경우만 \`{action:'propose_revocation',reasonCode:'unusual_network_burst',subject,deviceId}\`를 반환합니다. 정상 연결·단순 지역 변경·다른 기기 조회 합산·검증 실패는 \`observe\`입니다. 기기를 실제로 회수하지 않으며 시간 측정은 운영 엔진/심판만 할 수 있습니다.
