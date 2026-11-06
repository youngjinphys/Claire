# 정책 문서의 정본과 범위

루트 판정 규칙은 [src/decider.mjs](../src/decider.mjs)와 [원 입력 계약](../docs/DECIDER_REQUEST.md)이 정본입니다. API의 인증·소유권·기기 승인과 SDP 판정은 별도 경계이며, UI 상태로 권한을 만들지 않습니다.

[자원 구역](../docs/STAGE8_RESOURCE_ZONES.md), [기기 승인](../docs/STAGE11_DEVICE.md), [로그인 경계](../docs/STAGE12_AUTH_XDR.md), [쿠키 세대](../docs/AUTH_COOKIE_GENERATIONS.md)를 구분합니다. 이 문서에 소스와 별도로 정책 허용 목록을 중복 관리하지 않습니다.

Claire의 PC 자원·방화벽 읽기와 Windows 경고·오류 집계는 정책 집행이나 침해 판정이 아닙니다. 관측 실패는 확인 불가이며 관리자 권한·보안 설정 변경으로 성공 표시를 만들지 않습니다.
