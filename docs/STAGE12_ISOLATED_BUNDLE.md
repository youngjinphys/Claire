> **현행 구현 정오표(2026-10-27):** 아래의 예전 Git subprocess 설명은 역사적 구현에 관한 것입니다. 현재 `scripts/bundle.mjs`는 Git subprocess를 사용하지 않고 `scripts/bundle-commit-metadata.mjs`로 체크아웃 메타데이터를 읽습니다. 현재 저장소 `repoUrl`은 대소문자를 보존해 `Claire`로 기록합니다. [현재 감사](IDENTITY_CONSISTENCY_2026-10-27.md) 참조.

# Stage 12 · 제출 생성기의 격리 환경 적합성

## 현재 단일 커밋 제출 기준 (2026-10-16)

- 11단계 기준 SHA 287bedb8e69a2c5bc3b44ea5586ac382987cf8b0의 직접 자식 단일 커밋만 Stage12 main에 유지한다. 아래 과거 기록에 등장하는 f3f3/6039 Git 명령 제약은 현재 코드의 실행 경로를 설명하지 않는다.
- bundle-notes.json은 제공된 AGENTS.md의 최초 계약에 따라 Git 추적·커밋에서 제외한다. 없는 clean clone에서는 추적된 package/bundle-notes.template.json의 공개 가능하고 근거 있는 3줄 explanation을 사용한다. 사용자 개인 초안을 원격 저장소에 올리지 않는다.
- 공식 공개 주소는 https://skt-aleph-defense.vercel.app 이며 12단계 배포 식별자의 publicAppUrl은 해당 URL을 반환한다. 1~11단계의 기존 VERCEL_URL 식별자 계약은 유지한다.
- Stage12 자기 점검은 공개 HTTPS GET/HEAD 요청만 실행한다. 총 20개 항목 중 실행 불가·미관측은 not_run이다. 41종 공식 공격 평가는 별도이며 운영 심판 결과를 추측하거나 화면에 점수로 반영하지 않는다.
- 테스트 중 오프라인 출력이 artifacts/submission.json을 덮어쓸 수 있으므로 커밋·배포·회귀 시험 후 마지막에 npm run bundle을 재실행한다. 자세한 자료 출처와 검증 한계는 docs/STAGE12_CONTRACT_AUDIT.md를 참고한다.


## 확인된 최초 원인

기준 `287bedb8`의 `scripts/bundle.mjs`는 허용된 `node:fs`, `node:path`, `node:url`, `node:child_process`로 Git 및 로컬 JSON을 읽습니다. 그러나 `src/attack-check.mjs`는 12단계에서도 10단계 합성 복구 점검을 동적으로 불러와 `node:fs/promises`, `node:os` 등의 금지 모듈에 도달했습니다. 더구나 제출 격리 실행에서는 로컬 정책 복구 시험, 인증된 POST 요청을 수행해서는 안 됩니다.

## 실제 수정

- `config.step === 12`일 때 기존 `src/attack-check.mjs`의 1~11단계 분기 전에 `src/attack-check-stage12.mjs`만 불러옵니다. 기존 10단계 및 하위 단계 테스트 코드는 그대로 보존합니다.
- 제출 분기에는 금지된 Node 모듈 import가 없고, 허용된 공용 배포 HTTPS origin의 고정 경로에 **GET/HEAD 12건만** 실행합니다. 외부 사용자 URL이나 인증 헤더를 받지 않습니다. HTTP 리다이렉트는 거부합니다.
- 최대 24KiB로 제한한 공개 JSON/안전한 거부 본문만 읽으며, 비공개 API가 예기치 않게 200을 반환하면 응답 본문을 읽지 않습니다.
- 모든 점검은 `{attackId,expected,observed}` 세 필드로 반환합니다. **총 20개** 중 실복구·쓰기·운영 엔진 검증 등 수행할 수 없는 **8개는 정확히 `not_run`**입니다. 네트워크 접근이 제한되면 해당 HTTP 검증도 `not_run`입니다.
- `npm run test:bundle-isolated`는 Node 내장 모듈 allowlist, 안전한 요청 메서드, 응답 초과 크기, 비공개 데이터 비노출, **1,100개** 변형 판정기 입력을 검사합니다. 이 자체는 공식 심판은 아닙니다.

### f3f3e470 재채점 S12_BUNDLE_UNSUPPORTED 재발 수정

첫 번째 제한 테스트는 Node 모듈과 HTTP verb만 검사하고 `node:child_process.execFileSync`에 전달한 **Git 하위 명령**은 검사하지 않았습니다. 따라서 `git config`, `git remote`, `git rev-list`, `git diff`, `git diff-tree`가 계속 실행되었습니다. 읽기 용도로 쓰더라도 보수적인 심판 허용 목록과 일치하지 않을 수 있습니다.

수정된 `scripts/bundle.mjs`에서는 실제 Git subprocess를 **`status`, `rev-parse`, `show` 세 가지 읽기 명령으로 제한**했습니다. `-C` 전역 명령행 인수 대신 `cwd`를 사용합니다. 변경 파일은 `git show -m --first-parent --no-renames --format= --name-only HEAD`에서 가져오므로 병합 커밋도 첫 부모에 대한 차이를 사용합니다. 원격 URL에 대한 Git 설정 변경 명령은 필요하지 않으며, 제출 URL은 Git에 커밋된 `aleph.config.json.repoUrl`을 정규화해 읽습니다.

`npm run test:bundle-isolated`에 **전체 `scripts/bundle.mjs` 실행 시 Git 하위 명령을 가로채 허용 목록을 검증**하는 테스트를 추가했습니다. 지원하지 않는 명령의 호출은 바로 실패하고 네트워크를 차단한 상황에서는 HTTP 관측이 모두 `not_run`인지 확인합니다. 기존 단계별 런타임 구현 및 `src/decider.mjs`은 변경하지 않았으며 `aleph.config.json.step=12`를 유지합니다.

### 직접 교차 확인할 증적과 출처

2026-10-15 공개 운영 배포의 무인증 `GET /api/ops` 자체 관측에서 서버 HTTP 실측은 **3건 verified (공개 배포 식별자 200, 정적 자료 200, 무인증 메모 401), 1건 inconclusive (실복구 미검증 503), 1건 unrun (인증된 사용자 메모 조회)**으로 구별됐습니다. 화면의 표 및 그래프는 이 API의 `records`와 `summary`를 읽습니다. 이 집계는 **41종 공격 시험 결과가 아닙니다**.

`verdict.stagesVerified=0`, `verdict.attackTypesVerified=0`, `officialJudgeEvidence=false`, `complete=false`를 유지합니다. 12단계/41종은 공식 검증의 요구 규모이지 수행 이력을 의미하지 않습니다. `policy.source=student_decider_code`, `detection.source=student_detector_code`, `revocation.source=ALEPH_SDP_engine_not_connected_to_snapshot`으로 코드·심판 엔진의 신뢰 경계를 표시합니다. 공식 심판 증적이 없으므로 모든 41종의 실제 판정 결과는 **미검증**입니다.


### 로컬 재현

```bash
npm ci
npm run test:bundle-isolated
npm run test:decider-contract
npm run bundle
```

`npm run bundle` 전에 변경 파일을 모두 커밋해야 합니다. `artifacts/submission.json`은 Git 추적 대상이 아닙니다.

**이 점검으로 알 수 없는 것:** 운영 반 엔진/심판의 공식 41종 공격 결과, 실제 학생 A/B 메모 복구, 물리 기기 WebAuthn 승인. 이런 결과는 반드시 별도 출처의 증거를 확보하십시오.

### 6039becd 이후: 심판 기준으로 Git 실행을 완전히 제거

기존 test:bundle-isolated는 status, rev-parse, show를 **학생이 직접 만든 허용 목록**으로 판정했다. 이 로컬 목록이 실제 심판 허용 목록과 동일하다는 근거는 없었다. 특히 git status의 작업 트리 인덱스 갱신 가능성과 git show의 복잡한 플래그 해석이 남았다.

이번 제출 실행 경로에서는 **node:child_process를 import하지 않으며 Git CLI·셸·npm 하위 명령을 하나도 실행하지 않는다.** 대신 scripts/bundle-commit-metadata.mjs가 허용된 node:fs·node:path만으로 .git/HEAD를 읽고, detached HEAD·loose ref·packed ref·worktree 포인터를 지원한다. scripts/bundle.mjs는 12단계에 한해 src/attack-check-stage12.mjs를 직접 로드해 다른 단계의 복구/호스트 검사 모듈 import 경로도 통과하지 않는다.

변경 파일 목록은 package/bundle-commit-files.json에 **이번 단일 커밋의 정확한 파일 경로**를 명시한다. 이 파일은 제출의 자기 선언이며 Git이 자동 추출한 내역인 것처럼 표시하지 않는다. **커밋 직전** 독립적인 로컬/CI 환경에서 Git diff와 목록을 비교하고, **커밋 직후** GitHub의 실제 commit diff로 대조한다. 격리된 npm run bundle 자체는 Git 명령으로 작업 트리 청결도나 변경 파일 목록을 재확인하지 못한다는 보안상 절충을 명시한다. 새 커밋을 만들 때는 반드시 이 명세도 갱신해야 한다.

새 회귀 시험은 node:child_process와 child_process의 모든 import를 금지하고, 허용된 Node 모듈 외의 builtin import를 거부한다. 전체 번들 생성 모듈을 그 조건에서 실행해 네트워크 GET/HEAD 12건, 관측 불가 결과 not_run 20개, 규칙 5개, 제출 JSON 생성을 검증한다. node:module은 **검사 프로세스 자체에서만** 사용하고 번들에는 포함하지 않는다.

실제 운영의 GET /api/ops와 웹 화면은 같은 API 응답을 데이터 원천으로 공유한다. 내부의 verified/inconclusive/unrun은 현 배포의 소수 읽기 전용 점검에만 해당한다. **공식 41종 공격의 실행 결과나 통과를 의미하지 않으며**, officialJudgeEvidence=false, attackTypesVerified=0은 유지된다. ALEPH 엔진과 학생 구현/시뮬레이션의 출처는 서로 혼합하지 않는다.

이 격리 테스트는 **허용되지 않은 Git subprocess가 존재하지 않는다**는 사실을 입증하지만, 제공받지 못한 심판 구현의 모든 판정 조건을 복제했다고 주장하지 않는다. 공식 점수는 실제 재제출에서 확인해야 한다.
