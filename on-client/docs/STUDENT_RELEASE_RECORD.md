> **2026-10-27 현재 코드 안내:** 아래 표는 과거 단계의 실제 테스트 결과를 기록하므로 당시의 `케셰브` 명칭과 HTTP 버전 `0.1.0`을 보존합니다. 현재 화면·PowerShell 성공 메시지는 Claire이며, 진단 제품 버전은 패키지 `0.2.11`에서 읽습니다. 현재 커밋에 대한 CI 결과를 별도로 확인해야 합니다.

> **2026-10-26 유지보수 이후 변경:** 아래 22단계 재현 내역과 SHA는 과거의 실측 스냅샷입니다. 현재 코드에서는 기존 26개 테스트와 신규 Claire 로컬 HTTP 회귀 검증, CI를 추가했습니다. `/api/diagnostics`의 `data.version`은 `on-client/package.json`에서 읽으며, 과거에 실측된 `0.1.0` 응답을 현재 버전으로 재해석하지 않습니다. 현재 앱 버전은 `0.2.11`이며 운영 연결·공식 판정은 여전히 미확인입니다.

# Claire — 22단계 재현 및 릴리스 기록

## 버전과 증거의 범위

상태는 **검증 중**이다. 22단계 공식 통과, 운영 인증, v1.0 릴리스를 선언하지 않는다. 19단계 실집행 연결은 과제 안내상 아직 준비되지 않았으며 시험 집행하지 않았다.

| 항목 | 기록 |
|---|---|
| 저장소 | https://github.com/youngjinphys/Claire |
| 기준 브랜치 | main |
| 최초 실측 SHA(이력 보존) | `f3b6b3ef9555a83f144d352bf2e07876f71152ec` — 이전 이력 보존 |
| 직전 제출 SHA 실측 | `c677b167fb61c30b46879b07f23ecf2193f6eda6` — 2026-10-26 00:44:30 UTC (런타임 지문 `e4d1a2c0e654e115d3188a749d34ffa6445410c23335ebe5d918785d138b25d6`) |
| **현재 리팩토링 실측 (기준 HEAD `c677b167…` 위 작업 트리)** | 2026-10-26 05:54:20 UTC (`student/extension.mjs` blob `52aa5c662fbfb5a0fd8cb07fba9b2bf7ce9383ef`, 런타임 지문 `2dd9358da1c80aa43dfe061d0f49a8a894c69da515edc0e5ce8f88098cac65a0`) |
| **문서 갱신으로 생성되는 최종 제출 커밋** | 평가 대상 `HEAD`의 40자리 SHA를 `git rev-parse HEAD`로 동적 확정·대조. 자기 Git SHA를 파일에 직접 기입할 수 없음 |
| 앱 패키지 버전 | `on-client/package.json`: `0.2.11` (이번 단계에서 변경 없음) |
| 진단 응답 버전 | `src/server.mjs`의 `/api/diagnostics`: `0.1.0` 고정값. 패키지 버전과 다르며 실제 HTTP 응답에서도 관측했다. |
| 명세 런타임 | `engines.node`: `24.19.0`; PowerShell 도구 허용 범위와 정확 버전 일치는 별개 |
| 최초 실측 환경 | Linux 6.18.55 x86_64, Node.js `v24.22.1`, npm `11.9.0`, Git `2.51.1` |
| 직전 제출 커밋 재실측 환경 | 별도 Linux 샌드박스, Node.js `v24.22.1`, npm `11.19.1`, 작업 트리 변경 0건 |
| **현재 Linux PC 실측 환경** | Linux 7.0.0-38-generic x86_64, Node.js `v26.7.0`, npm `11.19.0`, Git `2.53.0`, Google Chrome `155.0.8059.84` (`/usr/bin/google-chrome --headless=new`) |
| Windows PC 실측 | 미확인. 현재 작업 환경은 Linux이며 Windows PowerShell 자격 보관함은 실행하지 않음 |

이 기록은 **AI 작업 환경의 실제 명령 실행**, **원문 확인**, **학생 직접 확인**을 구분한다. 서버의 AI 원문 검토가 새 환경에서 명령을 실행했다는 뜻은 아니다. 과거 커밋의 모의 DOM 검사나 Vercel 상태를 이번 최종 버전의 전체 통과로 합산하지 않는다.

**검증 대상의 결속:** `STUDENT_REPRO_EVIDENCE.json`의 `testedCommit: "HEAD"`는 **해당 단계에서 제출한 현재 커밋 SHA**를 `git rev-parse HEAD`로 해석한다. Git은 문서 내용을 SHA에 포함하므로 자기 커밋 해시를 같은 파일에 하드코딩할 수 없다. 별도로 실측된 제출 SHA `f3b6b3ef…`를 기록하고, 평가 커밋에서도 정확한 Git SHA·런타임 코드 지문·기본 기동을 다시 확인한다. 이전 커밋의 결과를 SHA만 바꿔 현재 결과로 주장하지 않는다.

```bash
git rev-parse HEAD
git status --short
git ls-tree -r HEAD -- on-client/package.json on-client/src on-client/public on-client/student on-client/tools | sha256sum
```

2026-10-26 00:44:30 UTC에 **직전 제출 SHA `c677b167fb61c30b46879b07f23ecf2193f6eda6`**를 새 Linux 샌드박스에 원격 Git 복제해 `HEAD`·작업 트리·문법·HTTP·종료·재시작을 직접 확인했으며(당시 런타임 지문 `e4d1a2c0e654e115d3188a749d34ffa6445410c23335ebe5d918785d138b25d6`), 이어서 2026-10-26 05:54:20 UTC에 `on-client/student/extension.mjs` 보안 에이전트 리팩토링 및 시각적 검토 개선(90px 레이아웃 용어 줄바꿈 방지, 한국어 로캘 시각 서식화, 섹션 간 여백 확보, 상세 펼치기/접기 동적 버튼, 주의 알림 태그 시각화) 후 실행 Git blob 목록의 SHA-256 지문 `2dd9358da1c80aa43dfe061d0f49a8a894c69da515edc0e5ce8f88098cac65a0`과 headless Chrome(`Google Chrome 155.0.8059.84`) 전 탭 DOM 렌더링을 확인했다. 지문 범위는 `on-client/package.json`, `on-client/src`, `on-client/public`, `on-client/student`, `on-client/tools`이며 실제 운영 SDP·XDR·AI 연결의 성공 증거는 아니다.

## 기존 작업 보존과 새 폴더 재현 절차

[21단계 실행 설명서](STUDENT_RUNBOOK.md)와 [구성도](STUDENT_ARCHITECTURE.md)를 함께 사용한다. 아래 명령은 **Linux Bash**용이다. 기존 프로젝트에서 먼저 `pwd`, `git status --short`, `git rev-parse HEAD`를 확인하고 결과를 프로젝트 밖 개인 기록에 남긴다. 미커밋 파일은 그대로 보존한다. 기존 폴더에서 pull/reset/clean을 실행하거나 인증 파일을 새 복제본으로 복사하지 않는다.

**1. 새 터미널에서 새 작업 부모 폴더로 이동한다.** 아래 목적 폴더가 이미 존재하면 다른 새 이름을 선택한다. Git은 기존 비어 있지 않은 폴더를 덮어쓰지 않는다. `FINAL_COMMIT`의 안내 문자열을 실제 보고받은 최종 40자리 SHA로 바꾼다. 값을 모르면 다음 명령을 실행하지 않는다.

```bash
FINAL_COMMIT='여기에_제출할_최종_40자리_SHA'
if [[ "$FINAL_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  git clone https://github.com/youngjinphys/Claire.git Claire-stage22-final &&
  cd Claire-stage22-final &&
  git checkout --detach "$FINAL_COMMIT" &&
  test "$(git rev-parse HEAD)" = "$FINAL_COMMIT" &&
  git status --short
else
  echo '최종 커밋 40자 전체를 먼저 확인하세요.'
fi
```

clone/checkout/test가 하나라도 실패하면 다음 단계로 진행하지 않는다. `git rev-parse HEAD`를 다시 출력해 저장소 URL·main에서 선택한 제출 커밋·실제 detached HEAD가 같은지 기록한다. 학생의 실제 기존 폴더 경로는 아직 알 수 없으므로 임의의 절대경로를 지정하지 않는다.

**2. 런타임·필수 파일을 확인한다.**

```bash
git rev-parse HEAD
git --version
node --version
npm --version
test -f on-client/src/server.mjs && test -f on-client/student/extension.mjs && test -f on-client/package.json
cd on-client
npm run check
npm start
```

`on-client/package.json`에는 외부 `dependencies` 및 별도 lockfile이 없어 이 앱에 `npm install`/`npm ci`를 실행하지 않았다. 루트 방어전 앱의 `package-lock.json`을 삭제하거나 학생 앱 설치에 사용하지 않는다. `.env.example`은 자동 로드되지 않는다. 이 재현은 운영 설정 없이 기본 루프백 실행을 사용한다. 셸에 기존 `ON_*` 설정이 있으면 값을 출력하지 말고 설정 영향을 먼저 확인한다. AI 실측 때는 자식 프로세스에서 `ON_*` 설정을 제외했다.

기본 시작 신호는 `케셰브 연결 확인: http://127.0.0.1:5189`다. 이 문구의 '연결 확인'은 실제 SDP 연결 성공을 뜻하지 않는다. Node의 SQLite 실험 경고가 나올 수 있으며 경고만으로 시작 실패라고 단정하지 않는다. 이번 npm에서는 프록시 관련 설정 경고도 관측했으나 명령 종료 코드는 0이었다.

**3. 브라우저를 직접 확인한다.** http://127.0.0.1:5189/ 에서 「보호 현황」·「업무 앱」·「보안 기록」을 확인한다. 원천 연결이 없으면 조회 실패·연결 확인 불가가 나타나야 하며 성공으로 기록하면 안 된다. 브라우저 이름/버전·관찰 시각·보이는 상태를 기록한다. AI 환경에서는 Chromium 실행 파일이 없어 이 단계는 **미확인**이다. HTTP 200만으로 화면 렌더링을 확인했다고 적지 않는다.

**4. 종료하고 같은 커밋으로 재시작한다.** 서버 터미널에서 `Ctrl+C`를 누른 뒤 같은 `on-client` 폴더에서 `npm start`를 실행하고 같은 주소를 확인한다. 이후 다시 `Ctrl+C`로 종료한다. 예제 표시가 필요할 때만 별도로 `npm run demo`를 실행하고, 모든 관찰에 `demo`라고 기록한다. 실제 계정·XDR·AI·집행 결과로 기록하지 않는다. 포트 충돌 시 다른 프로세스를 임의로 종료하지 않는다.

## 실제 실행 기록

2026-10-26 09:28:52 KST 및 09:44:30 KST의 실측에 더해 **14:22:39 KST(05:22:39 UTC)에 현재 Linux 작업 환경(`Node.js v26.7.0`, `npm 11.19.0`, `Google Chrome 155.0.8059.84`)에서 리팩토링된 `on-client/student/extension.mjs`를 재검증했다.** 인증·설정 파일을 복사하지 않았다. 세부 관측은 [STUDENT_REPRO_EVIDENCE.json](STUDENT_REPRO_EVIDENCE.json)에 기록했다.

| 절차 | 실제 관측 | 증거 수준·제한 |
|---|---|---|
| 기준 HEAD/제공 스타터 매니페스트 | 기준 `HEAD` `c677b167…`, 제공 스타터 파일(`src/**`, `public/**`, `tools/**`, `vendor/**`) SHA-256 100% 일치 | 실제 Git 및 SHA-256 대조 |
| `npm run check` | 종료 코드 0 | 학생 모듈 구문 검사 통과 |
| `npm start` (`node src/server.mjs`) | 기본 시작 신호 및 `/`·`/app.js`·`/student/extension.mjs` HTTP 200 | 로컬 HTTP 실행 확인 |
| 신원/앱/기록/기기/세션 GET | 각각 HTTP 503, `ok:false`, `mode:disconnected`, `ENGINE_NOT_CONNECTED` | 미연결을 성공으로 오인하지 않음 |
| 진단 GET | HTTP 200, 엔진 `disconnected`, 버전 `0.1.0` | 운영 정상 판정 아님 |
| 종료→동일 명령 재실행 | 두 번째 시작 및 같은 응답 확인, 각 종료 뒤 HTTP 연결 해제 확인 | 자식 프로세스 직접 SIGINT 종료·재기동 확인 |
| `npm run demo` (`node src/server.mjs --demo`) | 같은 다섯 조회 HTTP 200, `mode:demo` | 예제 API 검증 |
| Headless Chrome DOM 렌더링 | `/usr/bin/google-chrome --headless=new --dump-dom`으로 기본(`disconnected`)·예제(`demo`) 모드에서 3개 탭(`protection`, `apps`, `records`) 및 학생 슬롯(`student-identity`, `student-events`, `student-status` 등) 렌더링 확인, 학생 렌더러 런타임 오류 0건 | Headless DOM 덤프 확인; 사용자 대화형 클릭 및 실제 원천 연결 아님 |
| **직전 제출 SHA `c677b167…` 별도 복제** | **2026-10-26 00:44:30 UTC 실측** | SHA 정확 일치, clean, Node 24.22.1/npm 11.19.1, `npm run check` 통과, 기본 서버 HTTP 200, 미연결 `ENGINE_NOT_CONNECTED`, 종료·재기동 HTTP 200 확인 |
| **현재 리팩토링 및 신규 커밋** | **런타임 지문 `2dd9358da1c80aa43dfe061d0f49a8a894c69da515edc0e5ce8f88098cac65a0` 실측** | 8개 학생 렌더러 계약 단위 검증 + 기본/예제 서버 기동·종료·재시작 + Headless Chrome 전 탭 DOM/시각 스크린샷 확인 |

## 13~21단계별 확인표

아래 확인 시각은 2026-10-26 14:22 KST다. 모의 DOM 단위 검증과 Headless Chrome 초기 렌더링은 확인했으나, 실제 운영 원천(SDP/XDR/유료 AI/OSV) 연결과 학생의 직접 대화형 클릭은 구분한다.

| 단계 | 기능·입력 계약·원문 근거 | 이번 결과 | 미확인 원인 |
|---|---|---|---|
| 13 | `renderIdentity({me,devices,sessions})` | 기본 조회 503 / 예제 조회 200, Headless Chrome DOM 및 민감정보 마스킹·주의 배너 단위 검증 통과 | 실제 운영 SDP 신원 연결 미확인 |
| 14 | `renderDecision({status,mode,data,error,appId})` | 원문·모의 DOM(allow/challenge/deny/error·민감정보 필터) 검증 통과 | 실제 SDP 판정 API 미연결 |
| 15 | `renderEvents({status,mode,data,error})` | 기본/예제 기록 GET, Headless Chrome DOM(`data-student-event-id`), 최신순 정렬·필터·상세 토글 단위 검증 통과 | 실제 XDR 원천 사건 미연결 |
| 16 | `renderStatus({devices,sessions,notifications,diagnostics,mode})` | 기기·세션·진단 GET, 주의 카운트(`주의·확인 필요 항목`) 및 클립보드 진단 복사 민감정보 제외 단위 검증 통과 | 실제 브라우저 대화형 클립보드 복사 미확인 |
| 17 | `renderAiConnection({status,mode,data,error,checkedAt,explanationAccepted})` | 원문·모의 DOM(idle/loading/ok/error 코드별 안내) 검증 통과 | 실제 계정 승인·모델 목록 점검 미실행 |
| 18 | `renderExplanation({event,explanation,checkedAt})` | 원문·모의 DOM(`data-student-explanation-event`, 근거 ID 대조, 미실행·사람 확인 필수 검증) 통과 | 유료 AI 요청 미실행 |
| 19 | `renderAction`의 status/event/actionId/target/receipt/observation 등 | 원문·모의 DOM(`data-student-action-event`, `data-student-action-request`, `effectApplied: true` 검증) 통과 | 실집행 연결 미준비, 실제 조치 미요청 |
| 20 | `renderVulnerabilities({status,mode,data,error})` | 원문·모의 DOM(`data-student-package-name`, `data-student-package-version`, 정확 semver 검사) 통과 | 승인 프로젝트 실제 OSV 네트워크 조회 미실행 |
| 21 | 학생 RUNBOOK/ARCHITECTURE, package/server/설정 견본 | 경로·명령·로컬 HTTP 실행·스타터 매니페스트 무결성 대조 | Windows PowerShell 자격 보관함·공식 판정 미확인 |

제공된 `src/`·`public/app.js`·인증·판정·설정·학생 함수를 이번 단계에서 변경하지 않았다. 학생 모듈은 `createStudentView()`가 반환하는 훅이며 개별 함수를 최상위 export로 바꾸지 않는다. 입력값과 상태명은 그대로 유지한다. 앞 단계 `test/` 파일 26개는 기준 커밋에서 이미 제외되어 있다. 원문은 이전 Git 이력에 남지만 현재 루트 회귀검사는 실행할 수 없다. 이번 단계에서 추가 삭제하거나 복원한 것은 없으며 누락을 해결 완료로 표시하지 않는다.

## 데이터 보존·백업·복원 계획

| 대상 | 보존·백업 방법 | 복원 및 제한 |
|---|---|---|
| 커밋된 코드·학생 문서 | 저장소 URL·정확 SHA를 기록하고 별도 clone. 필요 시 프로젝트 밖 보관소에 Git bundle 백업 | 새 폴더에서 정확 SHA checkout. Git은 미커밋·무시된 파일·외부 DB를 백업하지 않음 |
| 미커밋 학생 작업·개인 기록 | 기존 폴더 유지; 본인 관리 암호화 백업에 별도 보관 | 새 코드 폴더를 덮어쓰지 말고 파일별 비교. 실제 본문·개인정보를 제출 증거에 넣지 않음 |
| 실제 `.env`·호스트 설정 | Git/원문 묶음에서 제외, 승인된 보호 저장소와 운영자 절차 사용 | 새 환경에서 정식 재설정. 이전 인증 파일을 무조건 복사하지 않음 |
| Windows 앱 자격 보관함 | `src/ai/credential-vault.mjs`, `tools/app-credentials.ps1`의 Windows 전용 보호 절차 | Linux 복원 미지원; 파일 복사로 다른 PC에서 해독/재인증된다고 보장하지 않음. 토큰 추출 금지 |
| 조치 SQLite 기록 | `src/actions/store.mjs`는 명시적으로 지정한 기존 DB에 intent/state/audit를 보존. 운영자 승인 시 쓰기를 멈추고 SQLite 일관성 백업 사용 | 빈 DB로 대체하거나 실행 중 DB만 단순 복사하지 않음. 사용 중인 WAL 등 부속 상태 고려. 분리 복원 후 정합성 확인, 원천 결과 재조회 전 조치 재전송 금지. 실제 DB 백업·복원 미실행 |
| 접근·XDR 및 이전 단계 자료 | 원천 시스템/기존 DB 담당자의 별도 백업 범위 확인 | clone과 앱 재시작이 원천 데이터 복원을 뜻하지 않음. 실제 백업 위치·주기·복구 시험 미확인 |
| 진행 중 조회·승인 화면 | 요청 상태는 브라우저 및 `connection/manager.mjs`의 메모리 흐름과 구분 | 재시작 후 진행 복구 보장 없음. unknown/pending을 실패 확정으로 보고 자동 재집행하지 않음 |

복원 시험은 기존 데이터를 건드리지 않는 분리 환경에서 수행하고, 파일 체크섬·코드 SHA·복원 시각·관측 결과만 비밀 없이 기록한다. 이번에 실제로 보존을 확인한 대상은 AI 작업 복제본의 Git 트리와 이력이다. 학생 PC의 기존 폴더 보존 및 외부 데이터 백업은 학생 확인 전까지 미확인이다.

## 학생 직접 확인 기록과 제출

| 학생이 직접 남길 항목 | 현재 상태 |
|---|---|
| 기존 작업 폴더·기록 보존 확인 / 시각 | 미확인 |
| 새 폴더의 최종 SHA·버전·환경·실행 명령·시각 | 미확인 |
| 실제 브라우저 상태·종료·재실행 관찰 | 미확인 |
| demo / 실제 연결 / 미실행 구분 | AI 관측은 위 표, 학생 진술은 아직 없음 |
| 미해결 항목·데이터 복원 시험 | 운영 연결·Windows·브라우저·OSV·백업 복원 미확인 |

한 번에 하나씩 확인한다. **첫 확인:** 기존 작업 폴더에서 `git status --short`를 조회하고 기존 파일과 기록이 남아 있는지만 확인한다. 결과에 비밀값·개인 메모 원문을 첨부하지 않는다. 다음 확인은 이 결과를 받은 뒤 새 폴더 재현으로 진행한다.

21·22단계는 과제 화면에 저장소와 최종 40자리 SHA를 직접 입력한다. 「포털 제출 준비」의 13~20단계 지원을 확장했다고 가정하지 않는다. 비공개 원문 CLI의 플래그·실제 다운로드 경로는 제공되지 않았으므로 명령을 만들지 않는다. 원문 준비 도구와 JSON은 프로젝트 밖에 두고 공식 안내를 따른다. 이번 작업은 단계 제출·원문 업로드·유료 AI 요청·보안 조치를 실행하지 않았다.
