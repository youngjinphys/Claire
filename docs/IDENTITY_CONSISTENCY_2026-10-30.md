# Claire 저장소·배포·제출 증적 재감사 — 2026-10-30

## 실제 읽기 전용 확인

감사 시작 시 GitHub main HEAD: `505f32bfd38362610fd04ebc3a156fc348b44b57`.
설정 정본 `aleph.config.json.repoUrl`은 **이미** `https://github.com/youngjinphys/Claire`였으므로 중복 변경하지 않았다.

| 대상 | 관측 |
| --- | --- |
| GitHub 정본 및 Vercel Git source | `youngjinphys/Claire` / main — 일치 |
| Vercel 프로젝트 리소스명 | `choi-bujang-secret-vault` — Git repo와 별개, 보존 |
| 공개 배포 alias | `https://skt-aleph-defense.vercel.app` — 설정과 일치 |
| 공개 alias가 가리키던 READY 배포 | `dpl_GjDajzU1FADPFQ2Gu8cDxZbFrNQ6`, 커밋 `b1918ce52cbbc968dfe5ebfb95a086cc64565d52` |
| 최신 main의 Vercel 배포 | `dpl_893YqYKdv9yJdgB2ZrhQ66Mnf4Au`, 커밋 `505f32bfd38362610fd04ebc3a156fc348b44b57`, **BLOCKED** |
| GitHub 상태 | 해당 SHA의 GitHub Actions는 success, Vercel 상태 검사는 failure |

**결론:** Git repo identity는 일치하나 공개 alias가 최신 main을 서비스하지 않는다. BLOCKED 원인은 공개 API에서 확인되지 않았으며, 차단된 배포의 빌드 이벤트는 비어 있었다. Vercel의 계정 제한·배포 경합·정책 등 원인은 단정하지 않는다.

근거: [Vercel 최신 배포](https://vercel.com/youngjin305-navercoms-projects/choi-bujang-secret-vault/893YqYKdv9yJdgB2ZrhQ66Mnf4Au) · [기존 READY 배포](https://vercel.com/youngjin305-navercoms-projects/choi-bujang-secret-vault/GjDajzU1FADPFQ2Gu8cDxZbFrNQ6) · [Vercel 공식 BLOCKED 설명](https://vercel.com/docs/errors/deployment_blocked).

## 원인과 구조적 보완

1. `api/ops.js`는 이전에 manifest의 schema, step, repoUrl만 보아 verified로 표시했다. `src/deployment-evidence.mjs`에서 repo, public alias, deployment SHA, judge issuer, original API, restore route, allowed routes, protected service, resource zones를 교차검증한다. 서버가 기대 SHA를 모르면 inconclusive, 값이 다르면 failed로 표시한다. 이것은 **현재 배포 자신의 정합성**이지 최신 Git HEAD 실증은 아니다.
2. `package/bundle-commit-files.json`에는 예전 Stage12의 4개 변경 파일이 남아 있었다. 이번 단일 커밋의 실제 파일 목록으로 갱신하며, push CI에서 Git diff와 목록을 정확하게 비교한다. `npm run bundle` 자체에는 Git subprocess를 추가하지 않는다.
3. `scripts/bundle.mjs`는 Stage12에서 슬래시 또는 .git이 붙은 GitHub URL을 보정하지 않고 거부한다. 따라서 제출기의 값이 deployment identity 검사와 조용히 달라지지 않는다. Stage1–11 레거시 계약은 유지한다.
4. CI에 하드코딩되어 있던 Vercel Git repo owner/name을 GitHub 실행 컨텍스트에서 얻도록 수정해, 저장소 이전/포크 시 검증 오탐을 예방한다.
5. `npm run identity:live`는 현재 체크아웃의 HEAD와 공개 alias의 `/aleph.json`을 비밀정보 없는 HTTPS GET 1회로 비교한다. 결과는 verified, stale, mismatch, unverifiable로 분리한다. 접근 불가·리다이렉트·비JSON·과도한 본문·no-store 누락은 미검증으로 반환한다.

## 재현

Node 24.19.0을 사용하는 CI 명령: `npm ci --ignore-scripts`, `npm test`, `npm run build -- --local`, `npm --prefix on-client run check`, `npm --prefix on-client test`.
실제 공개 URL을 별도로 확인하려면 `npm run identity:live`. 공개 URL 접근에 실패하면 명확하게 실패(미검증)하며 성공을 가장하지 않는다.

**안전 경계:** 브라우저/CLI 자기 검사는 공식 ALEPH 심판 통과, SDP/CLCO 실계정 연결, WebAuthn E2E, 유료 모델 사용, 41종 공격 방어를 증명하지 않는다. 새 Vercel alias 배포 및 프로젝트의 BLOCKED 상태는 코드 수정만으로 복구할 수 없다.

## 바꾸지 않은 식별자

- 기존 `judgeIssuer`와 Supabase IdP는 별도의 신뢰 경계라서 저장소명으로 바꾸지 않는다.
- 기존 `publicAppUrl`은 WebAuthn RP ID와 origin 검증에도 사용되는 실제 alias라서 임의 변경하지 않는다.
- `aleph.config.json.step=12`는 루트 방어전, `on-client`는 13–22단계 Claire 앱이다.
- `alekov-client-starter`, `start-alekov.ps1` 등은 외부 연동 계약이며 Claire는 사용자 표시명이다.
- `on-client/.on-starter-manifest.json`의 SHA와 과거 검증 기록은 당시의 증적이므로 현재 SHA로 소급 변경하지 않는다.

## 외부에서 확인할 잔여 과제

1. Vercel 대시보드에서 BLOCKED 사유를 확인하고 운영자 승인 아래 해결한다. 새 READY 배포의 SHA 및 alias 전환을 재검증한다.
2. GitHub main 필수 CI 체크·강제 푸시 금지 Ruleset이 아직 미설정이므로 관리자가 적용한다.
3. ALEPH 심판이 등록한 저장소 URL과 실제 제출 SHA, Windows Native Host/SDP/CLCO는 별도 실계정/운영 측 증거로 검증해야 한다.
