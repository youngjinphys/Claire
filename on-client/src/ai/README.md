# 서버 AI: 권한·설명·학습지원

[service.mjs](service.mjs), [app-authorization.mjs](app-authorization.mjs), [vault-service.mjs](vault-service.mjs), [learner-support-contract.mjs](learner-support-contract.mjs)가 정본입니다. 통신 파생 코드와 이용 조건은 [vendor/NOTICE.md](../../vendor/NOTICE.md)를 보존합니다.

## 구성

`createOnAiService`는 서버 설정·현재 expectedScope와 승인 verifier를 사용합니다. `ON_AI_BASE_URL`, `ON_AI_APP_KEY`, `ON_AI_MODEL` 값의 존재만으로 이용 권한이 생기지 않습니다. 기본 verifier나 현재 계정·프로젝트 결속이 없으면 준비 중으로 실패합니다. Native Windows 경로는 별도의 현재 context와 자격 보관함을 사용합니다.

| 기능 | 입력/결과의 의미 |
|---|---|
| connectionInfo | 설정 존재 여부와 도움정보. 실제 승인·원격 성공 아님 |
| checkConnection | 현재 앱 권한과 허용 모델 목록 확인. 생성 모델 설명 실행 아님 |
| explainIncident | 서버가 원천 사건에서 만든 최소 근거·규칙·현재 상태·지원 조치를 사용 |
| explainLearningSupport | 유한한 문제 종류·관측 계약에 따라 학습지원 조언 제공. 자유 명령 실행 아님 |

HTTP 신원·권한 검증을 거친 결과와 명시적인 localhost 합성 시험의 `audienceAuthorization: test`를 구별합니다. 임의 callback의 verified 주장이나 브라우저 supplied identity/proof는 운영 승인으로 수용하지 않습니다. 원천 자격과 Workbench 열쇠를 혼용하지 않습니다.

## 사건 설명 검증

사건 설명은 실제 근거 ID를 참조해야 하며 제안은 원천이 지원한 조치만 사용할 수 있습니다. 반환은 사람 확인 필요·미집행 상태를 유지합니다. 누락/알 수 없는 근거, 지원하지 않는 조치, 자유 실행 응답과 명백한 비밀 표기는 검증 실패입니다. 형식/ID 검증이 설명 문장 전체의 진실성을 입증하는 것은 아니므로 사람이 원천 기록과 대조합니다.

학습지원은 원 순수 계약에서 준비한 유한 객체와 현재 검증된 권한을 사용합니다. 사건 DTO·임의 prompt/messages·브라우저 신원을 자유 입력으로 전달하지 않습니다. 기본 로컬 안내와 AI가 작성한 안내는 구별합니다.

## 전송·오류

일반 연결은 허용 HTTPS 경계를 사용하고 리다이렉트를 따르지 않습니다. localhost HTTP/test proof는 명시적인 시험 경로입니다. operation 기한·응답 크기·취소를 제한하고 일반 오류를 자동 재시도하지 않습니다. 모델을 목록 첫 항목으로 임의 선택하지 않습니다. 상세 수치와 허용 필드는 위 구현 파일을 확인합니다.

원격 오류 본문·열쇠·사건 전체·설정 경로를 도움정보로 노출하지 않습니다. AI 실패가 SDP 조회 성공을 취소하거나 실패를 안전 판정으로 바꾸지는 않습니다. 원천 조치 집행은 [actions](../actions/README.md) 경로에서 별도로 처리합니다.

## 재현 범위

앱 폴더에서 `npm test`로 시험을 실행합니다. 이 저장소에는 `education/on-client` 경로가 없습니다. 시험 fixture와 로컬 HTTP 성공은 운영 학생 계정·유료 AI 성공을 의미하지 않습니다. 현재 화면 절차는 [AI_SETUP_GUIDE.md](../../docs/AI_SETUP_GUIDE.md)를 봅니다.
