# 루트 로그인 경계의 제한된 XDR 연결

근거: [api/auth.js](../api/auth.js), [src/auth-xdr.mjs](../src/auth-xdr.mjs), [원자적 카운터 SQL](../supabase/step12_xdr_auth_rate_guard.sql), [쿠키 세대 처리](AUTH_COOKIE_GENERATIONS.md). 코드 연결과 실제 운영 배포를 구분합니다.

로그인 입력 형식을 검증하고 인증 사업자 호출 전 계정/신뢰된 엣지 IP의 시도 카운터를 확인하는 경로가 있습니다. 원문 계정·IP 대신 서버 비밀로 만든 HMAC 키를 카운터에 사용합니다. 비밀번호를 XDR 입력으로 전달하지 않습니다. 신뢰된 IP가 없더라도 계정 제한 경계는 별개입니다.

`verifiedEdgeAddress`는 Vercel 환경의 단일 유효 `x-vercel-forwarded-for`를 제한적으로 사용합니다. 임의 forwarded 헤더·User-Agent·클라이언트 역할을 검증된 신원으로 취급하지 않습니다. 인증 사업자가 확인한 결과와 입력 검사를 기존 brute-force/web-injection 분류에 연결합니다.

나머지 known-cve/persistence/privilege/exfiltration 모듈이 있다는 사실은 실제 호스트·네트워크 센서가 연결됐다는 뜻이 아닙니다. XDR 분류, 요청 제한, 기기 승인, 최종 데이터 소유권 검증은 서로 다른 경계입니다. 로그인 성공도 기기 검증을 생략하지 않습니다.

DB/RPC 또는 필요한 서버 자격을 확인할 수 없으면 실패하며 자동으로 인증을 우회하지 않습니다. SQL 파일은 기존 운영 DB에 자동 적용되지 않습니다. 환경변수 이름과 secret의 보관 경계만 문서화하고 값은 Git·로그·화면에 넣지 않습니다.

루트 `test:auth-xdr` 등은 개발 회귀검사이며 실제 공격 생성·침투 시험·공식 41종 판정이 아닙니다. 이번 문서 작업에서는 원격 로그인, 보안 설정 변경, 포장 명령을 실행하지 않습니다.
