# Stage 12 · 실제 로그인 경계의 XDR 방어

기준: `287bedb8e69a2c5bc3b44ea5586ac382987cf8b0`. 수업용 XDR 6개 `decide(alert)` 구현은 변경하지 않습니다. 아래의 운영 연결이 **공식 XDR 평가 통과를 의미하지 않습니다**.

## 실제 운영에 연결된 범위

1. `POST /api/auth/login`에서 비밀번호가 인증 사업자에 전달되기 **전에**, 서버가 HMAC-SHA256으로 만든 계정/엣지 IP 키를 사용하여 Supabase 원자적 시도 횟수를 확인합니다. 10분 동안 같은 계정 **최대 20회**, 신뢰된 엣지 IP **최대 50회**. 초과 시 HTTP 429, `Retry-After`; 계정이나 IP는 원문 저장하지 않습니다.
2. Supabase Auth가 실제로 실패 응답을 돌려준 뒤에만 실패 횟수를 증가시킵니다. 확인된 실패만 기존 `xdr/brute-force/decide.mjs`의 Wazuh 형식으로 투영합니다. 2건은 `alert`, 20건은 `block`로 분류되는 회귀 사례를 시험합니다. IP를 신뢰할 수 없으면 XDR 차단 판정 근거로 사용하지 않습니다. **독립적인 계정 시도 횟수 제한은 IP 신뢰 여부와 무관**합니다.
3. 로그인 입력의 명백한 주입 문구만 기존 `xdr/web-injection/decide.mjs`로 검토하고, 잘못된 이메일·본문 형식·중복/불필요한 필드를 거부합니다. **비밀번호는 XDR 모듈에 제공하지 않습니다.** 정상 메모 본문은 SQL/스크립트 예시가 포함될 수 있으므로 내용 문자열만으로 XDR 차단하지 않습니다.
4. `Origin`·`Sec-Fetch-Site` 검사로 교차 사이트 로그인/세션/로그아웃 요청을 거부하고, `HttpOnly; Secure; SameSite=Strict` 갱신 쿠키와 `no-store` 응답을 유지합니다. 중복 리프레시 쿠키를 거부하고, 공급자 원시 로그인 실패 메시지를 일률적인 `LOGIN_FAILED`로 치환합니다.
5. 성공적으로 로그인하더라도 11단계 **WebAuthn 기기 서명 검증과 DB 승인 확인**을 건너뛰지 못합니다. 클라이언트 역할/기기 상태 플래그는 신뢰하지 않습니다.

## 신뢰 경계와 남은 부분

- 6개 연습용 XDR 중 **brute-force / web-injection**만 런타임 로그인 사실과 의미 있게 연결했습니다. `known-cve`, `persistence`, `privilege`, `exfiltration`은 각각 보안장비 탐지 로그·호스트 서비스 이벤트·서버가 검증한 권한 변경·네트워크 송신 텔레메트리가 필요합니다. 해당 관측 없이 쿠키, User-Agent 또는 쿼리 문자열로 '차단 성공'을 만드는 것은 신뢰 경계를 위반하므로 연결하지 않았습니다. 모든 6개 모듈의 과제/단위 시험은 유지합니다.
- 엣지 IP는 **Vercel 환경의 `x-vercel-forwarded-for` 단일 유효 IP**만 보조 정보로 사용합니다. `x-forwarded-for`처럼 클라이언트가 위조 가능한 헤더로는 IP별 봉쇄를 수행하지 않습니다. 헤더가 없으면 계정별 제한만 적용됩니다.
- XDR 모듈의 결과는 런타임 위험 분류입니다. **차단 집행은 신뢰된 DB 쿼터와 입력 검증이 담당**합니다. 운영 SIEM으로의 전송, 완전한 MITRE ATT&CK 탐지 범위, 실제 사건 대응, 기기 강제 회수, 독립 감사 로그 보존은 여전히 미검증입니다.
- 계정별 제한은 분산/프록시 우회와 특정 계정에 대한 고의적인 서비스 거부(DoS) 사이의 절충입니다. 계정당 20회/10분 정책을 운영 피드백으로 재조정하고, 정상 사용자의 오탐을 별도 증거로 추적해야 합니다.

## 데이터베이스와 운영

`supabase/step12_xdr_auth_rate_guard.sql`은 기존 Supabase를 대상으로 신규 `s12_auth_rate_window`와 `s12_auth_claim`, `s12_auth_record_result` RPC만 생성합니다. 두 함수는 `SECURITY INVOKER`, `search_path=''`, `service_role` 전용 EXECUTE 권한을 사용하고 `anon`·`authenticated`에 테이블/RPC 권한을 주지 않습니다. RLS를 활성화하고 공개 정책을 만들지 않은 것은 서비스 역할 전용 접근을 의도한 것입니다.

운영 서버에는 기존 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`가 필요합니다. 마지막 값은 브라우저, README, 로그, 제출 JSON으로 내보내지 않습니다. DB/RPC 접근이 불가능하면 인증을 우회하지 않고 HTTP 503으로 실패합니다. 테이블에는 HMAC 기반 가명 키·카운터·기간 시각만 저장하며, 저장 시점에서 24시간 넘은 행은 운영자가 정기적으로 삭제하도록 정책을 정해야 합니다.

## 검증

```bash
npm ci
npm run test:xdr
npm run test:auth-xdr
npm run test:device
npm run test:bundle-isolated
npm run decider:test
npm run bundle
```

`npm run bundle`은 마지막 커밋과 작업 트리가 일치해야 하므로 **커밋 후** 실행합니다. 공식 판정은 별도입니다.

- 정상: 적정 로그인 시도 후 서버 승인된 기기 assertion을 완료하면 기존 메모 CRUD 진입.
- 거부: 한 계정 10분 21번째/신뢰 IP 51번째 시도는 429; 다른 Origin은 403; 형식 오류는 400/413/415; 보안 카운터 장애는 503; 유효 로그인·기기 증명 없는 메모 GET은 401/403.
- 실제 사용자 인증, 물리 WebAuthn, 공식 41종 공격, 외부 XDR 센서 통합은 별도 검증 필요.
