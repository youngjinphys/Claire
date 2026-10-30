# Claire 운영 배포·Git 정합성 감사 — 2026-10-30

## 관측한 현재 상태

- 감사 기준 GitHub `main`: `a249f059911e2485c3ace59a1490e6701ce97c02`.
- `aleph.config.json.repoUrl`: `https://github.com/youngjinphys/Claire` — **기존에 수정 완료**, 중복 변경하지 않음.
- Vercel 프로젝트 ID: `prj_3GP9UIJyL5aRcK6RaJao5qqV6UHK` (리소스명 `choi-bujang-secret-vault`, Git 저장소명과 독립).
- 공개 alias `skt-aleph-defense.vercel.app`는 `READY` 배포 `dpl_GjDajzU1FADPFQ2Gu8cDxZbFrNQ6`, Git 커밋 `b1918ce52cbbc968dfe5ebfb95a086cc64565d52`를 가리킴.
- 위 감사 기준 `main`의 production 배포 `dpl_JCP1ecfpgudNS4MHnSogKeTb9VAQ`는 `BLOCKED`; 배포 이벤트는 비어 있었음.
- `BLOCKED`의 개별 원인은 조회 결과에 없고, 계정 Activity Events 조회는 현재 앱 권한에서 403이었음. **저장소 URL 불일치, 소스 빌드 에러, 계정 과금/인증 문제 중 어떤 원인인지 단정할 수 없음**.

## 코드 차원의 후속 보완

1. 기존 `scripts/verify-live-identity.mjs`는 특정 Git HEAD와 alias의 공개 `/aleph.json`을 1회 익명 HTTPS GET으로 교차검증한다. GitHub Actions `Public deployment identity drift`는 매일 01:15 UTC와 수동 실행 시 이 검증을 수행한다. `stale`, `mismatch`, `unverifiable`은 모두 워크플로 실패로 남는다.
2. `api/ops.js`가 서버가 보고한 `Content-Length`만 믿고 `response.text()`를 호출하던 메모리 경계를 수정한다. 실제 스트림의 바이트를 제한하고, 제한 초과·잘못된 인코딩·손상 JSON은 안전하게 판정보류/실패로 다룬다. 민감한 인증 API의 성공 본문을 읽지 않는다.
3. 무인증 복구 거부의 HTTP 상태·JSON 외에 `Cache-Control: no-store`도 함께 확인한다. 캐시 가능한 오류 응답은 이 조건의 검증 증거가 아니다.
4. 새로운 단위 테스트는 Content-Length 누락·조작, 공개 manifest 과대 응답, 복구 거부 캐시 정책 위반을 재현한다.

## 운영자만 확인 가능한 막힘과 순서

1. [차단된 배포](https://vercel.com/youngjin305-navercoms-projects/choi-bujang-secret-vault/JCP1ecfpgudNS4MHnSogKeTb9VAQ) 상세 화면에서 `BLOCKED` 사유, 팀/프로젝트의 배포 권한, Git 커밋 작성자 권한, 비용/쿼터, Vercel 알림 및 계정 상태를 확인한다.
2. Vercel [공식 DEPLOYMENT_BLOCKED 가이드](https://vercel.com/docs/errors/deployment_blocked)의 조건에 맞는 해결만 진행한다. 추가 커밋·프로젝트명 변경·alias 강제 재설정은 원인 규명 없이 실시하지 않는다.
3. 해결 뒤 신규 `READY` production 배포의 Git SHA가 당시 `main`과 일치하는지, alias가 그 배포에 연결되었는지, `npm run identity:live`가 실제 `verified`인지 각각 검증한다.
4. GitHub `main`은 보호가 비활성화된 상태였으므로 Settings → Rulesets에서 승인된 상태 검사, 강제 푸시 차단 등 권한 정책을 별도로 구성한다. 코드로만 보호 설정이 적용되었다고 주장하지 않는다.

## 신뢰 경계와 제한

- Node unit/mock/CI와 Vercel 배포 상태는 다른 근거다. `BLOCKED`일 때 `main` CI 성공은 운영 성공을 보장하지 않는다.
- Vercel 프로젝트 이름, 공개 alias, ALEPH `judgeIssuer`, Supabase IdP, `on-client`의 레거시 프로토콜 ID는 상호 다른 식별자이므로 임의로 Claire로 바꾸지 않는다.
- 공식 ALEPH 심판 승인, 실학생 인증, CLCO/SDP 권한, 공식 41개 공격 결과는 이 모니터에 포함되지 않는다.
