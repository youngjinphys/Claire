# 사람 확인 조치 모듈

근거: [service.mjs](service.mjs), [store.mjs](store.mjs), [시작 설정](action-startup-config.mjs), [SDP 어댑터](sdp-action-engine.mjs), [서버](../server.mjs). 기본 미지원과 명시적으로 설정된 원천 조치 경로를 구별합니다. 로컬 호스트 보고서 수집기와 별개의 쓰기/집행 기능입니다.

## 호출 계약

```js
createActionService({ engine, resolveContext, databasePath, policy, clock })
service.prepare({ eventId, actionId }, { signal })
service.execute({ requestId, confirmationId }, { signal })
service.readResult({ requestId }, { signal })
```

정책·현재 서버 신원 resolver·원천 readEvents/authorizeAction/executeAction/readActionResult가 없으면 `ACTION_UNSUPPORTED`입니다. 기존 절대 경로의 SQLite를 검증하여 자기 intent/state/audit 테이블을 사용합니다. 새 DB를 임의로 만들거나 학생 자료 테이블을 복구/삭제하지 않습니다.

`policy`는 앱·audience·accessPolicyId·allowedActions·confirmationTtlMs 및 선택적 timeoutMs를 제한합니다. `resolveContext`의 subject/project/session/identityVersion와 engineGeneration/sourcePolicyVersion 등 현재 서버 검증 문맥을 각 비동기 경계에서 대조합니다. 브라우저 역할 플래그나 AI 응답은 그 문맥을 만들 수 없습니다.

## 준비·전달·효과

prepare는 사건·대상·지원 조치·권한·스냅샷에 묶인 일회성 확인 정보를 발급합니다. 사람 확인 뒤 execute에서 이를 소비하고 dispatch 예약을 먼저 원장에 남깁니다. 같은 요청 재전달은 새 원천 집행으로 단순 반복하지 않습니다.

| 결과 | 의미 |
|---|---|
| prepared | 준비됨, 아직 집행 아님 |
| pending | 원천 요청 접수. 효과 확인 아님 |
| denied/failed | 원천 거부/실패 |
| unknown | 취소·기한·응답 또는 결과 검증 불명. 효과 없음으로 단정하지 않음 |
| succeeded | 별도 결과 조회에서 같은 요청·대상·스냅샷의 실제 적용 효과 확인 |

전송 후 취소는 원천 작업을 되돌렸다는 뜻이 아닙니다. 재시작 시 불확실한 예약을 자동 재집행하지 않으며 결과 확인을 우선합니다. 로컬 중복 방지 원장만으로 모든 원천의 exactly-once 효과를 보장하지 않습니다.

AI 모듈은 이 서비스의 집행 함수를 자동 호출하지 않습니다. 기본 관측 작업에는 조치 설정이 필요하지 않습니다. 실제 운영 권한·원천 효과·DB 이력은 별도 확인 대상이며 문서 개정을 위해 설정·집행하지 않습니다.

[구현 경계](../../docs/IMPLEMENTATION_CONTRACT.md) · [문제 해결](../../docs/CONNECTION_TROUBLESHOOT.md)
