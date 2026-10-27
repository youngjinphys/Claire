# Claire 저장소·배포 식별자 정합성 감사 — 2026-10-27

## 현재 정본과 외부 실측

| 종류 | 정본 또는 확인 내용 | 처리 |
| --- | --- | --- |
| GitHub 저장소 | `https://github.com/youngjinphys/Claire` (`main`) | `aleph.config.json.repoUrl` 정정 |
| Vercel 배포 Git 소스 | `youngjinphys/Claire`, 2026-10-26 배포 커밋 `8ccd5cc6…` | Vercel 배포 메타데이터에서 확인 |
| Vercel 프로젝트 리소스 이름 | `choi-bujang-secret-vault` | **보존:** 별도 배포 리소스 이름이며 저장소 URL이 아님 |
| 공개 배포 호스트 | `https://skt-aleph-defense.vercel.app` | **보존:** 이미 연결된 Vercel alias이자 학습 과제의 publicAppUrl |
| 공식 심판 발급자 | `https://aleph-judge-production.up.railway.app/defense/judge` | **보존:** 독립 발급자, 저장소 정체성 아님 |
| 학생 Supabase IdP | `ytvwpdjfrpwxwtucclpe.supabase.co` | **보존:** 별도 인증·자료 출처 |
| Claire 로컬 에이전트 표시 이름 | `Claire` | 브라우저 제목·브랜드·PowerShell 성공 메시지 정렬 |
| 로컬 패키지/내부 경로 | `alekov-client-starter`, `start-alekov.ps1`, `alekov` 프로토콜 | **보존:** 외부 도구·PowerShell 계약 식별자 |
| Root npm 이름 | `aleph-defense-starter` | **보존:** 기존 1–12단계 방어전 하위 프로젝트로, GitHub 저장소명과 별개 |
| Stage 13–22 및 Stage 1–12 | 단일 GitHub 저장소에 공존 | `aleph.config.json.step=12`는 루트 방어전 기준으로 유지 |

## 확인된 원인과 조치

1. `aleph.config.json`은 이전 GitHub 저장소 주소를 선언했으나, Vercel Git source는 이미 Claire였습니다.
2. `scripts/deployment-identity.mjs`는 Vercel의 `VERCEL_GIT_REPO_*`에서 manifest repoUrl을 조립하면서 설정의 repoUrl을 비교하지 않았습니다. 이제 **Stage 12에서 설정 URL이 Vercel Git 저장소와 대소문자를 제외하고 일치하지 않으면 빌드를 차단**하고, 일치하면 설정의 정확한 표시명(`Claire`)을 manifest에 기록합니다.
3. `scripts/bundle.mjs`는 URL의 owner/repository 글자 대소문자를 버려 제출 JSON의 URL이 설정 및 `/aleph.json`과 달라질 수 있었습니다. 적절한 정규화는 유지하되 저장소 원래 표기를 보존합니다.
4. `test/operations-stage12.test.mjs`와 `test/bundle-stage12-isolated.test.mjs`는 오래된 저장소 문자열을 현재 기대값으로 사용했습니다. 설정을 정본으로 사용하는 fixture와 오설정 거부 테스트로 교체했습니다.
5. `on-client/public/index.html`, PowerShell 성공 문구 및 일부 사용자 설명서는 예전 기본 이름 `케셰브`를 현재 표시명처럼 안내했습니다. 사용자 표시만 Claire로 통일하고 패키지 내부 식별자는 유지했습니다.
6. 과거 검증 문서의 옛 저장소명·SHA·0.1.0 진단 응답은 **역사적 실측 기록**이므로 덮어쓰지 않았으며 날짜가 있는 정오표를 덧붙였습니다.

## 재발 방지 검사

```bash
npm ci --ignore-scripts
npm test
npm run build -- --local
npm --prefix on-client run check
npm --prefix on-client test
```

CI에서는 Vercel 시스템 Git 정보와 같은 구조의 **가상 CI 메타데이터**로 `npm run build`를 추가 실행하고 생성된 `public/aleph.json`의 `repoUrl`, `publicAppUrl`, SHA를 검증합니다. 이 작업은 네트워크 배포나 평가 심판 호출이 아닙니다.

## 검증 경계 및 유지해야 할 구분

- `choi-bujang-secret-vault`는 현재 배포를 소유한 Vercel 프로젝트 **리소스 이름**입니다. 프로젝트의 기본 자동 생성 URL은 기존 프로젝트명을 사용할 수 있습니다. 기존 운영 alias/프로젝트 ID를 무작정 변경하면 인증 대상과 외부 평가 연계를 깨뜨릴 수 있어 변경하지 않았습니다.
- 현재 GitHub 저장소는 public이며, Vercel Git-source 메타데이터는 `Claire`에 연결돼 있었으나 실제 배포 `/aleph.json` HTTP 결과는 별도로 확인되어야 합니다. Vercel 배포 상태 READY만으로 HTTP 콘텐츠·공식 평가 수락까지 검증된 것은 아닙니다.
- 과거 Stage 12 평가 서술에서 old repo name이 등장하는 것은 해당 시점의 기록입니다. 현재 기준의 `main` 또는 `repoUrl`이라고 해석하면 안 됩니다.
- `on-client/.on-starter-manifest.json`의 SHA-256 목록은 **배포 현재 SHA가 아니라 최초 제공 시작 틀의 출처 스냅샷**이므로 현재 코드 내용에 맞춰 재작성하지 않습니다.
- 브랜치 보호 설정, 운영자 측 심판에 등록된 저장소 URL, Windows Native Host 등록, 실제 CLCO·SDP·Supabase 연결은 Git 코드 변경만으로 증명되지 않습니다.
