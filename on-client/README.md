# Claire 보안 Agent · 로컬 실행 앱 0.2.11

이 보안 Agent는 회사 직원이 자기 로그인 상태, 업무 앱 접속 결과, 최근 접속 기록과 보안 경보를 보는 보안 앱입니다. 13단계부터 22단계까지 이 프로젝트 하나로 화면을 채워 가며 완성합니다. 처음이라면 docs/GETTING_STARTED_STUDENT.md부터 읽습니다. 무엇을 왜 만드는지와 단계별 순서가 그 문서에 있습니다.

이 시작 틀을 받은 것만으로 단계를 통과하지 않습니다. 단계마다 docs/STUDENT_PROMPTS.md의 안내를 수업용 AI에 붙여 넣어 student/extension.mjs를 고치고, 화면에서 확인하고, 커밋한 뒤 ALEPH에 제출합니다. 제출하면 서버가 그 커밋의 코드를 받아 AI가 단계 과제 기준으로 읽고 판정합니다. 코드를 실행해서 판정하지 않습니다.

## 켜기

검수 환경은 Node.js 24.19.0이며 외부 npm 의존성이 없습니다. 이 폴더의 PowerShell에서 아래를 실행하고 PC 브라우저로 http://127.0.0.1:5189 를 엽니다. 자세한 켜기·끄기·다시 켜기는 docs/STUDENT_LAUNCH_GUIDE.md에 있습니다.

    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-alekov.ps1

npm start도 같은 서버를 켭니다. 기본 실행은 실제 회사 시스템(기존 엔진)에 연결되지 않은 상태입니다. npm run demo는 예제 자료로 화면을 보여 줄 뿐이며 실제 연결이나 성취가 아닙니다. npm run check는 `student/extension.mjs`와 `src/server.mjs`의 구문을 확인하고, `npm test`는 로컬 HTTP·신원/출처 제한·AI 오류 처리를 검증합니다. 기존 `alekov` 파일·패키지 식별자는 외부 연동 계약을 유지하기 위해 그대로 사용합니다.

## 지킬 것

- 기존 1~3차 프로젝트와 학생 파일은 지우거나 덮어쓰지 않습니다. 새 폴더에서 시작하거나, 이미 하던 프로젝트를 이어 씁니다.
- AI 열쇠·비밀번호·토큰을 코드, 커밋, 캡처, 도움정보에 넣지 않습니다. 주소나 열쇠를 직접 입력하는 칸도 만들지 않습니다.
- .env.example에는 비밀 없는 설정만 있습니다.

## 더 읽을 곳

- 단계별 안내와 AI에 붙여 넣을 문장: docs/STUDENT_PROMPTS.md
- 단계별 확인 항목: docs/CURRICULUM.json, docs/IMPLEMENTATION_CONTRACT.md
- 오류 코드별 해결: docs/CONNECTION_TROUBLESHOOT.md
- 시작 틀 업데이트(내 파일 보존): docs/STARTER_UPDATE.md
- 실제 회사 시스템(SDP)·앱 안 AI 연결은 담당자가 따로 안내할 때만 씁니다: docs/SDP_HOST_CONNECTION.md, docs/AI_SETUP_GUIDE.md. 이 연결은 앱을 처음 켜고 13~16단계 화면을 만들거나 공식 AI 코드 판정을 받기 위한 전제 조건은 아닙니다. 다만 17단계 이후의 실제 연결과 새 환경 재현은 해당 단계의 기준에 따라 따로 확인합니다.


## 통합 로컬 관제 대시보드 (Claire 추가 구현)

기존 13~22단계의 화면(`http://127.0.0.1:5189/`)과 학생 코드(`student/extension.mjs`)를 보존하면서 **동일 서버의 통합 읽기 전용 화면**을 제공합니다. 이는 새 서비스나 별도의 백엔드가 아닙니다.

- 통합 화면: `http://127.0.0.1:5189/dashboard.html`. 상단 4개 카드(네트워크·방화벽·Windows 기록·SDP)는 기존 `student/extension.mjs`의 `hostPanel()`을 **재사용**합니다. CPU·메모리·디스크 3개 실측 카드와 추이, 근거 기록, 기존 XDR·접속 기록은 아래에 둡니다.
- **네트워크·방화벽·Windows 기록은 자동 조회하지 않습니다.** 앱 폴더에서 `node student/collect-host.mjs`를 일반 권한으로 실행하면 임시 디렉터리에 `observation.json`이 생성됩니다. 통합 화면의 `다시 조회 · 보고서 선택`으로 그 파일을 명시적으로 지정합니다. 이 파일은 원본 미인증이며 CPU API와 같은 물리 PC/실행 환경이라는 보장이 없습니다. 읽기 실패 시 확인 불가와 원인을 표시합니다.
- Windows System·Application의 지난 24시간 경고·오류 수치는 **공격·침해 탐지 건수가 아닙니다.** macOS·Linux는 Windows 전용으로 표시하고 0건으로 표시하지 않습니다. 방화벽 설정은 읽기만 하며 관리자 권한이나 변경 명령을 사용하지 않습니다.
- 기존 수업용 화면 `/`는 계속 유지됩니다. 통합 화면에서 링크로 이동할 수 있으며 원래 제공 UI·학생 제출 코드는 제거하지 않습니다.
- 동일한 `on-client` 폴더에서 `npm start` 또는 기존 Windows `tools/start-alekov.ps1`로 실행합니다. 별도 npm 설치, 관리자 권한, 실행파일 패키징, Vercel 배포가 필요하지 않습니다.
- **PC 실측:** `/api/local-pc`에서 OS CPU 두 시점의 누적시간 차(400ms), OS 총 메모리와 free 메모리 차, 프로젝트 파일시스템의 일반 사용자 디스크 여유 공간을 측정합니다. 사용률은 %이고 남은 디스크는 GiB입니다. 값마다 OS 원천과 관측 시각을 표시합니다. 메모리 수치는 os.freemem 기준 추정치로, OS에 따라 free와 reclaimable 캐시 해석이 달라집니다.
- **기존 제공 정보:** `/api/me` 기기 보안 상태와 `/api/events` 본인 최근 최대 40건은 제공된 API를 재사용하며 중복 구현하지 않습니다. 기본 미연결은 실제 데이터를 제공하지 않습니다.
- **추이:** 사용자가 관측 시작을 누른 뒤 5초마다 수집한 CPU%·메모리%만 브라우저 메모리에 보관합니다(최대 10분/120개). 창을 닫으면 사라집니다. 실패를 0으로 채우지 않고 관측을 중단합니다. 중지·실패·관측 간격이 긴 구간은 차트상 단절하며, 예전 실측을 현재값처럼 표시하지 않습니다. CPU·메모리 변화는 보안 침해 진단이 아닙니다.
- `npm run demo`는 **기존 SDP 예제 정보만** 가상 값으로 제공합니다. 이때에도 `/api/local-pc`의 CPU/메모리/디스크는 실제 실행한 **그 PC**의 OS 관측입니다. 서로 결합하거나 전체 보안 정상으로 해석하지 않습니다.
- 작업물 변경 및 공식 제출 상태는 `docs/STUDENT_RELEASE_RECORD.md`를 참고합니다. 이 화면이 추가되었다고 22단계 공식 수용 또는 v1.0 릴리스를 주장하지 않습니다.

대시보드 점검 (앱 폴더 PowerShell):

```powershell
node --version
npm run check
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-alekov.ps1
# 다른 창에서 실측 응답 및 단위·시각 확인 (키·토큰 없음)
Invoke-RestMethod http://127.0.0.1:5189/api/local-pc | ConvertTo-Json -Depth 8
```

먼저 기존 `/` 화면의 세 메뉴가 그대로인지 확인하고, `/dashboard.html`에서 파일 선택 → 네 상단 카드 → 자원 측정 시작·중지 → 추이·OS 상세·XDR 기록 → SDP 미연결/DEMO 분리를 점검합니다. 종료는 실행한 PowerShell에서 `Ctrl+C`입니다.


### 검증 범위와 안전 제한

- 신뢰성이 검증된 시각·단위·원천의 관측값만 기록합니다. 구간이 끊기거나 오래된 표본이 있으면 추이 기준선을 다시 시작합니다. 마지막 측정값은 30초 뒤 확인 불가로 전환합니다.
- 반복 요청은 서버에서 진행 중인 측정을 하나로 묶고 최대 1초간 기존 관측을 재사용할 수 있습니다. 동일한 값에는 새 측정 시각을 부여하지 않습니다. 별도 외부 텔레메트리 전송은 없습니다.
- `npm test`는 합성 데이터와 로컬 API의 계약을, GitHub Actions는 Linux Chromium 화면 조작과 Windows PowerShell 실행을 검증합니다. CI에서 측정한 값은 CI 머신의 실측이며 사용자의 PC 측정이 아닙니다.
- 이 UI는 설치 프로그램이 아니며 사용자의 기존 ALEPH 제출 상태나 점수를 변경하지 않습니다. 운영자 키·인증서·토큰을 Git이나 화면에 넣지 않습니다.

### 현장 데이터 정합성 점검

기존 제공 `/api/me`와 `/api/events`를 재사용하지만 새 화면에도 원본과 동일한 필수 상태·근거·규칙·지원 조치 필드의 유효성 검사를 적용합니다. 잘못된 세션 상태 또는 필드 누락으로 받은 사건을 진짜 기록처럼 표시하지 않습니다. 기록의 coverage 시각은 HTTP 요청 시작·종료 시각과 함께 대조합니다. 차트 선은 연속 측정 구간에서만 이어 그립니다. Windows CI는 각 센서가 실제 숫자와 시각을 반환해야 통과하도록 설정했습니다. 실측 실패가 발생할 수 있는 사용자 PC에서는 기존과 같이 확인 불가 및 원인을 보여 줍니다.
