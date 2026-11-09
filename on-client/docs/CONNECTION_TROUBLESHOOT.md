# 연결·조회 문제 해결

먼저 실패 위치를 구분합니다. 로컬 서버 실행, 보고서 파일 읽기, OS 자원 관측, SDP, Native 로그인, AI 앱 승인과 모델 조회는 별개입니다. [실행 안내](STUDENT_LAUNCH_GUIDE.md)의 같은 폴더를 유지하고 강제 초기화·권한 상승·보안 설정 변경으로 해결하려 하지 않습니다.

| 증상/코드 | 확인할 것 | 하지 말 것 |
|---|---|---|
| 실행 위치/Node 오류 | `on-client/package.json`, 지원 선언 Node 22–24 또는 26 계열, CI 기준 24.19.0 | 루트에서 로컬 앱 시작 스크립트 추정 |
| 포트 충돌 | ON_PORT 또는 기존 실행 도구의 Port 옵션, 브라우저 포트 | 다른 프로세스 강제 종료 |
| 보고서 미선택 | 일반 권한 수집 명령 후 출력 파일 선택 | DEMO 숫자로 대체 |
| `REPORT_TOO_LARGE`, `INVALID_REPORT` | 128 KiB 상한, 수집기 JSON 형식 | 원본을 임의 편집해 검증 우회 |
| `FILE_READ_FAILED`, `FILE_READ_TIMEOUT` | 현재 계정의 파일 접근·새 보고서 선택 | 관리자 재실행, 자동 반복 |
| `PERMISSION_DENIED`, `COMMAND_NOT_FOUND` | 해당 OS 도구와 일반 권한 지원 범위 | 방화벽 시작/중지·권한 상승 |
| `EVENT_LIMIT_EXCEEDED` | 로그별 2,000건 상한과 집계 구간 | 일부 건수를 정확한 총수로 표시 |
| `WINDOWS_ONLY` | macOS/Linux의 해당 없음 | 0건 또는 실패한 Windows 조회로 취급 |
| 오래됨/시계 불일치 | 보고서와 원천별 조회 기준 시각, 15분/미래 5초 기준 및 최대 15초 표시 지연 | 재선택 시 시각을 현재로 덮어쓰기 |
| 동일 생성 시각의 상충 보고서 | 두 파일의 정규화 값이 다른지, 새 수집기 실행 시각을 확인 | 상충 이력을 비교에 이용하거나 파일 지문을 실제 장치 인증으로 주장 |
| `ENGINE_NOT_CONNECTED` | SDP 설정 유무·기존 제공 연결 상태 | PC 조회 성공을 SDP 성공으로 간주 |
| `ENGINE_RESULT_UNVERIFIED`, `SUBJECT_SCOPE_UNVERIFIED` | 서버가 검증한 현재 신원·범위·응답 계약 | 빈 성공 응답으로 대체 |
| `ON_AI_PROVISIONING_PENDING` | 계정·프로젝트·앱 권한의 운영자 준비 | 주소/열쇠만 넣어 연결 우회 |
| `ALEKOV_CONNECT_OUTCOME_UNKNOWN` 등 결과 불명 | 상태 다시 확인, 비밀 없는 오류 코드 | 취소 요청만으로 원격 승인 취소 단정 |
| `MODEL_NOT_CONFIGURED`, `ON_AI_MODEL_LIST_EMPTY` | 운영자가 승인한 모델·권한 | 첫 모델을 임의 선택 |
| `ACTION_UNSUPPORTED` | 명시적인 조치 설정과 원천 지원 | AI 제안을 직접 실행 |
| `ACTION_TIMEOUT`, 결과 unknown | 원천 결과 확인 | 같은 조치를 새 요청으로 자동 재집행 |
| 패키지 미조회/`unverifiable` | 프로젝트·승인 목록·lock/설치 메타데이터 | 실패를 취약점 없음으로 표시 |

## 다음 행동과 도움정보

화면의 **도움정보** 또는 **연결 도움정보**를 먼저 읽고 필요한 코드·버전·시각만 전달합니다. 토큰·키·인증서·계정·원시 로그·내부 IP/DNS 보고서는 공개하지 않습니다. 로컬 JSON을 읽은 브라우저가 파일의 진위나 동일 물리 PC를 인증하지 않습니다.

SDP 설정은 [SDP 연결](SDP_HOST_CONNECTION.md), Native 계정/AI는 [AI 연결](AI_SETUP_GUIDE.md), 호스트 실패는 [수집 정의](../student/HOST_OBSERVATION.md)를 봅니다. 새 외부 문서를 가정하거나 존재하지 않는 업데이트 도구를 실행하지 않습니다.

현재 코드에 남아 있는 **원본 진위·실기기·원천 완전성** 등의 한계는 [CURRENT_LIMITATIONS.md](../../docs/CURRENT_LIMITATIONS.md)에 기록합니다. 문서에 해결 절차가 있다는 사실은 결함이 수정됐다는 증거가 아닙니다.
