> **2026-10-27 정오표:** 아래의 최초 검사 대상 `youngjinphys/choi-bujang-secret-vault`는 당시 기록이며 현재 `main`의 정본 저장소는 `youngjinphys/Claire`입니다. 저장소 설정과 Vercel Git-source 정합성 조정은 [현재 감사](IDENTITY_CONSISTENCY_2026-10-27.md)에 분리해 기록했습니다.

# 12단계 | 탈환 작전실 증적 절차

기준 저장소: `youngjinphys/choi-bujang-secret-vault`, 기본 브랜치 `main`. 최초 검사 HEAD `a873b334f6fe910745859d16a2fd965ece24270b` (`Production URL added`). 최초 검사 당시 README·`aleph.config.json`은 모두 **10단계**였습니다. 11단계 저장점의 소스/통과 기록을 해당 HEAD에서 확인하지 못했습니다. 이 불일치를 숨기지 않습니다.

## 증거의 등급과 신뢰 경계

| 등급 | 가능한 결론 | 불가능한 결론 |
| --- | --- | --- |
| 운영 엔진·공식 심판이 검증한 요청별 결과 | 해당 입력·단계·공격 유형의 검증 근거 | 다른 공격 유형으로 일반화 |
| 실제 HTTP/API 응답과 서버 요청 ID, 확인 시각 | 특정 요청이 해당 배포에서 받은 응답 | 자동으로 단계 통과, 자원 소유권 전체 입증 |
| `npm run judge:check`, `npm run test:operations` 등 로컬 시험 | 공개 계약/합성 입력의 회귀 검증 | 실제 학생 계정·기기·회수·복구 집행 |
| 요청 ID·시간 또는 독립 로그가 없는 결과 | 미검증·보류 | 통과 |

작전실 `GET /api/ops`는 현행 배포에 **읽기 전용 HTTP GET**만 송신합니다. `/aleph.json`·`/data.json`·무로그인 `/api/notes`·무로그인 복구 GET을 시험하고, 기존 학생 로그인 세션이 있으면 Bearer 인증을 통해 `/api/notes`의 **HTTP 응답 헤더만 확인**합니다. 목록 본문은 서버에서 읽지 않습니다. 스냅샷은 매 요청 새로 만들어지며 지속적인 감사 로그 저장소가 아닙니다.

서버 응답에서 `HTTP status`, 허용된 형태의 `error`, `x-vercel-id` 또는 `x-request-id`, `checkedAt`만 투영합니다. ID 헤더가 없으면 `null`/미제공입니다. 스냅샷 응답에 메모 본문·접속 토큰·암호·실명·사용자 ID를 넣지 않습니다. 서버 전체 로그와 1:1 대조하려면 독립적으로 보존한 `x-vercel-id`의 런타임 기록을 운영자가 확인해야 합니다. 요청 ID가 제공되지 않은 경우에는 그 한계를 명시합니다.

**중요:** 2·3·5·10단계로 표시된 표의 실측값은 *현재 배포에서 재확인한 같은 종류의 요청*입니다. 과거 단계의 배포 당시 시험이나 그 단계의 공식 통과로 소급하지 않습니다.

## 1~11단계 검증 원장 작성 절차

1. 검증하려는 *실제 배포 commit SHA*와 `git status --porcelain`을 먼저 기록합니다. `/aleph.json`의 commit·단계를 대조합니다. 서로 다르면 같은 실행의 증거로 병합하지 않습니다.
2. `/api/ops`를 무로그인 상태로 갱신합니다. 금지 GET은 401 Bearer 응답 형태까지 확인합니다. 503 복구 비활성은 "복구 성공"이 아니며 보류입니다.
3. 공식 테스트 계정과 승인 기기로 로그인하여 `/api/ops`를 갱신합니다. 정상 메모 목록 GET이 HTTP 200 및 `X-Resource-Zone: memo`인지 확인합니다. **이 검사는 타인 메모 접근 금지를 입증하지 않습니다.**
4. 6·7·8·9·10·11단계에서 요구하는 엔진 요청과 금지 시나리오는 **제공된 ALEPH SDP 엔진의 공식 테스트 환경**에서 별도로 실행합니다. 9단계 회수 제안과 실제 회수 완료는 다른 증거입니다. 침해 전 운영 사본이 없는 경우 10단계 복구를 실행하지 않습니다.
5. 모든 정상·금지 요청마다 아래 표의 항목을 작성하고, 민감한 응답 본문 대신 HTTP 메타데이터만 남깁니다. 테스트 실행이 안 되거나 11단계 계약을 확인하지 못한 행은 `미실행`으로 둡니다.
6. 독립된 엔진 기록/서버 로그에서 요청 ID·커밋·시간·기대 정책과 실제 결과를 교차 대조한 후에만 실측 통과로 판정합니다. 로컬 시험은 명칭을 반드시 `local_fixture_only`로 분리합니다.

| 필드 | 형식 | 필수 원칙 |
| --- | --- | --- |
| stage, test_id, kind | 1~11 / 고유 ID / 정상 또는 금지 | 공식 계약과 묶음 |
| request | HTTP method + path 또는 엔진 계약 입력 이름 | 사용자/토큰/본문 제외 |
| expected | allow/deny/step_up 또는 예상 HTTP status | 시험 전에 고정 |
| actual | 실제 응답 status·허용 목록의 reasonCode | 미실행이면 null |
| request_id | 서버 또는 엔진 원발행 ID | 로컬 임의 ID 금지 |
| checked_at | UTC ISO-8601 | 실제 관측 시각 |
| deployment_sha | 40자 commit | API 응답의 배포 식별자와 결합 |
| evidence_class | engine_judge / server_http / local_fixture / unrun | 자가 판정과 심판 구분 |
| verdict | verified / failed / inconclusive / unrun | 독립 교차검증 없이 verified로 승격 금지 |

**41종 공격:** 공식 테스트 이름·기대결과·요청 ID·검증 시각·엔진 결론을 전달받아 각각 독립 검증해야 합니다. 이 저장소에는 전체 41종의 권위 있는 목록/판정 기록이 없으므로 현재 **0/41**입니다. 12개 단계의 공식 완료 증거도 연계되지 않아 **0/12**입니다. 최종 클리어 식은 `(official_stage_passed === 12) && (official_attacks_defended === 41)`이며 차별화 과제는 가산점입니다.

## 재현 테스트

```bash
npm ci
npm run test:operations
npm run test:package
npm run judge:check
npm run recovery:retest
npm run build -- --local
# 위 파일을 12단계 저장점으로 커밋하고 원격 HEAD를 확인한 뒤
npm run bundle
```

`npm run bundle`은 본인 점검입니다. 출력을 `artifacts/submission.json`에 생성하며 무조건 통과를 뜻하지 않습니다. `artifacts/`와 `bundle-notes.json`은 무시 파일이며, 비밀값을 텍스트로 붙여넣지 않습니다. 생성물이 실패하면 **맨 처음 오류 하나**부터 원인과 파일을 대조합니다. `npm run bundle` 직후 `git status --porcelain`로 추적 파일 변경이 없는지 확인합니다.

## 복구·보존

예전 메모 CRUD, XDR 및 로컬 복구 코드는 그대로입니다. `src/decider.mjs`와 `src/detect.mjs`의 공식 함수 시그니처·알고리즘도 유지합니다. `README.md`의 10단계 이력은 아래에 보존됩니다. 엔진 자체의 설치·접속·회수·심판 로직은 제공 엔진 소유이며 학생 코드와 혼동하지 않습니다.

검증된 사전 백업과 권한 승인 없이는 `recovery:apply`를 실행하지 않습니다. Supabase DB·운영 정책은 이번 UI 작업에서 변경하지 않았습니다.
