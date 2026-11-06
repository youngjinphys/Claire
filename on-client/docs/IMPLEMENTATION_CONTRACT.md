# Claire 구현 계약과 표시 경계

근거는 [서버](../src/server.mjs), [엔진](../src/engine.mjs), [학생 뷰](../student/extension.mjs)입니다. 외부 포털의 단계 개방·담당자 채널·순위/채점 정책은 앱 코드의 계약이 아니므로 이 문서에서 정의하지 않습니다.

## 진입 경로

| 경로 | 책임 |
|---|---|
| `GET /api/me`, `/api/devices`, `/api/sessions` | 현재 원천의 본인 신원·기기·세션 |
| `GET /api/apps`, `POST /api/access` | 앱 목록 및 선택 앱의 접근 판정 |
| `GET /api/events` | 본인 접속·XDR 기록, 필요한 범위 정보 |
| `GET /api/local-pc` | 서버 실행 OS의 자원 관측 |
| `GET /api/vulnerabilities` | 서버에서 승인한 공개 패키지 대조 |
| `GET /api/diagnostics` | 제한된 진단 상태 |
| `POST /api/ai/check`, `/api/ai/explain` | 권한·모델 목록과 근거 결속 사건 설명을 구분 |
| `POST /api/ai/connect/{start,finish,status,cancel}` | 별도 앱 승인·현재 진행 조회 |
| `POST /api/native-login/...` | 설정된 Native 계정 연결 경로 |
| `POST /api/actions/{prepare,execute,result}` | 사람 확인과 현재 원천 권한을 검증하는 별도 조치 경로 |

경로마다 요청 필드·상태 코드·응답 투영이 다릅니다. 공통적으로 성공 자료와 오류를 구분하며 `meta.mode`의 connected/demo/disconnected는 결과의 출처 모드이지 모든 기능의 성공 판정이 아닙니다. 새로운 경로·필드를 문서만으로 추가하지 않습니다. 학습지원의 유한 요청/응답은 [AI 모듈](../src/ai/README.md)의 실제 계약을 따릅니다.

## 학생 뷰와 호스트 파일

`createStudentView()`의 기존 렌더링 훅과 `hostPanel(state, mode)`를 유지합니다. `[data-host-report-details]`와 `state.hostRedraw`는 통합 화면 재사용 경계입니다. 수집 보고서는 브라우저에서 수동 선택·검증하며 새 HTTP 수집 API나 자동 명령 실행을 만들지 않습니다.

기본 동작은 미연결, 예제는 DEMO, 미조회는 미조회입니다. 일부 원천 성공은 전체 성공이 아니며 실제 0과 실패의 null을 구분합니다. 각 값에 단위·원천·조회/측정 시각을 표시하고, 로그 집계는 침해·공격 탐지라고 설명하지 않습니다.

## 비밀·권한·효과

브라우저 입력으로 서버 자격·신원·원천 정책을 선택하지 않습니다. AI 제안은 지원된 조치 ID와 사건 근거를 참조할 수 있지만 집행 명령이 아닙니다. `prepared`는 미실행, `pending`은 접수, `succeeded`는 별도의 검증된 효과 관측이 필요합니다. 시간 초과·취소가 효과 없음의 증명은 아닙니다.

[AI](AI_SETUP_GUIDE.md), [SDP](SDP_HOST_CONNECTION.md), [조치 모듈](../src/actions/README.md), [취약점 모듈](../src/vulnerabilities/README.md)을 구분하여 확인합니다. 코드 존재·단위시험·실제 운영 연결·공식 판정은 서로 대체하지 않습니다.
