# 11단계 보완 — 기기 승인과 자료실 접근 통제

검사 시작 HEAD: `e645052adffb0ff57ce250e2b03dc90b24d0d71c` (`12단계 저장점`). 기존 12단계 작업을 덮어쓰지 않고, 누락된 11단계를 후속으로 완성합니다. `aleph.config.json.step=12`를 유지합니다.

## 세 가지 오류의 원인과 재현 가능한 수정

| 오류 | 기존 원인 | 수정 |
| --- | --- | --- |
| `S11_APPROVED_SCREEN_CLOSED` | 승인된 기기를 검증할 서버 엔드포인트와 UI 전이가 없었음 | 서버가 확인한 WebAuthn 등록 후 별도 assertion 검증 결과에 한해 기존 메모 자료실 열기 |
| `S11_DATA_BEFORE_APPROVAL` | 로그인만으로 `workspace`와 `loadNotes()`가 활성화되었고 API에는 기기 게이트가 없었음 | 로그인 직후 메모 DOM 잠금, `/api/notes`, 공지, 활성 복구 API에서 승인 기기의 단기 증명을 매 요청 검증 |
| `S11_BADGE_IS_TRUST` | PWA 설치 상태를 기기 승인과 명확히 분리하지 않았음 | PWA 설치/표시 여부는 정보성 UI로만 사용, 서버 승인 및 서명 검증으로만 권한 판단 |

## 신뢰 경계 및 구현

- 인증: 기존 Supabase Auth의 사용자 JWT 및 서버측 `createLoginVerifier`. 프론트엔드는 기존 로그인·자료실 CRUD를 보존합니다.
- 기기 등록: `POST /api/device?action=registration-options`으로 **서버가 발급한 일회용 challenge**를 `s11_device_challenges`에 저장합니다. 등록 결과는 서버의 WebAuthn 검증을 통과한 단일기기(`singleDevice`, `backed_up=false`) 공개키로만 `s11_device_credentials`에 `approved`를 기록합니다.
- 기기 사용: 등록만으로 메모를 열지 않습니다. `assertion-options`으로 새로운 challenge를 생성하고, 인증기의 새 서명을 `assertion-verify`에서 검증합니다. 성공 시 **15분 만료의 grant**를 발급하며 브라우저는 이를 JS 메모리에서만 보유합니다. 기기 개인키는 인증기에 남습니다.
- 서버 권한: 학생의 `x-aleph-device-proof` 값은 그 자체로 신뢰하지 않습니다. 각 요청마다 서버가 사용자 ID·JWT 바인딩 SHA-256·grant 만료·현재 등록 기기의 승인/철회 상태를 조회합니다. 증명 없음, 만료, 철회, 사용자 불일치: **HTTP 403 `DEVICE_NOT_VERIFIED`**. 로그인 정보 없음: **HTTP 401 `UNAUTHORIZED`**.
- 기존 강사 공지 소유권 및 메모 소유자 검사는 변경하지 않았습니다. **별도로 검증된 운영 심판 서명 JWT**는 기존 회귀 검증 주체이며 학생 브라우저가 이 권한을 생성하지 않습니다.
- 설치형 앱: `manifest.webmanifest`, 192/512 PNG 아이콘, `sw.js` 및 공개 `offline.html`로 구성합니다. Service Worker는 오프라인 안내만 캐시하고 API·로그인·민감한 메모를 캐시하지 않습니다. 설치 버튼은 기기 승인 행위가 아닙니다.

**제한 사항:** 본 구현의 기기 승인 정책은 서버가 WebAuthn 등록과 사용자 검증을 통과한 단일기기 공개키에 대해 자체 승인하는 **학습용 구현**입니다. 기관 관리자 승인, 등록 기기의 제조사 attestation, 실제 ALEPH SDP 엔진의 장치 등록부 연결까지 구현되었다는 뜻은 아닙니다. 일부 동기화 패스키는 `singleDevice` 조건을 만족하지 못해 등록이 거부될 수 있습니다. 비밀번호를 탈취한 공격자의 신규 기기 최초 등록 방지는 별도 독립 승인자가 필요합니다.

## 재현 순서

```bash
git status --porcelain --untracked-files=all
git log -1 --format='%H %s'
npm install
npm run test:device
npm run recovery:retest
npm run test:operations
npm run judge:check
npm run build -- --local
# 11단계 저장점 커밋 후
npm run bundle
```

정적 미리보기: `python3 -m http.server 4173 --directory public` (API는 실행하지 않음). 서버 함수 검증: 공식 Vercel 프로젝트의 `vercel dev` 또는 `https://skt-aleph-defense.vercel.app` 사용. 종료: 터미널에서 `Ctrl+C`. 배포 되돌리기는 검증된 Vercel 이전 deployment를 관리자가 선택하고, DB의 기기 등록 기록은 별도 승인된 운영 절차에 따라 관리합니다. `git reset --hard`로 다른 작업을 제거하지 않습니다.

UI 시험: 기존 자료실 → 로그인 → 기기 등록 요청 → 인증기 PIN/생체 검증 → 서버 등록 확인 → 새 인증기 서명 → 기존 본인 자료실 개방. 승인 뒤에 인증기를 취소하면 잠김 상태가 유지되고 **승인된 기기로 열기** 버튼으로 다시 요청할 수 있어야 합니다. 설치 버튼만 누르면 절대 자료가 보이면 안 됩니다.

가산점 세 조건: 새 checkout `npm install` 성공, `src/decider.mjs` 계약과 `RULE_IDS` 유지(격리 `judge:check`), 설정 `step=12`로 11 이상. 공식 심판 통과나 실기기 E2E는 아직 이 자료로 입증하지 못했으며 로컬 모의 테스트와 구분합니다.
