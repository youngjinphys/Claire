# BYTE BACK 방어전 · 8단계 저장점

현재 제출 단계는 **8단계 자료 구역 정책**입니다. 기존 9·10단계 작업은 보존했습니다. 1~6단계의 자료실·기기 등록 판정·보너스 XDR을 유지하고, 엔진이 검증한 가상 복합 접속 사건에서 `step_up_required` 추가 확인 규칙을 적용합니다. 아래 5단계 가산점 기록은 변경 전 이력입니다.

## 100점 가산점 대응

1. **`/aleph.json.allowedRoutes`**
   - production manifest가 `aleph.config.json.allowedRoutes`를 그대로 포함합니다.
   - 현재 자료 경로는 `/api/notes`, `/api/notes/:id`, `/api/announcements/:id`입니다.
2. **첫 화면 보안 헤더**
   - `vercel.json`의 `/` 응답에 `X-Content-Type-Options: nosniff`를 명시했습니다.
   - 첫 화면은 `Cache-Control: no-store`도 적용합니다.
3. **화면 코드에서 Supabase 공개 키 제거**
   - 브라우저에서 Supabase SDK와 `sb_publishable_...` 값을 완전히 제거했습니다.
   - 공개 키는 Vercel의 server-only `SUPABASE_PUBLISHABLE_KEY` 환경변수에만 둡니다.
   - 로그인·세션 갱신·로그아웃은 `/api/auth/login`, `/api/auth/session`, `/api/auth/logout` 서버 함수가 Supabase Auth를 호출합니다.

## 인증 구조

브라우저는 비밀번호를 로그인 서버 함수에만 보내고, 서버 함수가 Supabase 공식 `signInWithPassword()` 흐름을 사용합니다. refresh token은 `HttpOnly; SameSite=Strict` 쿠키로 두어 JavaScript가 읽지 못하게 했고, 화면에는 서버가 반환한 access token만 메모리에 유지합니다.

페이지를 새로 열면 `/api/auth/session`이 HttpOnly refresh cookie로 세션을 갱신합니다. 메모 요청은 기존처럼 Bearer access token을 `/api/notes`에 보내며, 기존 `src/verify-login.mjs`와 owner 검사는 변경하지 않았습니다.

## 메모 API

`aleph.config.json.allowedRoutes`:

- `/api/notes`
- `/api/notes/:id`

실제 메서드는 GET/POST/PUT/DELETE를 유지합니다. 브라우저의 메모 CRUD는 Supabase Data API를 직접 호출하지 않습니다.

## 원본 자료 API

```text
https://ytvwpdjfrpwxwtucclpe.supabase.co/rest/v1/learning_notes
```

쿼리·키·JWT가 없는 HTTPS 테이블 경로입니다. PUBLIC·anon·authenticated 직접 table privilege는 현재 모두 false이고 service_role CRUD는 유지되어 있습니다. `supabase/step5_revoke_direct_access.sql`은 사용자가 검토 후 직접 실행하는 재현용 SQL이며 이번 변경에서 DB 권한은 바꾸지 않았습니다.

## 자기점검

5단계 `npm run bundle`은 production을 대상으로 다음을 기록합니다.

- 무로그인 `/api/notes` → 401
- `/aleph.json.originalApiUrl` 일치
- `/aleph.json.allowedRoutes`가 1개 이상
- 첫 화면 응답에 `nosniff` 또는 CSP
- 첫 화면 코드에 Supabase publishable/anon key 없음
- key 없는 원본 Data API 직접 요청 거부

## Vercel 환경변수

서버 함수에 다음 설정이 필요합니다.

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` — 메모 DB 서버 접근 전용
- `SUPABASE_PUBLISHABLE_KEY` — Auth 서버 함수 전용

실제 값은 Git·README·브라우저 응답에 기록하지 않습니다.

## 남은 검증 한계

현재 학습 프로젝트에는 Auth 사용자가 없어 실제 A 계정 로그인 E2E는 실행하지 못했습니다. 비밀번호/JWT를 임의 생성하지 않았습니다. production에서는 무로그인 거부, manifest, 헤더, 공개 키 부재와 서버 런타임을 검증합니다.

## 실행

```bash
npm run test:r5
npm run test:package
npm run build -- --local
npm run bundle
```

`bundle-notes.json`과 `artifacts/submission.json`은 ignored 파일이며 Git에 커밋하지 않습니다.

## 보너스 xdr-01 · Wazuh 무차별 로그인 공격

- 입력: 가상 Wazuh 경보 28건 (xdr/fixtures/brute-force.json). 원본 경보는 읽기 전용이며, read-alerts.mjs는 시각/출발 주소/계정/규칙 수준/비밀값을 제거한 설명 5개 필드만 추출합니다.
- 패턴: xdr/brute-force/patterns.json, MITRE ATT&CK T1110/T1110.001/T1110.003. 반복 로그인 실패·다계정 password spraying을 기반으로 판정하며 번호나 정답을 직접 비교하지 않습니다.
- 판정: xdr/brute-force/decide.mjs 의 decide(alert). 명확한 패턴은 block (0.85 이상), 애매한 인증 실패는 격리 환경용 보수적 alert (0.65), 정상은 record. 심판 판정 경로는 외부 호출 없이 alert (0.65)로 유지합니다. 수치는 운영상의 점수이며 검증된 실제 공격 확률은 아닙니다.
- Jev 격리 제약: 심판의 단일 파일 실행 계약에 맞춰 decide.mjs에서 외부 호출을 제거했습니다. 애매한 경보는 외부 응답을 기다리지 않고 alert로 반환하며, 제3자 API 전송은 일어나지 않습니다. 향후 Jev 추가 검토는 격리 판정 파일 밖에서 별도로 수행해야 합니다.
- 후보 규칙: xdr/brute-force/deny-rules.json 은 sourceAddress + account 조합, 근거 경보 ID, startsAt/expiresAt (원 경보 시각부터 15분)의 오프라인 후보입니다. xdr/alerts.log 는 비밀값 없는 JSONL 경보 알림이며 재실행 시 같은 항목은 중복 추가하지 않습니다.
- 판정기 연결: xdr/brute-force/ztna-gate.mjs 의 checkZTNAExtra()는 원래 판정이 allow 이고, 서버가 검증한 주소/계정/시각이 있는 경우에만 deny 후보를 추가 검사합니다. 기존 deny/step_up 은 그대로 유지합니다. 현재 docs/DECIDER_REQUEST.md 의 18개 요청 필드에는 검증된 출발 주소와 Wazuh 계정 매핑이 없고 src/decider.mjs도 전부 거부 시작점이므로, 본 보너스는 **격리된 오프라인 후보/어댑터**이지 운영 ZTNA 강제 차단이 아닙니다. 운영에 연결하려면 엔진이 검증한 네트워크 주소·사용자 매핑과 등록된 이유 코드를 제공해야 합니다.
- 주의: 학습용 IP는 RFC 5737 문서 예시 대역이고, 경보 시각이 지난 시점의 후보는 자동 만료됩니다. 과거 경보를 재생해 현재 새 차단을 만들지 않습니다. 공유 IP만으로 광범위하게 차단하지 않습니다.

재현 명령: npm run test:xdr && npm run xdr:run -- brute-force && npm run xdr:run -- brute-force

실행 뒤 xdr/brute-force/result.json 의 counts, deny-rules.json 의 후보/만료, xdr/alerts.log 의 단일 JSONL 행을 확인하세요. 정상 이벤트는 record, 추가 확인 대상은 alert, 근거가 충분한 실패만 block 으로 나와야 합니다. 서버 검증 주소/계정이 없거나 규칙이 만료된 경우에는 추가 차단되지 않아야 합니다. 이 실행은 운영 심판 점수나 실제 네트워크 차단 증거가 아닙니다.

### 보너스 xdr-01 · 차단 누락 점검

이전 로컬 점검은 block 10 · alert 9 · record 9였으나, 심판은 명확한 공격 차단 부족이라고 보고했습니다. 비공개 정답이나 심판 입력은 확인하지 못했습니다. Wazuh \`rule.level\`은 실패 횟수가 아니라 심각도이며, 기존 분류기는 \`level >= 10\`과 소수의 한국어 설명 형태를 차단의 필수 조건으로 삼아 누락 가능성이 있었습니다.

지금은 출발지·계정·실패 횟수·시간창·동일 비밀번호 다계정 시도·성공 여부를 함께 판정합니다. 반복 실패의 하위 유형에는 짧은 창에서 같은 계정의 실패 및 같은 주소의 반복 실패를 추가했습니다. Wazuh 원본과 안전한 5필드 투영 모두 수용하며, 별도 실패 횟수 필드도 처리합니다. 낮은 수준의 실패라도 조건이 충분하면 학습용 차단 후보로 처리합니다. 다만 적은 실패 횟수만으로 실제 운영 주소를 자동 차단하는 것은 오탐 위험이 있으므로, 현재 후보는 \`simulation_only\`이며 운영 차단은 연결하지 않습니다.

검증: \`npm run test:xdr && npm run xdr:run -- brute-force && npm run xdr:run -- brute-force\`. XDR 결과는 \`xdr/brute-force/result.json\`, 근거 경보 번호와 만료 시각은 \`deny-rules.json\`에서 확인합니다. 정상 이벤트 차단 0건을 필수 조건으로 검사합니다. 본 결과는 별도로 수행한 자체 테스트이며 공식 심판 점수를 의미하지 않습니다.

### 보너스 xdr-01 · 심판 격리 호환 수정

심판이 커밋 a3ff4d767aa1의 decide 실행을 거부한 원인은 decide.mjs의 전이 의존성이 node:fs/node:net/node:crypto를 사용하고, Jev 외부 호출 가능성이 있던 구조입니다. 이제 패턴 기준을 decide.mjs 상단의 상수로 고정했습니다. 이 파일은 decide(alert)만 export하며 import/파일 입출력/네트워크/환경변수를 전혀 사용하지 않고 즉시 응답합니다.

기존 로컬 차단 후보/만료 시각/alert 로그 적재는 scripts/xdr-run.mjs가 ztna-gate.mjs를 **별도로** 로딩해 수행하므로 격리 판정 경로와 분리됩니다. 운영 ZTNA 판정기 기존 규칙은 수정하지 않았습니다.

재현: npm run test:xdr && npm run xdr:run -- brute-force. test:xdr에는 decide.mjs 파일만 빈 임시 폴더로 복사하고, 네트워크를 비활성화한 하위 Node 프로세스에서 로딩·판정하는 검증을 추가했습니다. 공식 점수는 심판 재실행 후 확인해야 합니다.


## 보너스 xdr-02 · Wazuh 웹 주입 공격 판별 (MITRE ATT&CK T1190)

- **입력:** `xdr/fixtures/web-injection.json` 가상 경보 26건. 원본은 수정하지 않습니다. `xdr/web-injection/read-alerts.mjs`는 시각·출발 IP·계정·규칙 수준·비밀값을 제거한 설명 5개 필드만 추출합니다. 원본 URL 쿼리와 비밀값은 출력하지 않습니다.
- **패턴:** `xdr/web-injection/patterns.json`. MITRE ATT&CK T1190의 공개 웹 앱 악용과 DET0080의 비정상 요청 탐지에 기반해 반복 SQL 주입, 스크립트 삽입, 경로 이탈, 명령 구분자 입력을 구분합니다. 단일 `select` 수업명이나 검색용 따옴표는 차단 근거가 아닙니다. 패턴 문서: https://attack.mitre.org/techniques/T1190/
- **격리 심판:** `xdr/web-injection/decide.mjs` **하나만** 가져가도 실행됩니다. 패턴은 파일 맨 위 상수로 내장했으며, 이 파일은 `decide(alert)`만 export합니다. 다른 파일/npm/Node 내장 모듈을 import하지 않고 파일·네트워크·환경변수도 접근하지 않습니다. 확신도 기준은 block 0.85+, alert 0.5+, record 그 아래입니다.
- **부작용 분리:** `xdr/web-injection/respond.mjs`는 오프라인 차단 후보 `deny-rules.json`과 `xdr/alerts.log` JSONL 알림을 생성합니다. 차단 후보는 명확한 공격만 사용하며 `sourceAddress + path`로 범위를 좁히고 경보 발생 시각으로부터 15분 뒤 만료됩니다. IP 공유 위험을 줄이기 위해 같은 출발지에 정상 관측이 있으면 자동 후보를 제외합니다. 알림에는 경보 ID·시간·행동·패턴 이름만 넣고 원문 URL/IP/계정은 넣지 않습니다. 재실행해도 같은 알림은 중복 추가하지 않습니다.
- **기존 판정기 우선:** `checkZTNAExtra`는 upstream 판정이 `allow`이고, **서버가 검증한** 출발 주소·경로·시각이 있을 때만 후보를 추가 검사합니다. 기존 `src/decider.mjs`와 그 판정·등록 규칙은 그대로 유지됩니다. 현재 `docs/DECIDER_REQUEST.md` v1에는 출발 IP가 없으므로 실제 ZTNA 서버 차단은 연동되지 않았고 후보 파일에는 `simulation_only`를 기록했습니다. 과거 실습 경보를 재실행해도 만료된 IP 차단을 되살리지 않습니다.

재현: `npm run test:xdr && npm run xdr:run -- web-injection && npm run xdr:run -- web-injection`

확인: `xdr/web-injection/result.json` 의 block/alert/record, `xdr/web-injection/deny-rules.json`의 근거 경보 번호·만료시각, `xdr/alerts.log`의 중복 없는 JSONL 행을 확인하세요. `npm run test:xdr`는 심판처럼 `decide.mjs` 파일 **하나만 빈 임시 폴더에 복사**해 오프라인으로 실행하는 테스트를 포함합니다. 자체 시험은 공식 심판 채점이 아닙니다.

### 보너스 xdr-01 · 애매한 시도와 respond 책임 분리

최신 재검토에서 10분간 같은 계정 실패 5건과 불규칙한 출발지 실패 8건을 높은 확신으로 자동 차단한 점이 오탐 위험으로 확인됐습니다. 특정 경보 ID를 예외 처리하지 않고, 이 두 약한 패턴은 자동 차단 기준에서 제거했습니다. 근거가 충분한 집중 실패/다계정 password spraying만 block, 애매한 인증 실패는 **alert (0.65)**, 정상은 record로 판정합니다.

심판 격리 제약에 맞춰 \`decide.mjs\`는 파일/환경변수/네트워크 접근 없이 동기적으로 행동·확신도·근거만 반환합니다. **\`respond.mjs\`는 \`xdr/alerts.log\`의 알림 전담**으로, 애매한 경보의 \`alert\`만 기록합니다. \`ztna-gate.mjs\`는 별도 \`deny-rules.json\`의 만료되는 차단 후보만 생성합니다. 재실행 시 해당 모듈의 잘못된 옛 \`block\` 알림과 중복은 현재 데이터에 맞춰 재구성하되 다른 XDR 모듈의 로그는 보존합니다. 원본 Wazuh 경보와 \`src/decider.mjs\`는 변경하지 않습니다.

재현: \`npm run test:xdr && npm run xdr:run -- brute-force && npm run xdr:run -- brute-force\`. 위 분류 건수는 공개된 학습용 28건에 대한 로컬 검증 결과이고 비공개 심판 정답을 확인한 결과는 아닙니다.

## 6단계: 엔진이 확인한 등록 기기만 보호된 읽기 허용

**확인한 근거:** `docs/DECIDER_REQUEST.md`의 `aleph.decision.v1` 18필드 계약과 `scripts/fixture-7.mjs`의 연습 요청. 검증된 엔진은 학생의 신원·기기·서비스·경로를 확인한 뒤 판정기에 값을 전달합니다.

- 연결 설정: `aleph.config.json.protectedService`에는 `serviceId = notes`, `readRoute = GET /notes/:id` 두 값만 기록했습니다. 이는 **로컬 가상 요청에 있는 값**입니다. 실제 운영 엔진의 서비스 등록부가 동일한 ID를 사용한다는 증거는 확보하지 못했습니다.
- 등록 규칙: `src/decider.mjs`의 `RULE_IDS = ['device_registered']`. 엔진으로부터 전달된 보호된 GET 범위와 등록 확인(`deviceRegistered === true`) 및 형식이 올바른 `deviceId`·`subjectId`가 함께 있어야 `approved / allow`입니다.
- 미등록 및 검증 실패: 엔진이 `deviceRegistered = false`를 전달하거나 확인된 사용자·기기 식별자가 유효하지 않으면 `device_not_registered / deny`를 반환합니다. 다른 경로/동작은 기존 기본 거부 이유 코드 `starter_not_ready`를 사용합니다.
- 사용자-기기 결합 한계: 계약에는 두 식별자의 소유 관계를 독립적으로 조회·검증할 수 있는 필드가 없습니다. 다른 사용자의 기기인지 여부는 **엔진이 등록 관계를 검사해 `deviceRegistered`를 설정해야** 검증할 수 있습니다. 학생의 `decide()`가 단순 두 문자열만으로 소유 관계를 증명했다고 주장하지 않습니다.
- 운영 강제 적용 한계: 현재 저장소에는 운영 SDP 서비스 등록부와 원본 보호 연결 지침이 없습니다. 이 설정은 오프라인 판정 규칙을 연결하기 위한 준비이며 **기존 공개 Vercel URL의 직접 접근을 실제 엔진 통로로 강제한 상태는 아닙니다.** 기존 Supabase Auth·소유자 검사는 계속 유지합니다.

### 반별 접속 도구 설치 및 화면 확인

현재 이 저장소, 공개 starter와 프로젝트 자산에서는 **반별 한 줄 설치 명령을 확인할 수 없었습니다.** 설치 명령을 임의 작성하거나 인증서·CA·서명 키를 생성하지 않았습니다. 공식 반별 안내서의 설치 명령만 그대로 사용하십시오.

1. 해당 반의 공식 엔진 안내서에서 발급자와 설치 명령을 확인하고, 지정된 접속 도구를 설치합니다. 명령에 토큰이 있다면 채팅·Git·스크린샷에 기록하지 않습니다.
2. 공식 접속 도구에서 본인 계정으로 로그인하고 기기가 본인에게 등록·연결됐는지 확인합니다.
3. 제공된 접속 도구를 경유해 기존 `https://skt-aleph-defense.vercel.app/` 주소를 열고, 같은 학습용 로그인 계정의 자료실 화면과 본인 메모 읽기가 그대로 동작하는지 확인합니다.
4. 운영 엔진 측에서 `notes` 서비스와 `GET /notes/:id`가 실제 보호 대상으로 등록됐는지 확인합니다. 엔진 등록이 없다면 화면 열림만으로 기기 기반 접근 제어를 입증할 수 없습니다.
5. 미등록·다른 사용자 기기의 실제 거부 시험은 심판이 담당합니다. 로컬 모의 요청에서는 `deviceRegistered=false`가 `device_not_registered`를 반환하는지만 확인합니다.

### 재현과 제출

`npm run decider:test && node --test test/decider-stage6.test.mjs`

`npm run bundle`은 로컬 가상 기기 판정, production `/aleph.json`의 연결 값, 기존 화면 응답, 비로그인 API의 401을 구분해 기록합니다. 직접 접속 도구의 실기기 시험은 **미검증**으로 남깁니다. 원본 경보, 기존 XDR 규칙, 서버 키, 웹 UI와 과거 배포는 수정·삭제하지 않습니다.

## 7단계 · 평소와 다른 가상 접속은 다시 확인

### 신뢰 경계 및 출처 검증

- 근거 계약: `docs/DECIDER_REQUEST.md`의 `aleph.decision.v1`, `scripts/fixture-7.mjs`의 `normal`/`suspicious` 요청. `src/decider.mjs`의 응답은 기존의 다섯 항목만 유지합니다.
- 위험 신호의 **출처 `judge_fixture`는 오직 심판이 전달한 가상 신호**입니다. 지역·네트워크·시각이 유효하고 최근 사건 배열의 구조가 확인된 경우에만 학습용 조합 판정에 사용합니다. 브라우저 헤더(`x-forwarded-for`, 위치·네트워크 값), `request.geo` 및 계약 외 신원 정보는 보지 않습니다.
- 실제 엔진의 `signals.source = none`, `region/network = unknown`은 명시적으로 **정보 없음**입니다. 위험/안전 위치로 해석하지 않으며 기존 `device_registered` 기본 판정만 적용합니다. 데이터 출처 불명, 위치·시간·네트워크·행동 필드 누락·형식 오류는 정상 값으로 보정하지 않고 기본 거부(`starter_not_ready`)합니다.
- 6단계 `device_registered`는 항상 먼저 적용됩니다. 미등록·식별자 확인 실패는 `device_not_registered`로 거부하며, 7단계 규칙이 기기 등록 조건을 우회하지 못합니다.

### 가상 복합 사건 규칙

- 추가한 규칙: `step_up_required`. **가상 시간대(22~05시) + unfamiliar 네트워크(`unusual`) + 최근 120초 내 `risk_signal`의 횟수 20건 이상**이 모두 충족될 때만 `step_up`을 반환합니다.
- `signals.region`의 `foreign` 값 하나만으로 차단하거나 재인증을 요청하지 않습니다. 주어진 fixture의 `risk_signal`은 이름과 횟수만 제공하므로 **실제 메모 읽기 20회의 별도 검증 증거라고 주장할 수 없습니다.**
- 가상 사건에서 `stepUp.verified === true`이고 `authAgeSeconds`가 0~120초인 **새로 전달된 요청을 다시 판정**하면 `allow`가 나옵니다. 누락·오래된 인증·검증되지 않은 요청은 차단 우회 조건이 될 수 없습니다.
- 계약 한계: 제공 문서의 `stepUp = {verified, authAgeSeconds}`에는 그 재인증이 동일한 `subjectId`의 새 로그인에서 유래함을 검증하는 구체 절차나 증명 필드가 **명시돼 있지 않습니다.** 운영 릴레이가 별도로 증명하지 않는 한 실제 재로그인 유도, 보호 자료 차단, 재로그인 성공 여부는 **미실행·미검증**입니다.

### 실행 및 기대 결과

정상 검사: `npm run decider:test && npm run fixture:7 && node --test test/decider-stage7.test.mjs`

- 정상 등록 기기의 제공 가상 정상 요청은 `allow / approved`입니다.
- 복합 가상 위험 사건은 `step_up / step_up_required`, 가상 `verified: true`·`authAgeSeconds: 60`으로 다시 판정하면 `allow / approved`입니다.
- 미등록·사용자/기기 식별자 실패는 `deny / device_not_registered`, 미확인 위치·행동 출처는 `deny / starter_not_ready`여야 합니다.
- 기존 배포의 [자료실](https://skt-aleph-defense.vercel.app/)에서 이전 로그인/메모 API 응답을 확인합니다. 실제 접속 도구·동일 사용자 새 로그인 연동은 엔진 측 환경에서 따로 시험해야 합니다.

커밋 뒤 `npm run bundle`을 실행하면 로컬 가상 판정, production 7단계 manifest, 기존 화면과 비로그인 401을 자기점검에 포함합니다. 실제 재로그인 계약과 실기기 검증은 확인하지 못했음을 명시하여 제출합니다.

## 9단계 · 도플갱어 탐지와 회수 제안

현재 main의 이전 저장점은 **7단계**입니다. 8단계 구현 기록은 현재 기본 브랜치에서 확인되지 않았으며, 8단계를 수행했다고 주장하지 않습니다.

**공식 로컬 입력 계약:** `docs/DETECT_EVENTS.md`에서 각 사건에는 `at`, `method`, `identity.sub`만 들어 있습니다. `src/detect.mjs`는 이 세 값만 읽고 저장·반환되는 결과에 메모 내용, 토큰, 실명, 클라이언트 헤더를 넣지 않습니다.

- 탐지 조건: 같은 가명 사용자 `identity.sub`의 `GET` 121건 이상이 어떤 **연속된 10분 창**에 모일 때만 `{ action: "propose_revocation", reasonCode: "burst_read", subject: "해당 가명 sub" }`를 반환합니다. 정확히 120건, 사용자별 100건씩, 10분 밖에 흩어진 사건은 `{ action: "observe" }`입니다.
- 원본 판정기의 `src/decider.mjs` 및 기존 `device_registered`/ `step_up_required` 규칙은 그대로 유지합니다. 탐지의 회수 제안은 별도 `detect(events)` 결과이며 기존 access decision 형식에 병합하지 않습니다.
- **제공되지 않은 신호:** 9단계 공식 사건에는 네트워크·기기 ID·사전 판정이 없습니다. 따라서 요청한 "처음 보는 네트워크 **및** 대량 조회" 조건과 "확인된 기기 하나에만 회수" 조건을 충족하는 **운영 탐지·기기별 회수는 구현·검증했다고 주장하지 않습니다.** 가명 사용자 단위의 대량 조회 연습과 회수 *제안*까지만 구현했습니다.
- 실제 신원·기기 매핑과 네트워크 기준선, 로그 출처 검증, 제안 집행 및 경과 시간은 엔진의 추가 신뢰 계약이 있어야 합니다. 회수 API, 실제 차단, 토큰 로깅, 엔진 수정은 없습니다.

### 확인 절차

```bash
npm run detect:test && node --test test/detect-stage9.test.mjs
npm run decider:test && npm run fixture:7
npm run bundle
```

기대 결과: 정상 조회(120건 포함)는 `observe`, 가상 동일 사용자 10분 내 121건은 `propose_revocation / burst_read`; 기존 등록 기기 접근은 변경되지 않습니다. 실제 기기별 차단·회수 경과 시간은 심판의 검증 가능한 이벤트에서만 측정해야 합니다.

## 보너스 xdr-03 저장점 · 알려진 CVE 악용 탐지

입력은 xdr/fixtures/known-cve.json의 가상 Wazuh 경보 24건입니다. 원본은 수정하지 않았습니다. xdr/known-cve/read-alerts.mjs는 시각·출발 주소·계정·규칙 수준·비밀값을 제거한 설명 다섯 필드만 추출합니다.

근거: MITRE ATT&CK T1190 (https://attack.mitre.org/techniques/T1190/) 및 NVD CVE-2021-44228 (https://nvd.nist.gov/vuln/detail/CVE-2021-44228). patterns.json의 패턴을 심판 격리 실행용 decide.mjs 상단 PATTERNS 상수에도 동일하게 기록했습니다.

- 완전한 원격 JNDI 조회 구문이 실제 HTTP 머리글 또는 인자에 있고 T1190 태그·Wazuh 수준으로 뒷받침될 때만 block합니다. 단어 검색·점검 흔적·잘린 구문은 alert, 정상 요청은 record입니다.
- decide.mjs는 동기 decide(alert) 하나만 export하며 import, 파일 I/O, 네트워크를 사용하지 않습니다. 확신도 수치는 휴리스틱 점수이며 공격 성공 확률이 아닙니다.
- respond.mjs는 강한 경보만 deny-rules.json 후보로 변환하고, block·alert를 민감정보 없이 xdr/alerts.log에 JSONL 한 줄씩 기록합니다. 중복 기록하지 않고 기존 모듈 로그를 보존합니다.
- 기존 src/decider.mjs와 RULE_IDS는 변경하지 않습니다. 추가 ZTNA 검사는 상위 판정 allow, 서버 검증 출발지·경로·시각·경보 ID 모두 일치할 때만 거부합니다. 이 검증 정보가 운영 계약에 없어 후보는 simulation_only입니다.
- 공유 IP에서 정상 경보가 있으면 후보를 제외하고, 경로 없는 머리글-only 경보는 주소 전체 차단으로 승격하지 않습니다. 후보는 경보 발생 15분 후 만료됩니다.

재현: npm run test:xdr && npm run xdr:run -- known-cve && npm run xdr:run -- known-cve

현재 fixture 기준 block 8 · alert 8 · record 8, 정상 이벤트 오차단 0건, 경로를 확인할 수 있는 오프라인 후보 6개, known-cve 알림 로그 16줄(재실행 중복 없음)입니다. 이는 비공개 심판이나 운영 차단 결과가 아닙니다.

## 10단계 · 백업에서 자료실을 되살립니다

**현재 상태:** 저장소와 제공 자료에서 침해 전 독립 검증된 정책 백업과 B의 비공개 메모 백업을 찾지 못했습니다. 따라서 실제 운영 정책·학습 DB 복구는 **미실행**입니다. 현재 코드/DB를 임의로 안전한 침해 전 사본이라고 인정하지 않습니다.

### 1. 안전 정책 백업 검증·미리보기·시험 복구

- `src/recovery/policy.mjs` 및 `scripts/recovery-policy.mjs`: 외부에서 독립적으로 고정한 백업 SHA-256, `capturedAt <= verifiedAt < incidentAt`, 정책 스키마와 범위를 확인합니다. 시각과 SHA-256이 일치하더라도 실제 **사전 검증 증거의 신뢰성은 외부 보관자가 보증**해야 합니다.
- 미리보기에서 복원 버전, 기존 버전, **오직 `services.notes` 하위의 변경 경로**, `planSha256`을 확인합니다. 승인 없이 적용하지 않으며, 다른 버전 또는 그사이 바뀐 시험 정책에는 이전 계획을 적용할 수 없습니다.
- CLI의 쓰기 대상은 저장소 밖 `os.tmpdir()/aleph-recovery-lab-*` 내 `test-policy.json`에 고정됐습니다. 다른 서비스 규칙 및 감사 이력 배열은 유지합니다. `src/decider.mjs` 및 실제 운영 정책은 절대 덮어쓰지 않습니다.
- 요구 환경변수: `ALEPH_RECOVERY_TEST_POLICY_PATH`, `ALEPH_RECOVERY_POLICY_BACKUP_PATH`, `ALEPH_RECOVERY_POLICY_SHA256`, `ALEPH_RECOVERY_INCIDENT_AT`. `safe-policy.json`은 같은 격리 디렉터리에 두고, **신뢰된 백업·원문·비밀은 Git에 추가하지 않습니다**.

```bash
npm run recovery:preview
npm run recovery:apply -- <미리보기의 planSha256>
```

미검증 백업, 안전 버전 불일치, 시각 오류, 계획 해시 불일치, 운영 정책 경로 지정은 모두 쓰기 전에 거부합니다. A 정상 읽기 / B→A 자료 요청 거부는 기존 서버 owner 검사로 유지하지만 **실제 A/B 인증을 통한 재실행은 미검증**입니다.

### 2. B 소유 가상 메모 한 건 복원

- 보호 서비스: 기존 `notes`. 읽기 서비스 경로: `GET /notes/:id`.
- Vercel 복구 경로: **`GET /api/restore/notes/:id`** (ID·owner·기존/백업/복원 후 SHA-256·확인 planHash 미리보기), **`POST /api/restore/notes/:id`** (`{"planSha256":"..."}`만 수신해 단일 노트 복구). 본문·토큰은 미리보기/결과에 보내지 않습니다.
- 서버는 기존 `src/verify-login.mjs`로 확인한 Supabase 사용자만 사용합니다. `RESTORE_B_OWNER_ID`와 `RESTORE_OPERATOR_USER_ID`로 고정한 **B 시험 계정 한 명**만 요청할 수 있으며, 요청의 역할·소유자·메모 본문은 신뢰하지 않습니다.
- 실제 백업은 Vercel 서버 전용 `RESTORE_NOTE_SNAPSHOT_BASE64`, `RESTORE_NOTE_BACKUP_SHA256`, `RESTORE_INCIDENT_AT`에서 읽습니다. `RESTORE_ENABLED=1`을 별도로 설정하지 않으면 API는 **503 RESTORE_DISABLED**로 종료됩니다. `SUPABASE_URL`, `SUPABASE_SECRET_KEY`는 기존 서버 전용 설정을 재사용합니다.
- 검증 스냅샷 스키마 `aleph.recovery.note-backup.v1`은 `version`, `id`, `ownerId`, `title`, `body`, `capturedAt`, `verifiedAt`, `contentSha256`를 포함합니다. `contentSha256`은 `JSON.stringify({id,owner_id,title,body})` UTF-8 바이트의 SHA-256입니다. `RESTORE_NOTE_BACKUP_SHA256`은 원문 스냅샷 JSON 바이트 전체의 SHA-256이며 **신뢰된 침해 전 별도 채널에 고정**해야 합니다.
- 본인 B 소유의 지정 UUID 한 건만 insert 또는 기존 내용의 조건부 update가 가능하며, 다른 owner 충돌 및 경쟁 변경은 중단합니다. 복구 후 해당 ID·owner·content hash를 다시 조회합니다. 다른 메모, XDR 로그, 기존 감사 이력은 수정하지 않습니다.
- **실제 B 비공개 백업이 없으므로 이번 단계에서 Vercel 복구 환경변수를 활성화하거나 학습 DB에 쓰지 않았습니다.** 영속적 운영 감사 이벤트 수집 경로도 확인되지 않아 해당 내구성을 주장하지 않습니다.

### 3. 복구 후 1~9단계 정상·금지 요청 순서

1. **1~2단계:** `/data.json` 공개 메모·옛 marker 부재, `/aleph.json` 복구 저장점 일치 검사.
2. **3단계:** 무로그인 자료 요청 401, A 계정 로그인/로그아웃, 유효하지 않은 JWT 거부 검사.
3. **4단계:** A는 본인 GET/POST/PUT/DELETE 허용, B는 A 메모 UUID의 GET/PUT/DELETE 거부, `owner_id` 변경 거부 검사.
4. **5단계:** 브라우저 서버 함수 경유, 공개 키로 원본 자료 직접 호출 거부, 첫 화면 보안 헤더·공개 키 부재 검사.
5. **6단계:** 등록 기기 allow / 미등록 deny (가상 판정); 운영 엔진 실기기 시험은 별도.
6. **7단계:** 가상 정상 allow, 복합 이상 step_up, 가상 인증 갱신 후 재판정; 운영 동일 사용자 재로그인은 별도.
7. **8단계:** 저장소에 8단계 저장점·계약이 없어 확인할 수 있을 때까지 `미실행`.
8. **9단계:** 동일 가명 GET 120건 observe, 121건 propose_revocation; 실제 기기 회수는 운영 엔진 시험.
9. **10단계:** 시험 정책 사본 미리보기·승인 적용, B 한 건 메모 복원 및 ID·owner·본문 해시 재검증, 감사·다른 서비스/노트 불변 확인.

**로컬 실행 명령:**

```bash
npm run test:recovery && npm run detect:test && npm run decider:test
npm run test:r5 && npm run test:xdr && npm run test:package
npm run bundle
```

실제 운영 정책 복원, B 메모 실제 복원, A/B 사용자의 라이브 E2E와 엔진 재확인/회수는 사본·계정·환경이 없어 **미실행**으로 남깁니다. 자체 모의 테스트를 심판 통과로 표시하지 않습니다.

### 10단계 서버 전용 조건부 갱신 SQL (제안·미적용)

`supabase/step10_restore_note_function.sql`은 지정 B 메모의 기존 ID·owner·기존 title/content를 트랜잭션 안에서 비교하고, 일치할 때만 해당 한 건을 갱신하는 `SECURITY INVOKER` 함수입니다. `PUBLIC`, `anon`, `authenticated`의 함수 실행 권한을 회수하고 `service_role`에만 부여하도록 설계했습니다.

실제 DB에는 **아직 적용하지 않았습니다.** 따라서 기존 본문이 변조된 행의 운영 복원에는 검토 후 함수 설치가 필요합니다. POST 서버 함수는 민감한 내용을 데이터 API URL 검색 조건에 넣지 않고 암호화된 서버–DB RPC 요청 본문으로만 전달합니다. 감사 기록·다른 테이블은 수정하지 않습니다.

## 보너스 xdr-04 저장점 · 몰래 심어진 프로그램 탐지

- **입력·최소수집:** xdr/fixtures/persistence.json의 가상 Wazuh 경보 24건을 읽고 read-alerts.mjs가 시각·출발 주소·계정·규칙 수준·비밀값을 제거한 설명 다섯 필드만 반환합니다. 원본 fixture는 수정하지 않았습니다.
- **탐지 기준:** MITRE ATT&CK T1543(시스템 서비스 등록/변경), T1053(예약 작업), T1547.001(시작 폴더). 시작 폴더는 T1543이 아니라 T1547.001에 해당하므로 보조 기법으로 표시합니다. patterns.json의 패턴·근거·확신도를 독립형 decide.mjs 상단에 복제합니다.
- **격리 판정기:** decide.mjs의 동기 decide(alert)만 export하며 import/파일 I/O/네트워크 요청 없이 작동합니다. 서명 없는 새 서비스+임시 실행 파일, 승인 목록 밖 시작 항목 추가, 낯선 작업+임시 실행 파일 등 결합 증거만 block합니다. 단순 서명 미확인, 수업용 작업, 서비스 재시작은 alert, 정상 이벤트는 record입니다.
- **대응 책임:** respond.mjs는 명확한 공격만 만료되는 deny-rules.json 후보로 만들고 block/alert를 원문·IP·계정·비밀값 없이 xdr/alerts.log에 JSONL 한 줄씩 기록합니다. 다른 모듈 로그는 보존하고 중복 알림은 추가하지 않습니다.
- **기존 ZTNA 우선:** 기존 src/decider.mjs와 RULE_IDS를 수정하지 않습니다. checkZTNAExtra()는 상위 allow, 서버 검증 기기 ID·Wazuh agent 바인딩·주소·계정·증거 경보 ID·시각이 모두 일치할 때만 추가 deny를 반환합니다. 현행 ZTNA 요청 계약에는 실제 기기↔Wazuh 연결이 없으므로 오프라인 후보는 simulation_only이며 운영 PC 차단은 연결되지 않았습니다.
- **오차단 경계:** 동일 출발 주소에 정상 이벤트가 있으면 그 주소의 차단 후보는 생성하지 않습니다. 경보 발생 15분 뒤 만료되며 현재 접속 차단에 과거 경보를 재활성화하지 않습니다. 별도 기준 목록은 제공되지 않아 '평소 목록 밖' 여부는 Wazuh 경보 설명에 따른 분류이며 독립된 자산 목록 검증은 아닙니다.

재현 명령:

```bash
npm run test:xdr && npm run xdr:run -- persistence && npm run xdr:run -- persistence
```

학습용 24건 결과: block 8 · alert 8 · record 8, 정상 이벤트 오차단 0건. 오프라인 격리 후보 7개는 모두 만료 상태이며 알림 로그에 persistence 16줄이 중복 없이 기록됩니다. 기존 brute-force 9줄·web-injection 17줄·known-cve 16줄도 보존합니다. 이 결과는 비공개 심판 또는 실서비스 격리 성공을 의미하지 않습니다.

## 보너스 xdr-05 저장점 · 권한 가로채기 탐지

- **입력·최소수집:** xdr/fixtures/privilege.json의 가상 Wazuh 경보 26건을 읽어, read-alerts.mjs에서 시각·출발 주소·계정·규칙 수준·비밀값이 제거된 설명 5개 필드만 추출합니다. 원본 경보는 수정하지 않습니다.
- **MITRE 근거:** T1068(취약점 악용에 의한 권한 상승), T1078(유효 계정 악용). 실제 관리자 그룹 조작에는 T1098.007, 관리자 명령에는 T1548이 더 직접적인 보조 근거입니다. 수업용 Wazuh 태그만으로 T1068 취약점 악용 또는 계정 침해가 입증됐다고 주장하지 않습니다. xdr/privilege/patterns.json의 조건·근거와 심판 격리용 decide.mjs 상단 PATTERNS는 같습니다.
- **명확한 징후만 차단:** 원격 출발지에서 관리자 그룹 편입, 상승 직후 명령 실행, 처음 보는 주소·업무 외 시각의 관리자 명령, 여러 계정 동시 관리자 편입, 권한 철회 후 빠른 복귀 등 결합 증거가 있어야 block입니다. 한 번의 관리자 명령, 일반 그룹 변경, 실패한 권한 명령은 alert이며 정상 로그인·자료실 조회는 record입니다.
- **격리 계약:** decide.mjs는 import/패키지/파일 읽기·쓰기/환경변수/네트워크 없이 동기 decide(alert)만 export합니다. 0.85+ block, 0.5+ alert, 나머지 record를 반환합니다. 민감정보가 있는 설명은 읽기 모듈에서 제거하고, 심판 판정 함수는 원문을 출력하지 않습니다.
- **알림 및 거부 후보:** respond.mjs는 원본과 decision을 재대조하여 0.85 이상 강한 경보만 deny-rules.json 오프라인 후보로 넣습니다. 경보 번호·시작/만료 시각(15분)·출발 주소·계정·Wazuh agent를 범위로 지정합니다. xdr/alerts.log에는 경보 번호·시각·행동·근거 패턴만 JSONL 한 줄씩 추가하며 기존 모듈 로그와 재실행 중복을 보존합니다.
- **ZTNA 원래 정책 우선:** src/decider.mjs는 수정하지 않았습니다. checkZTNAExtra()는 상위 allow, 서버 확인 Wazuh↔ZTNA 주체·세션 매핑, 출발 주소·계정·증거 경보 ID·시각 일치 시에만 요청에 대한 추가 deny를 제안합니다. 현재 계약에는 신뢰 가능한 Wazuh 사용자↔subjectId↔sessionId 매핑과 실세션 회수 API가 없어 mode는 simulation_only입니다. 실제 기존 세션 강제 종료를 수행하지 않으며 sessionId를 만들어 내지 않습니다.
- **오차단 및 만료:** 같은 출발 주소에서 정상 이벤트가 관측되면 그 주소의 자동 후보를 생성하지 않습니다. 후보는 15분 후 만료되며 지난 연습 경보로 오늘의 계정 접속을 차단하지 않습니다. 비밀값·세션 토큰은 로그와 Git에 기록하지 않습니다.

재현 명령:

```bash
npm run test:xdr && npm run xdr:run -- privilege && npm run xdr:run -- privilege
```

학습용 26건 결과는 block 9 · alert 8 · record 9, 정상 오차단 0건입니다. 모의 거부 후보 8개는 모두 만료 상태이며 privilege 알림 로그 17줄은 재실행 시 중복되지 않습니다. 기존 brute-force 9줄·web-injection 17줄·known-cve 16줄·persistence 16줄을 보존하여 전체 alerts.log 75줄입니다. 심판의 비공개 채점이나 실제 운영 세션 철회 증적은 아닙니다.

## 보너스 xdr-06 저장점 · 자료 빼돌리기 탐지

- **대상·최소수집:** `xdr/fixtures/exfiltration.json`의 Wazuh 가상 경보 30건을 보존합니다. `read-alerts.mjs`는 시각·출발 주소·계정·규칙 수준·비밀값을 제거한 설명 다섯 필드만 반환하며, 목적지 IP·전송량·파일 내용·토큰은 출력하지 않습니다.
- **MITRE 근거:** T1041은 기존 C2 채널을 통한 유출, T1048은 대체 프로토콜로의 유출입니다. 높은 수준의 경보나 단일 신규 목적지만으로 해당 프로토콜·C2 악용이 입증됐다고 단정하지 않습니다. `patterns.json`의 조건·근거·확신도를 독립 실행용 `decide.mjs` 상단 PATTERNS에도 그대로 내장했습니다.
- **독립형 판정:** `decide.mjs`는 다른 파일·패키지 import, 파일 입출력, 네트워크 호출 없이 동기 `decide(alert)` 하나만 내보냅니다. 실제 목적지 IP와 충분한 바이트 전송에 신규 목적지·반복 전송·업무 외 시간·압축자료 등의 **복합 증거**가 있을 때만 `block`(0.85 이상), 약한 징후는 `alert`(0.5 이상), 정상은 `record`입니다. 확신도는 휴리스틱 일치 점수이지 실제 공격 성공 확률이 아닙니다.
- **5필드 확인용 투영의 한계:** read-alerts가 반환한 5필드에는 목적지 IP·전송량이 없으므로 같은 사건도 `block`이 아닌 `alert`가 될 수 있습니다. 자동 차단을 위한 증거가 부족하기 때문이며, 격리 심판은 원본 경보를 `decide.mjs` 단독으로 전달합니다.
- **응답·정책 분리:** `respond.mjs`가 강한 판정만 만료되는 `deny-rules.json` 목적지 후보로 만들고, `xdr/alerts.log`에는 시간·경보 ID·행동·패턴 이름만 JSONL로 기록합니다. 후보는 Wazuh agent·출발지·계정·목적지·15분 만료·증거 경보 ID로 제한합니다. 정상 이벤트가 있는 목적지는 자동 후보에서 제외합니다. 다른 XDR 로그를 보존하고 재실행 중복을 방지합니다.
- **운영 미연동:** 기존 `src/decider.mjs`와 RULE_IDS는 수정하지 않았습니다. `checkZTNAExtra()`는 기존 판정 `allow`와 서버 검증 출발지·목적지·계정·경보 ID·시각이 모두 일치할 때만 추가 `deny`를 제안합니다. ALEPH ZTNA v1에는 신뢰된 목적지 IP가 없어 후보는 `simulation_only`이며 **실제 목적지 차단을 수행하지 않습니다**. 과거 훈련 경보의 차단을 현재 시점으로 재활성화하지 않습니다.

재현:

```bash
npm run test:xdr && npm run xdr:run -- exfiltration && npm run xdr:run -- exfiltration
```

현재 공개 학습 fixture 결과: `block 10 · alert 10 · record 10`, 정상 이벤트 오차단 0건. 오프라인 후보 10개는 만료됐고, 기존 XDR 모듈 로그 75줄을 보존한 채 exfiltration 20줄을 중복 없이 기록해 전체 `xdr/alerts.log`는 95줄입니다. 이는 비공개 심판 판정이나 운영망 차단 증거가 아닙니다.

## 8단계 저장점 · 자료 구역별 최소 판정 정책

현재 활성 제출 단계는 **8단계**입니다. 이 문서의 기존 9·10단계 및 XDR 기록은 과거 작업 이력으로 보존했습니다. 8단계의 **확인된 공식 통과 조건**은 ZTNA 판정기의 공지 쓰기 전면 거부 및 메모 컬렉션 접근 거부입니다.

- ZTNA 계약에는 강사 역할과 각 메모의 DB 소유자가 없습니다. 따라서 `POST/PUT/PATCH/DELETE /announcements` 및 `/announcements/:id`는 **누구든지 deny**합니다. 별도 등록된 가명 강사라도 판정기에서 쓰기를 허용하지 않습니다.
- 등록된 주체·기기는 정확한 `GET/PUT /notes/:id`로 **개별 메모 한 건**에만 접근 가능하고, `/notes` 목록·`/notes/export`와 다른 기능 경로는 **deny**합니다. 메모 소유권은 실제 API의 검증된 JWT 사용자 UUID와 DB `owner_id`를 이용해 별도로 다시 검증합니다.
- `GET /announcements/:id`는 등록 기기에 허용합니다. 기존 `device_registered`·`step_up_required` 순서와 5필드 결정 응답은 유지하며, 쿼리로 기능을 선택할 수 없습니다.
- `api/notes.js`의 DB 소유자 검사와 `api/announcements.js`의 서버 강사 권한 확인은 유지합니다. **운영 엔진 역할 계약 없이 강사 권한을 판정기에서 추측하지 않습니다.**
- 8단계 로컬 검증: `npm run test:zone && npm run decider:test && npm run fixture:7 && npm run build -- --local`. 제출 묶음은 동일 SHA가 production에 배포된 이후 `npm run bundle`로 생성합니다.
