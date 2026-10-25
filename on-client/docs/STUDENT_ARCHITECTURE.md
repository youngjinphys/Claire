# Claire — 텍스트 시스템 구성도와 신뢰 경계 (21단계)

이 구성도는 **코드에 존재하는 경로**를 설명한다. 외부 SDP·AI·원천 조치·OSV가 실제 계정으로 성공했다고 뜻하지 않는다. 실행·오류 안내는 [STUDENT_RUNBOOK.md](STUDENT_RUNBOOK.md) 참조.

## 1. ASCII 구성도

~~~text
┌───────────────────────────────────────────────────────────────────────┐
│ 브라우저 — http://127.0.0.1:5189/                                     │
│ on-client/public/index.html + on-client/public/app.js                │
│ 학생 표시: on-client/student/extension.mjs (render* 함수)             │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ 동일 PC / 동일 출처 HTTP GET·POST
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 로컬 Node 서버 — on-client/src/server.mjs                             │
│ 엔진 분기: on-client/src/engine.mjs                                    │
│ AI 검증: on-client/src/ai/ ; 패키지: on-client/src/vulnerabilities/   │
└────────────────────────┬─────────────────────────────┬────────────────┘
                         │                             │
             운영자 SDP 설정 시             운영자 앱 자격 승인 시
                         │                             │
                         ▼                             ▼
┌──────────────────────────────────┐ ┌──────────────────────────────────┐
│ SDP·접근 제어·XDR 원천 시스템    │ │ CLCO 수업용 AI 게이트             │
│ on-client/src/engine/            │ │ on-client/src/ai/                 │
│   sdp-host.mjs                   │ │   vault-service.mjs              │
│ 현재 본인 판정·저장된 XDR·조치  │ │   service.mjs + app-authorization │
│ (기본 실행은 미연결)             │ │ 승인된 모델만 사용, 기본 미연결  │
└──────────────────────────────────┘ └──────────────────────────────────┘

별도 조건부 조회: 로컬 서버 --승인 공개 npm 패키지의 정확 버전-->
  OSV https://api.osv.dev/v1/querybatch
  on-client/src/vulnerabilities/project-scan.mjs + osv.mjs
~~~

**문장으로 다시 설명:** 브라우저의 제공 `public/app.js`가 로컬 `src/server.mjs`에 요청하고, 서버 응답을 `student/extension.mjs`가 화면으로 보여 준다. SDP 엔진과 CLCO AI 게이트는 로컬 서버가 현재 계정·권한을 확인할 수 있을 때만 **별도로 연결**된다. 브라우저는 기존 접근 제어 정책을 변경하거나 CLCO 원본 키를 직접 보유하지 않는다. OSV는 공개 패키지 확인만 담당한다.

## 2. Mermaid(그림이 보이지 않아도 위 ASCII와 아래 표가 정본)

~~~mermaid
flowchart LR
  B["브라우저<br/>on-client/public/app.js"]
  V["학생 표시<br/>on-client/student/extension.mjs"]
  S["로컬 서버<br/>on-client/src/server.mjs<br/>127.0.0.1:5189"]
  D["접근 제어·XDR 원천<br/>on-client/src/engine/sdp-host.mjs"]
  G["CLCO 게이트<br/>on-client/src/ai/vault-service.mjs"]
  O["OSV 공개 조회<br/>on-client/src/vulnerabilities/osv.mjs"]
  B -->|"같은 출처 HTTP"| S
  B -->|"DOM 생성/스냅샷"| V
  S -.->|"운영자 SDP 설정 있을 때"| D
  S -.->|"운영자 앱 승인 있을 때"| G
  S -.->|"승인 공개 npm 패키지"| O
~~~

점선은 준비된 경우에 한해 사용되는 **조건부 연결**이다. 브라우저와 로컬 서버 기동만으로 점선 경로가 준비됐다고 판단하지 않는다.

## 3. 제공 코드와 학생 영역

| 영역 | 소스 파일(저장소 루트 기준) | 책임 |
|---|---|---|
| 브라우저 | `on-client/public/index.html`·`on-client/public/app.js` | 3개 탭·제공 버튼·API 호출·학생 렌더러 호출 |
| 학생 화면 | `on-client/student/extension.mjs` | `createStudentView` / `renderIdentity`, `renderDecision`, `renderEvents`, `renderStatus`, `renderAiConnection`, `renderExplanation`, `renderAction`, `renderVulnerabilities` |
| 앱 서버 | `on-client/src/server.mjs` | 루프백 포트, 입력·응답 검증, HTTP 경로 |
| 엔진·SDP | `on-client/src/engine.mjs`·`on-client/student/engine-adapter.mjs`·`on-client/src/engine/sdp-host.mjs` | 승인 원천의 본인 접근 판정, 접속·XDR 이력 |
| AI 앱 | `on-client/public/ai-connect.mjs`·`on-client/src/ai/service.mjs`·`on-client/src/ai/vault-service.mjs`·`on-client/src/ai/app-authorization.mjs` | 승인 UI, 서버 전용 앱 자격·모델·설명 |
| OSV | `on-client/public/vulnerabilities-view.mjs`·`on-client/src/vulnerabilities/project-scan.mjs`·`on-client/src/vulnerabilities/osv.mjs` | 검증된 lock/설치 메타데이터, 승인 공개 패키지만 외부 조회 |
| 시작·설정 | `on-client/package.json`·`on-client/tools/start-alekov.ps1` | 서버 실행, Node 버전/포트 검사. 운영 설정 파일은 저장소 바깥 |

## 4. 실제 로컬 HTTP 경로와 사실 판정

| 목적 | 브라우저 → 로컬 서버 | 의미 |
|---|---|---|
| 본인 신원·기기·세션 | `GET /api/me`, `GET /api/devices`, `GET /api/sessions` | 현재 본인 범위. 기기 최대 100개·현재 세션 1개 |
| 업무 앱 요청 | `GET /api/apps`, `POST /api/access` | `allow`는 정책 허용이지 업무 앱 접속 성공 확약 아님 |
| 접속/XDR 기록 | `GET /api/events` | 현재 등록 정보에 대응하는 본인 최근 40건·저장 경보 |
| 계정과 앱 AI 승인 | `POST /api/native-login/...`, `POST /api/ai/connect/{start,finish,status,cancel}` | 운영자 설정과 본인 승인 필요, 번호는 권한 자체가 아님 |
| 모델 목록 점검 | `POST /api/ai/check` | `test/verified` 구분, **사건 설명 실행 아님** |
| 근거 있는 사건 설명 | `POST /api/ai/explain` | 사건 ID·증적 결속 확인 후 서버의 `explainIncident`로 요청 |
| 조치 | `POST /api/actions/{prepare,execute,result}` | 사람 확인·원천 ACK·실제 효과 분리, 운영 연결은 미완료 |
| 승인된 OSV 조회 | `GET /api/vulnerabilities` | lockfile+설치 메타데이터, 공개 허용 목록 기반 |
| 도움정보 | `GET /api/diagnostics` | 비밀 없는 진단 상태만 전달 |

**보안 상태 해석:** `pending`은 ACK이지 효과 확인이 아니고, `succeeded`도 `observation.effectApplied === true`인 확인 결과일 때만 효과를 표시한다. `unknown`·연결 실패는 정상이나 효과 없음이 아니다. `none_found`는 해당 조회 범위에서 알려진 취약점이 없다는 뜻이며 전체 안전 보장이 아니다.

## 5. 분리된 개발·평가 경로

- **Workbench**: PC의 코드 작업과 수업용 AI 지원. 앱 런타임의 상시 중계 서버가 아니다.
- **ALEPH 포털**: 저장소 주소·Git 40자리 SHA 접수와 단계 판정·진도. 학생 앱 서버가 아니다.
- **CLCO 앱 AI**: 학생 앱별 승인 모델·이용 권한·사건 설명의 게이트. 개발 지원 AI 또는 공식 판정 AI와 다르다.

**검증 기록:** 파일·메서드·값은 GitHub 소스에서 대조함. 실제 Windows 실행·SDP 실계정·AI 게이트 접속·OSV 원격 응답·원천 조치 효과·공식 21단계 제출은 **미실행·미확인(UNV)**.

## 6. Linux 실행과 비밀 설정의 경계

- **Linux 기본 실행 경로:** `on-client/package.json`의 `npm start`가 `node src/server.mjs`를 호출한다. 서버는 `127.0.0.1:5189`에만 바인딩한다. 이는 코드상 지원 경로이며 실제 Linux 브라우저 실증은 미확인이다.
- **Windows 전용 인증:** `on-client/src/connection/native-context.mjs`와 `on-client/src/ai/credential-vault.mjs`에 Windows 플랫폼 검사가 있다. Linux에서 Native Host 실계정 승인, 자격 저장소·유료 AI 연결 성공으로 오인하지 않는다.
- **설정 견본:** `on-client/.env.example`은 `ON_PORT=5189` 및 `ON_APPROVED_PUBLIC_PACKAGES=[]`의 공개 기본값만 기록한다. 실제 비밀 설정은 포함하지 않고 자동으로 로드되지 않는다. `.gitignore`는 `.env`를 제외하되 `.env.example`만 포함한다.
- 실제 계정·SDP·AI·OSV·원천 집행은 계속 미확인(UNV)이며, 원천이 제공하지 않은 자격을 만들지 않는다.
