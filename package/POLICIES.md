# 정책 문서의 정본과 범위

루트 판정 규칙은 [src/decider.mjs](../src/decider.mjs)와 [원 입력 계약](../docs/DECIDER_REQUEST.md)이 정본입니다. 아래 표는 현재 `RULE_IDS`와 실제 분기를 설명하는 색인이며 새 정책이나 허용 조건을 추가하지 않습니다. API의 인증·소유권·기기 승인과 SDP 판정은 별도 경계입니다.

## 구현된 SDP 규칙

| 규칙 ID | 코드가 검사하는 조건과 결과 | 해석의 제한 |
|---|---|---|
| `device_registered` | 보호 서비스·정규 경로·빈 쿼리 등 요청 범위를 확인하고, `deviceRegistered === true`와 유효한 subject/device 식별자를 검사합니다. 범위 또는 등록 검증이 실패하면 기본 거절을 유지합니다. | 브라우저가 보낸 기기 주장·설치 배지·PC 보고서는 등록 증명이 아닙니다. |
| `step_up_required` | 검증된 `judge_fixture` 문맥에서 비정상 시간대(06시 이전 또는 22시 이후), unusual 네트워크, 최근 120초 내 `risk_signal` 20건 이상이 모두 성립하면 추가 확인을 검토합니다. `stepUp.verified === true`이며 인증 경과가 120초 이내이면 추가 확인을 완료한 것으로 처리합니다. | 합성 위험 조건입니다. 미관측 위치·네트워크를 정상 값으로 채우거나 실제 공격 탐지라고 주장하지 않습니다. |
| `memo_zone` | 정규 `/notes/:id` 개별 경로의 GET/PUT만 대상입니다. 등록과 문맥 검증 뒤 allow 또는 합성 조건의 step_up이 가능합니다. 목록·내보내기·추가 경로는 이 허용에 포함되지 않습니다. | 실제 메모의 owner_id 권한은 API가 별도로 검증합니다. SDP 허용은 타인의 메모 접근 허가가 아닙니다. |
| `announcement_read` | 정규 `/announcements/:id`의 GET을 등록·문맥 검증 뒤 allow 또는 해당 합성 조건의 step_up으로 판정합니다. | 공지 쓰기나 클라이언트 역할 주장을 허용하지 않습니다. |
| `announcement_instructor_write` | 정규 공지 컬렉션/개별 경로의 POST·PUT·PATCH·DELETE를 식별하지만 SDP에서는 모든 주체에 대해 deny를 유지합니다. | 이름에 instructor가 있어도 강사 쓰기 예외가 아닙니다. 원 입력에는 검증된 강사 역할이 없으며 직접 API의 역할·소유권 검사는 별개입니다. |

기기 등록 검증이 합성 위험 판정보다 먼저입니다. 인식하지 못한 문맥·형식·경로에서는 기본 거절을 유지합니다. `signals.source === 'none'`의 unknown 위치·네트워크는 관측 부재이지 정상 환경의 증명이 아닙니다. 공지 쓰기에 `step_up`으로 우회하는 경로는 없습니다.

`test/judge-compat.test.mjs`는 구현된 모든 규칙 ID가 위 표에 존재하는지 확인합니다. 소스의 규칙을 바꿀 때 표의 설명도 대조해야 하며, 시험을 통과시키기 위해 존재하지 않는 규칙이나 예외를 적지 않습니다.

## 관련 경계

[자원 구역](../docs/STAGE8_RESOURCE_ZONES.md), [기기 승인](../docs/STAGE11_DEVICE.md), [로그인 경계](../docs/STAGE12_AUTH_XDR.md), [쿠키 세대](../docs/AUTH_COOKIE_GENERATIONS.md)를 구분합니다. 운영 설정의 허용 목록을 이 문서에서 새로 정의하지 않습니다.

Claire의 PC 자원·방화벽 읽기와 Windows 경고·오류 집계는 정책 집행이나 침해 판정이 아닙니다. 관측 실패는 확인 불가이며 관리자 권한·보안 설정 변경으로 성공 표시를 만들지 않습니다.
