> **2026-10-27 식별자 정합성 보완:** 현재 표시명과 PowerShell 실행 성공 메시지는 `Claire`로 통일했습니다. `alekov-client-starter` 및 `start-alekov.ps1`은 레거시 실행 계약으로 유지합니다. 2026-10-26에 실측한 기록의 이전 명칭·SHA는 당시 증거로 보존합니다.

> **2026-10-26 브랜치 업데이트:** 2026-10-25에 임시 제외한 기존 26개 테스트를 Git 이력에서 복원했습니다. 루트의 `npm test`와 `on-client`의 `npm test`는 서로 다른 범위를 검증합니다. 로컬 진단 버전은 앱 `package.json`에서 읽으며, 실행 안내는 `Claire 연결 확인`으로 바뀌었습니다. 아래의 21단계 기록은 당시 상태의 역사적 설명입니다.

# Claire — 학생 실행 설명서 (21단계)

**대상:** `youngjinphys/Claire` 저장소의 `on-client/` 앱. 이 문서는 제공 코드를 덮어쓰지 않은 별도 학생 문서다. 현재 앱 UI 표시명은 **Claire**이며 원본 시작 틀의 이름은 **케셰브(KESHEV)**였다. 실행 파일명·내부 식별자는 호환성을 위해 그대로 사용한다.

**증거 구분:** 아래 경로·명령·출력 문구는 GitHub의 `on-client/package.json`, `on-client/tools/start-alekov.ps1`, `on-client/src/server.mjs`, `on-client/public/index.html` 등 **원문 소스에서 확인**했다. 이 문서를 작성하면서 Windows PowerShell 또는 사용자의 Linux PC에서 앱을 실제 실행하거나, 운영 SDP·AI·OSV·조치를 요청한 사실은 **없다(미확인)**. '예상 출력'은 성공 실측 결과가 아니다.

## 1. 목적과 관측 범위

Claire는 본인 계정·기기·현재 세션, 업무 앱 접근 판정, 본인 접속 기록·저장된 XDR 경보, 근거를 붙인 AI 설명, 보안 조치의 상태, 운영자가 허용한 공개 npm 패키지의 OSV 조회를 보여 주는 **로컬 학생용 보안 앱**이다.

- 탭은 **「보호 현황」, 「업무 앱」, 「보안 기록」**이다.
- 보안 기록은 **현재 등록 정보와 맞는 본인 최근 40건** 범위다. 모든 직원의 로그·실시간 전체 탐지가 아니다. XDR은 이미 저장된 경보만 표시한다.
- 등록 기기는 최대 100개, 세션은 **현재 검증된 연결 한 건**이 범위다.
- 기본 실행은 `disconnected`, `npm run demo`는 `demo` 자료다. 둘 다 실계정·AI 연결이나 공식 통과의 증거가 아니다.
- 현재 실제 사건의 `supportedActions`는 비어 있어 조치 준비 버튼이 안 나오는 것이 정상이다. 실제 SDP 집행과 효과 확인은 **미확인(UNV)**이다.
- OSV에서 `none_found`는 조회 범위의 알려진 항목 없음이지 패키지·시스템의 안전 보증이 아니다.

텍스트 구성도·통신 경계: [STUDENT_ARCHITECTURE.md](STUDENT_ARCHITECTURE.md).

## 2. 필요 프로그램과 실제 확인 수준

| 대상 | 소스에서 확인한 버전·계약 | 사용자 PC 실제 상태 |
|---|---|---|
| Node.js | `on-client/package.json`: `engines.node=24.19.0`; `start-alekov.ps1`은 **22~24 허용**, 권장 **24.19.0** | `node --version` 출력 미확인 |
| npm | `on-client/package.json`: `start`, `demo`, `check`, `test`. 앱 패키지에 외부 npm `dependencies` 선언 없음 | `npm --version` 미확인 |
| Linux 터미널 | `on-client/package.json`의 `npm start`(Node.js 서버), 기본·예제 경로 | Linux 실제 실행 미확인 |
| Windows PowerShell | 공식 실행 도구 `on-client/tools/start-alekov.ps1` | Windows PC가 없어 미실행 |
| Git | 40자리 제출 SHA·기존 작업 보존 | 현재 PC의 `git status` 미확인 |
| 앱 시작 틀 | `on-client/package.json` `version=0.2.11` | 파일 값 확인; 실제 실행 버전 미확인 |

저장소 루트의 별도 `package.json`은 **이전 방어전 앱**에 관한 것이다. Claire 로컬 앱 실행은 반드시 `on-client` 폴더에서 진행한다. `npm ci`를 앱의 필수 설치 명령으로 추가하거나 AI 키·모델·패키지를 임의 설치하지 않는다.

~~~text
Claire/                               <- Git 최상위, 커밋/21단계 제출 위치
├── package.json                      <- 기존 방어전 루트 앱(학생 앱과 별도)
├── on-client/                        <- Claire 앱 / PowerShell 실행 위치
│   ├── package.json                  <- 0.2.11: start, demo, check, test
│   ├── .env.example                  <- 공개 기본값만 있는 설정 견본
│   ├── tools/start-alekov.ps1        <- 제공 실행 도구
│   ├── public/index.html             <- 제공 화면·메뉴
│   ├── public/app.js                 <- 제공 버튼·API 요청·학생 훅 호출
│   ├── public/ai-connect.mjs         <- 제공 앱 승인 인터페이스
│   ├── public/vulnerabilities-view.mjs
│   ├── student/extension.mjs         <- 학생 render* 함수
│   ├── student/engine-adapter.mjs     <- 제공 엔진 어댑터
│   ├── src/server.mjs                <- 로컬 Node HTTP 서버
│   ├── src/engine.mjs                <- 엔진 선택
│   ├── src/engine/sdp-host.mjs       <- 조건부 SDP 연계
│   ├── src/ai/                      <- 조건부 CLCO AI 서비스·자격 검증
│   ├── src/vulnerabilities/         <- lock+설치 버전 비교·OSV
│   └── docs/
│       ├── STUDENT_RUNBOOK.md       <- 이 문서
│       ├── STUDENT_ARCHITECTURE.md  <- 글·Mermaid 구성도
│       └── STUDENT_LAUNCH_GUIDE.md  <- 제공 문서(보존)
└── [기존 방어전·Git 자료는 보존]
~~~

**중요:** 17~20단계 검사 당시 만들었던 **250KB 이하 경량화 커밋**은 `tools/start-alekov.ps1`과 서버 의존 모듈 등 파일 209개가 없어 **전체 앱 실행에 사용할 수 없다**. 아래 절차는 해당 **앱 실행 파일과 의존 모듈이 존재하는 트리**에 적용한다. 2026-10-25의 21단계 정적 판정용 커밋에서는 **이전 방어전의 `test/` 아래 회귀 검사 파일 26개만 임시 제외**했다. 테스트에는 모의 서버 키·토큰·비밀번호 필드가 있어 자동 비밀정보 판정이 오탐할 가능성이 있으며, 실제 원인으로 확인된 것은 아니다. **테스트 원문과 Git 이력은 부모 커밋에 보존**되고 `on-client/`, 제공 서버·UI, 13~20단계 학생 함수는 내용이 유지된다. 당시 임시 판정본에서 `test/`를 요구하는 이전 단계 회귀 검사는 실행하지 말고 전체 테스트 소스를 복원한 뒤 수행해야 한다. 파일이 없다면 임의 구현·덮어쓰기·`git reset --hard`를 하지 않는다.

## 3. Linux 및 Windows 실행 순서

### Linux 터미널 — 현재 사용 환경(코드 기준, 실제 실행 미확인)

Windows PowerShell은 필요 없다. **Git 저장소 최상위 `Claire/`**에서 Bash 등 Linux 터미널을 열고 아래 명령으로 현재 소스와 실제 설치 버전을 확인한다. 이 문서는 명령의 소스 정합성을 점검했지만, 사용자의 Linux PC에서 실행한 결과는 아직 없다.

~~~bash
pwd
git status --short
git rev-parse --show-toplevel
git rev-parse HEAD
node --version
npm --version
test -f on-client/package.json
test -f on-client/public/index.html
test -f on-client/src/server.mjs
test -f on-client/src/ai/service.mjs
test -f on-client/student/extension.mjs
~~~

`test -f`는 파일이 있으면 종료 코드 0이고 출력이 없는 것이 정상이다. 파일이 누락되면 판정용 경량화 커밋일 수 있다. 기존 파일이나 미커밋 작업을 덮어쓰지 말고 전체 프로젝트인지 확인한다. 앱 `package.json`에는 외부 npm 의존성 설치 단계가 없으며, 기준 Node 버전은 **24.19.0**이다. 실제 Linux의 버전은 `node --version` 출력으로만 확인한다.

~~~bash
cd on-client
npm run check
npm start
~~~

`npm run check`는 `student/extension.mjs`와 `src/server.mjs`의 **구문만 검사**한다. `npm start`는 `node src/server.mjs`이며, 기본 포트는 서버 소스의 `ON_PORT` 기본값 **5189**, 바인딩은 `127.0.0.1`이다. 코드상 예상되는 시작 메시지는 아래와 같으나 **현재 실제 실행은 미확인**이다.

~~~text
Claire 연결 확인: http://127.0.0.1:5189
~~~

Linux 브라우저에서 **http://127.0.0.1:5189/**를 열고 「보호 현황」·「업무 앱」·「보안 기록」이 보이는지 확인한다. 기본 실행 `disconnected`는 실제 SDP·AI 연결을 뜻하지 않는다. 예제만 볼 때의 `npm run demo`는 `--demo`를 사용하는 별도 실행이며 실계정·공식 판정 성공의 증거가 아니다.

서버 **종료**는 실행 터미널에서 `Ctrl+C`, **재실행**은 같은 `on-client` 폴더에서 `npm start`를 다시 수행한다. 포트가 충돌하면 다른 프로그램을 임의 종료하지 말고 점유 프로그램을 확인한다. 공개 설정 견본 `on-client/.env.example`의 `ON_PORT`는 **자동 로드되지 않으므로** 파일만 수정해 포트가 바뀌었다고 판단하지 않는다.

**Linux의 기능 경계:** `on-client/src/connection/native-context.mjs` 및 `on-client/src/ai/credential-vault.mjs`는 Windows 전용 플랫폼 검사를 포함한다. 따라서 Linux에서 가능한 **기본/예제 로컬 표시 경로**를 Windows Native Host 계정 승인·보호된 앱 자격 저장소 또는 실제 AI 설명 성공과 동일시하지 않는다. 이 운영 기능은 Linux에서 **미지원 또는 미확인(UNV)**이며 보호 장치를 우회하지 않는다.

---

### 3.1 Windows PowerShell(참고): Git 최상위 `Claire` 폴더에서 확인

파일 탐색기에서 **`Claire` 폴더(`on-client` 바로 위)**를 열고 주소 표시줄에 `powershell`을 입력한다. 새 PowerShell에서 다음을 **조회만** 한다.

~~~powershell
Get-Location
git status --short
git rev-parse --show-toplevel
git rev-parse HEAD
git --version
Test-Path .\on-client\package.json
Test-Path .\on-client\tools\start-alekov.ps1
Test-Path .\on-client\public\index.html
Test-Path .\on-client\src\server.mjs
Test-Path .\on-client\src\ai\service.mjs
Test-Path .\on-client\student\extension.mjs
~~~

전체 소스라면 여섯 `Test-Path`가 `True`여야 한다. `git status --short`에 다른 작업이 있으면 내용을 먼저 확인하고 보존한다. 별도의 **새 빈 부모 폴더**에서 처음 받는 경우만 `git clone https://github.com/youngjinphys/Claire.git`을 사용한다. 기존 프로젝트를 새 복사본으로 덮어쓰지 않는다.

### 3.2 실행 폴더로 이동, PC 버전·문법 확인

~~~powershell
Set-Location .\on-client
Get-Location
node --version
npm --version
npm run check
~~~

`npm run check`는 `node --check student/extension.mjs && node --check src/server.mjs`로 **구문만** 검사한다. 결과가 정상이더라도 로그인·AI·브라우저·원천 처리가 검증됐다는 뜻은 아니다. 실제 PC 버전·명령 종료 코드는 위 명령 실행 뒤 별도로 기록한다.

### 3.3 정식 시작과 브라우저 접속

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-alekov.ps1
~~~

`tools/start-alekov.ps1`은 Node 버전, 앱 폴더, 포트 충돌, 서버의 HTTP 200 응답을 검사한다. 성공했을 때 **소스상 예상되는 두 출력**은 다음과 같다.

~~~text
Claire가 켜졌습니다. 브라우저에서 http://127.0.0.1:5189/ 을 여세요.
서버가 응답한 것만 확인했습니다. AI 연결 상태는 화면에서 따로 확인해 주세요.
~~~

PC 브라우저에서 **http://127.0.0.1:5189/**를 열고 세 탭과 보호 현황이 보이는지 직접 확인한다. 위 출력이 떠도 **SDP·AI 연결·인증·단계 통과를 확인한 것은 아니다**.

5189 포트를 다른 프로그램이 쓰면 그 프로그램을 종료하지 않고, 앱 폴더에서 다음 공식 옵션을 사용한다.

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-alekov.ps1 -Port 5190
~~~

이 경우 브라우저 URL은 **http://127.0.0.1:5190/**이다. 제공 `npm start`는 앱 서버를 시작하는 대체 명령이며 실행 도구의 사전 검사를 대신하지 않는다. `npm run demo`는 `--demo` 예제 실행만 하므로 실계정 연결 검증에 사용하지 않는다.

### 3.4 종료·재시작

실행한 PowerShell에서 **Ctrl+C**를 눌러 종료한다. 종료 여부를 확인하고 같은 `on-client` 폴더에서 3.3 명령을 다시 실행한 뒤 브라우저를 다시 연다. `-Background` 옵션 사용 시 실행 도구가 알려 준 **본인 앱의 Node PID**만 작업 관리자에서 종료한다. **「조치 화면 취소」는 서버에 이미 전달된 조치의 실제 효과를 되돌리지 않는다.**

## 4. 설정과 보안 경계

| 구분 | 확인된 파일·옵션 | 학생이 직접 바꾸지 않는 것 |
|---|---|---|
| 로컬 시작 | `on-client/package.json`, `on-client/tools/start-alekov.ps1` | 제공 실행 스크립트와 서버 소스 |
| SDP | `-SdpHostConfig`; `docs/SDP_HOST_CONNECTION.md` 계약 | 운영자 발급 자격·정책·실제 설정 원문 |
| 계정·AI 앱 승인 | `-NativeHostConfig`; `docs/AI_SETUP_GUIDE.md` 계약 | 비밀 토큰·앱 허용 모델·인증서·자격 저장소 |
| OSV 조회 | 서버의 `ON_PROJECT_DIRECTORY`와 `ON_APPROVED_PUBLIC_PACKAGES` | 조회 대상 프로젝트와 허용 공개 npm 목록 |

개인 설정·인증서·실제 비밀값은 **프로젝트·Git·제출물 밖** 또는 승인된 보호 저장소에 보관하고, 발급·보관 방법은 운영자 안내를 따른다. Workbench 키를 복사하거나 설명서·Git·도움정보에 비밀번호·토큰을 기록하지 않는다. **`on-client/.env.example`은 실계정 값이 전혀 없는 공개 설정 견본**으로 기본 루프백 포트와 비어 있는 공개 패키지 허용 목록만 담는다. 실제 `.env`와 `.env.*`는 Git에서 제외하며, `.env.example`만 예외적으로 추적한다. 이 견본은 `npm start`에서 **자동으로 적용되지 않는다**.

**Linux에서 제출 전 파일명만 확인(값은 읽거나 출력하지 않음):** Git 최상위 폴더에서 아래 명령을 실행한다.

~~~bash
git ls-files -- 'on-client/.env' 'on-client/.env.local'
git ls-files -- 'on-client/.env.example'
~~~

첫 명령은 출력이 **없어야** 한다. 두 번째는 `on-client/.env.example` 경로만 보여야 한다. 실제 비밀파일이 추적되고 있으면 제출을 중단하고 운영자와 안전한 제거·자격 교체를 협의한다. **Git의 현재 작업 트리가 깨끗해도 이전 커밋에 노출된 실제 자격이 있다면 새 커밋만으로 유출이 취소되지 않는다.**


## 5. 구현 함수와 제공 코드 경계

| 단계 | 학생 함수 (`on-client/student/extension.mjs`) | 소스에서 확인한 표시 |
|---|---|---|
| 13 | `renderIdentity` | 본인·등록 기기·현재 세션, 보안·연결 상태 |
| 14 | `renderDecision` | `allow/deny/challenge/unknown`·사유·시각·오류 |
| 15 | `renderEvents` | 본인 접속·저장 XDR 기록, 필터, 사건 상세 |
| 16 | `renderStatus` | 기기·세션·알림·진단·복사·오류/빈 상태 |
| 17 | `renderAiConnection` | `idle/loading/ok/error`, `test/verified`, 모델 수·점검 시각 |
| 18 | `renderExplanation` | 선택 사건 근거 ID·규칙·`unknown`·AI 미실행 제안 |
| 19 | `renderAction` | 조치 준비/사람 확인/ACK/실제 효과/결과 불명 구분 |
| 20 | `renderVulnerabilities` | 설치된 정확 버전과 OSV ID/수정 시각, 일부·미조회 구분 |

**제공 코드:** `on-client/public/app.js`와 `public/index.html`(탭·버튼·요청·학생 훅), `public/ai-connect.mjs`(승인), `src/server.mjs`(HTTP·권한), `src/engine/`(SDP), `src/ai/`(AI 앱 권한·모델), `src/vulnerabilities/`(OSV). 학생 `render*`는 `createElement`·`textContent`로 **받은 값만 표시**하며 직접 새로운 서버 요청, 조치 실행, 확인 티켓 보관을 추가하지 않는다.

## 6. 화면 확인 경로와 현재 증거

| 화면 | 실제 제공 버튼·기능 | 이 문서 작성 시 확인 수준 |
|---|---|---|
| 보호 현황 | `다시 불러오기`·계정/기기/세션·상태 | 소스 경로 대조, 실제 Windows 화면 미확인 |
| 업무 앱 | 업무 앱 `접속 요청` | 화면·판정 분기 코드 확인, 실제 SDP 미확인 |
| 보안 기록 | `<사건ID> 상세`, 필터, `AI 설명 요청` | 학생 소스·기존 모의 상태 검사, 실제 원천 사건 미확인 |
| AI 연결 | `AI 연결 시작` → `승인 페이지 열기` → `승인했으며 연결 확인` → `현재 API 연결 점검` | 연결 코드 확인, 실제 학생 계정·생성 모델 미확인 |
| 조치 | `원천 결과만 재조회`, `조치 화면 취소` | 제공 버튼·학생 상태 코드 확인, 실제 집행 미확인 |
| 패키지 | `설치 패키지 조회` | 정확한 버전·OSV 상태 표시 코드 확인, 실제 설치/OSV 미확인 |

**AI 목록 점검은 실제 사건 설명 성공이 아니다.** 현재 사건의 `supportedActions=[]`라면 준비·집행 버튼이 없는 것이 정상이다. 운영자 승인 없이 원천 집행을 시험하지 않는다.

## 7. 장애별 확인 순서

| 화면/오류 | 의미와 확인할 것 | 다음 한 가지 행동 |
|---|---|---|
| `앱 폴더가 아닙니다`·파일 없음 | `on-client` 위치 또는 임시 경량화본 | `Test-Path`로 실행 파일 확인, 기존 작업 보존 |
| Node 없음/버전 다름 | `node --version`·Node 22~24 확인 | 기준 24.19.0 준비 후 새 PowerShell |
| 포트 충돌 | 5189 사용 중 | 다른 프로그램을 끄지 않고 `-Port 5190` |
| 시작 시간 초과 | 서버 HTTP 200 검증 실패 | 첫 오류와 서버 시작 창 기록 확인 |
| `ENGINE_NOT_CONNECTED`·`disconnected` | 기본 SDP 미연결 | 담당자가 준비한 SDP 호스트 설정 유무 확인 |
| `CONTRACT_MISMATCH` | 응답·조회 범위·형식 불일치 | `다시 불러오기` 직접 실행 후 지속 시 담당자 |
| `표시할 기록이 없습니다` | 본인 범위 정상 0건 | 조회 실패와 혼동하지 않음 |
| `ON_AI_PROVISIONING_PENDING` | 계정·앱 권한 준비 중/확인 불가 | 현재 승인·담당자 준비 상태 확인 |
| `WB_CLCO_AUTH_REQUIRED`·`WB_CLCO_ACCESS_BLOCKED` | 앱 인증·접근 제한 | 같은 계정 연결 확인, 키 입력·복사 금지 |
| `WB_CLCO_RATE_LIMITED`·`WB_CLCO_TIMEOUT` | 제한·시간 초과 | 상태 확인 후 사용자가 직접 재점검 |
| `CANCELLED` | 사용자가 조회 취소 | 취소를 성공으로 보지 않음, 자동 재조회 금지 |
| 조치 `pending`·`unknown` | ACK는 효과가 아님, 효과 불명 | 지원되는 경우 `원천 결과만 재조회`로 직접 확인 |
| `not_configured`·`not_checked` | 프로젝트 설정 미완료·공개 승인 조회 대상 없음 | 운영자 설정 확인, 의존성 변경 금지 |
| OSV `partial`·`unverifiable` | 일부 실패·조회 불가 | 이미 받은 취약점 ID는 남기고 전체 안전을 주장하지 않음 |
| OSV `none_found` | 확인된 조회 범위 내 알려진 항목 없음 | 패키지·앱 전체가 안전하다고 단정 금지 |

상세 오류 계약: [CONNECTION_TROUBLESHOOT.md](CONNECTION_TROUBLESHOOT.md).

## 8. 확인 항목 및 미확인(UNV)

| 확인 대상 | 현재 증거 | 다음 수동 확인 |
|---|---|---|
| 소스 파일·스크립트·함수·버전 | **GitHub 원문 대조** | `git rev-parse HEAD`와 파일 존재 여부 |
| Linux Node/npm 버전·기본 앱 실행 | **미확인** | Linux에서 `node --version`·`npm run check`·`npm start` 시작 신호 |
| Windows PowerShell 실행 | **미확인(사용 가능한 Windows PC 없음)** | Windows 환경이 확보될 때에만 확인 |
| 브라우저 메뉴와 버튼 | **소스 확인·실제 브라우저 미확인** | 3개 탭·상태·버튼 문구 |
| SDP 실계정·XDR 연결 | **미확인(UNV)** | 허가된 계정 연결에서만 실증 |
| 실제 AI 앱 승인·생성 모델 호출 | **미확인(UNV)** | 운영자 권한 준비 후 별도 확인. 유료 호출 반복 금지 |
| 실제 원천 조치 접수·효과 관측 | **미확인(UNV)** | 시험 집행 금지, 원천 증적 확인 |
| package-lock/`node_modules` 일치·실제 OSV | **미확인(UNV)** | 운영자가 승인한 대상에서 정확한 버전 비교 |
| 공식 21단계 검사/제출 | **미실행·미확인** | 제출 후 서버 판정 확인 |

## 9. 21·22단계 원문 제출(학생 직접)

최신 과제 안내에 따라 **워크벤치의 「포털 제출 준비」는 13~20단계만 지원**한다. 21·22단계는 과제 화면에 **저장소 URL과 `git rev-parse HEAD`가 출력하는 40자리 SHA**를 직접 입력한다. 제출 전 `git status --short`로 다른 작업이 섞이지 않았는지 살펴본다.

비공개 저장소라면 포털의 `비공개 저장소 원문 준비 방법` → `원문 전달 도구 받기`를 사용한다. ZIP과 결과 JSON 경로는 모두 프로젝트 밖의 별도 폴더로 정한다. 공식 `student-source-cli.mjs` 원문 전달 명령은 **저장소 최상위**에서 실행하고, `--commit`에 그 단계의 40자리 SHA를 지정한다. **사용자는 Linux 환경이므로 PowerShell 전용 명령을 그대로 실행하지 않는다.** Linux 터미널에서 해당 단계 과제 화면의 공식 도구 안내와 실제 다운로드한 CLI 원문을 확인한 뒤 Node.js 실행 명령 및 파일 경로만 환경에 맞춘다. 도구 자체의 Linux 호환 여부와 전체 플래그·경로는 이 소스에 없으므로 **미확인**이며, CLI 사용법을 추측하거나 실제 원문 업로드를 수행하지 않는다. 공식 원문 준비 명령을 받은 후에만 실행한다.

포털의 `비공개 저장소 원문 묶음`에 JSON을 골라 저장소·커밋·단계를 재확인해 제출한다. 원문 전송 성공은 AI 판정 통과가 아니며, 전송만 실패할 때는 포털의 `원문만 다시 보내기` 안내를 따른다. 22단계 새 환경 재현과 `v1.0` 완료 선언은 21단계 문서 작성과 별개다.

## 10. 22단계 재현·릴리스 기록

별도 폴더 재현 절차, 버전 차이, AI 실행 증거와 학생 직접 확인의 구분, 데이터 보존 계획은 [STUDENT_RELEASE_RECORD.md](STUDENT_RELEASE_RECORD.md)에 기록한다. 이 문서의 기존 미확인 표는 21단계 작성 당시의 기록이며, 22단계 AI 환경 HTTP 관측이 학생 PC·브라우저·운영 연결 검증을 대신하지 않는다.


---

## 추가 구현: 로컬 PC 관제 대시보드 (2026-10-29 계획 적용)

이 섹션은 13~22단계 제공 UI의 일부가 아닌 **추가 구현**을 설명합니다. 제공된 `public/app.js`, `public/index.html`, `student/extension.mjs`, `student/engine-adapter.mjs`는 그대로 보존합니다. 새 `src/local-pc-metrics.mjs`, `public/dashboard.*` 및 테스트를 추가하고, 기존 `src/server.mjs`에는 정적 파일 네 개와 읽기 전용 GET API 하나를 등록하는 최소 변경만 적용합니다. 기존 스타터 매니페스트의 이력 해시를 새 코드에 맞춰 위조하지 않습니다. 향후 스타터 업데이트에서는 변경된 제공 파일 충돌을 명시적으로 검토해야 합니다.

### 데이터 정의 및 제공/학생 구현 구분

| 위치 | 종류 | 단위·출처 | 절대 주장하지 않는 것 |
| --- | --- | --- | --- |
| 기존 `/api/me` | 제공된 SDP 현재 기기 정책 상태 | `compliant` / `noncompliant` / `unknown`, 서버 응답 시각 | CPU 상태, OS 전체 안전 |
| 기존 `/api/events` | 제공된 본인 범위 기록 | 발생 시각, 조회 시각, 최대 40건 | 전체 환경 또는 실시간 탐지 총량 |
| 신규 `/api/local-pc` CPU | 학생 추가 PC 실측 | `os.cpus()` 두 누적 시간 표본, %, 시작·종료 시각, 구간 ms | 단일 프로세스 CPU 사용량 |
| 신규 `/api/local-pc` 메모리 | 학생 추가 PC 실측 | `os.totalmem/free`, %, 사용/전체 GiB, 측정 시각 | 운영체제 사이에서 free/cache 계산 방식이 같다는 주장 |
| 신규 `/api/local-pc` 디스크 | 학생 추가 PC 실측 | `fs.statfs`, 사용자 사용 가능 GiB, 측정 시각 | 모든 디스크의 여유 공간 |
| 신규 `/dashboard.html` | 학생 추가 시각화 | 값마다 측정 시각·단위·출처, 최근 10분 CPU/메모리 변화 %p | 과거 10분 데이터가 자동으로 존재하거나 보안 사고를 예측 |

- OS 측정은 Node.js 표준 API만 사용하며 관리자 권한·Win32 서비스·드라이버 설치가 필요하지 않습니다.
- `status:unavailable`, `value:null` 과 이유 코드는 실제 측정 실패나 미지원 상태를 뜻합니다. `0` 또는 임의 평균으로 교체하지 않습니다.
- 원천 측정 API가 유효하면 `measuredAt`을 표시하고, CPU는 `measuredFrom` 및 `windowMs`도 기록합니다. 보안 상태는 별도의 `meta.checkedAt`만 존재하므로 해당 시각을 OS 측정 시각이라고 부르지 않습니다.
- `npm run demo`의 SDP 자료는 가상 예제이며 카드·기록에 `예제 DEMO`로 표시합니다. 예제 모드에서 별도로 측정한 PC 성능은 그 PC의 실측값이므로 예제 기록과 분리합니다.
- 메모리의 `os.freemem()`는 운영체제별 구현이 달라 회수 가능한 캐시의 취급이 서로 다를 수 있습니다. 이 수치를 운영체제 공통의 메모리 압박 수준이나 정밀한 working-set 지표로 해석하지 않습니다.
- 새 그래프는 사용자가 버튼을 누른 시점부터 현재 세션 메모리에만 기록합니다. 관측 중지, 탭 숨김, 통신 중단, 오래된 표본을 각각 분리합니다. 측정 실패·오래된 관측 시 관측을 중단하며, 사용자 조작 없이 자동 재시도하지 않습니다. 실패/중지/장시간 간격 구간은 통계 기준선을 분리합니다. 카드의 마지막 수치도 시간이 지나면 신선도 만료로 표시합니다. 자동 집행·제어·외부 텔레메트리 전송을 하지 않습니다.

### 브라우저 QA와 제출 이력

`npm test`에는 오래된 센서 표본, malformed coverage, 오프라인 모드 성공 가장, 오류 이후 추이 연결 금지 등의 회귀 검사가 포함됩니다. GitHub Actions는 실제 Chromium 브라우저에서 DEMO 가상 사건·로컬 CI 머신의 실제 하드웨어 측정·관측 시작/중지·모바일 화면을 검사하며 이미지 증거는 CI 아티팩트로만 보관합니다. 이는 수강생 Windows PC 실측이 아닙니다.

### 재현 명령 및 판정

```powershell
# 기존 프로젝트의 Claire 저장소 루트
git status --short
git rev-parse HEAD
cd on-client
node --version   # 수업 기준 24.19.0
npm run check
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-alekov.ps1
```

동일 PC 브라우저에서 ① 기존 `/` 3개 탭 → ② 새 `/dashboard.html`에서 관측 시작 전 '확인 불가' → ③ 관측 시작 시 실측값 및 각 측정 시각·단위 → ④ 두 표본 이상에서 CPU/메모리 비교 추이 → ⑤ 관측 중지 시 마지막 값 표시 → ⑥ SDP 미연결·예제 구분 → ⑦ 종료 후 재시작, 기록 초기화 순서로 확인합니다.

실측 API만 확인하려면 다른 PowerShell 창에서 `Invoke-RestMethod http://127.0.0.1:5189/api/local-pc | ConvertTo-Json -Depth 8`를 실행합니다. `/api/me`와 `/api/events`는 SDP 미연결 상태일 때 503이 정상입니다. OS 측정이 성공했어도 SDP 연결을 통과했다고 기록하지 않습니다. 모든 출력은 **사용자 PC에서 직접 관찰한 시각·Node 버전·현재 커밋**과 함께 남겨야 합니다.

사용자 PC(특히 Windows)에서의 실측 결과, 보안 운영 연결, 실제 원천 조치, 공식 22단계 채점은 이 코드만으로 확인되지 않습니다. 루트 `npm run bundle` 등 포장 명령은 실행하지 않습니다.


### 근본 원인과 재발 방지 기준

기존 초기 대시보드는 최신 `checkedAt`만으로 차트에 낡은 CPU 값을 포함할 수 있었고, 실패 구간을 건너뛰어 변화 폭을 계산했습니다. 이를 수정하여 센서별 시각(응답 시각 기준 15초 이내), 단위·원천·구간·물리적 범위를 검증하고, 이어지는 유효 CPU/메모리 쌍만 비교합니다. 중지·수동 재개·오래된 구간은 서로 연결하지 않습니다. 오래된 값은 30초 후 화면에서 확인 불가로 바뀌며, 신선도 재평가 자체는 OS 재조회가 아닙니다.

또한 제공 엔진이 `disconnected`인데 `ok:true`인 불일치 응답을 정상으로 해석하지 않고, 사건 중복·원천 범위·coverage 불일치는 오류로 처리합니다. CPU 구간은 단조시계로 계산하며 벽시계 역전은 확인 불가로 처리합니다. 디스크는 `bavail`(비관리자 사용 가능 블록)을 사용하고 큰 정수 용량을 성급하게 Number로 변환하지 않습니다.

로컬 `/api/local-pc`의 동시 호출은 진행 중인 측정을 공유하고 1초 이내 같은 시각의 표본을 재사용합니다. 응답이 캐시되더라도 `measuredAt`과 `checkedAt`을 새 값으로 위조하지 않습니다. 다른 프로그램이 임의로 로컬 측정 API를 반복 요청하여 관측 작업을 늘리는 위험을 줄이는 장치입니다.

GitHub Actions는 Linux 브라우저 UI의 시작→표본→중지→모바일 레이아웃 및 synthetic SDP DEMO를 검증하고, Windows Runner에서 Node 24.19.0 PowerShell 실행과 읽기 전용 API 계약을 검증합니다. 실제 사용자 PC에서의 OS 결과와 실제 SDP 운영 연결은 계속 별도 미확인입니다. 검증 브랜치에서 실패한 테스트 기록을 없던 일로 해석하지 않으며 최종 커밋 CI 상태만 완료 근거로 기록합니다.

### 제공 계약과 신규 화면의 검증 일치

신규 대시보드도 기존 `public/app.js`의 identity/events validator와 같은 필수 필드 계약을 검사합니다. 이벤트 요약만 정상이더라도 evidence/rules/state/supportedActions가 빠진 응답은 조회 성공으로 표시하지 않습니다. SDP 원천 coverage는 서버 시각뿐 아니라 이번 클라이언트의 요청 시작·완료 시각과 대조합니다. CPU·메모리 그래프는 측정 실패뿐 아니라 15초 넘는 관측 공백에서도 선을 끊고, 구간별 변화량 설명과 일치하도록 처리합니다. Windows GitHub Actions는 CPU·메모리·디스크 각각의 성공 실측을 요구하며, 실제 수강생 PC 결과는 별도로 확인해야 합니다.

### SDP 기기 보안 상태의 색상 및 세션 결속

기기 조회 성공(`ok`)과 보안 안전(`compliant`)은 동일하지 않습니다. 실제 원천의 `noncompliant`는 위험 강조색으로, 기기가 `compliant`여도 세션이 만료·철회·확인 불가라면 주의 색으로 표시합니다. `unknown`과 오래된 조회는 확인 불가로 표시합니다. DEMO는 원천 상태가 무엇이든 예제 표시만 사용합니다. 이 상태는 SDP 원천 정책의 요약이지 운영체제의 전체 안전도, AI 탐지 결과 또는 현재 접근 허용 확약이 아닙니다.
