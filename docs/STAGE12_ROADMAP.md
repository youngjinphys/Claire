# 현재 루트 서비스와 로컬 앱의 범위

`aleph.config.json.step`은 12입니다. 이는 저장소 설정이며 모든 공식 단계 통과 또는 `on-client`의 최종 완료를 뜻하지 않습니다.

| 영역 | 구현 위치 | 현행 해석 |
|---|---|---|
| 자료실·공지·복구 | 루트 api/ 및 src/recovery/ | 현재 인증·소유권·기기·정책 경계가 적용되는 서버 기능 |
| 판정·제한된 탐지 | src/decider.mjs, detect*.mjs, auth-xdr.mjs | 원천 계약과 검증 입력 범위 안의 코드 |
| 기기 승인 | api/device.js, src/device-access.mjs | 등록·assertion·현재 grant 검증 |
| 인증 세대 | api/auth.js, src/auth-cookie-generation.mjs | 늦은 응답의 쿠키 덮어쓰기 보호. 별도 SQL 필요 |
| 루트 AI·위협정보 | api/ai.js, api/threat-intel.js | 현재 501 미구현 응답 |
| Claire 로컬 앱 | on-client/ | 일반 권한 관측·학생 화면·조건부 원천 연결 |

실제 DB 마이그레이션·외부 센서·운영 계정·공개 배포·공식 심판 결과는 코드만으로 확인되지 않습니다. 외부 역할이나 라이브 상태를 날짜가 지난 문서의 문장으로 대신하지 않습니다.

현재 앱 사용법은 [on-client](../on-client/README.md), 전체 안내는 [문서 색인](README.md), 개선이 남은 사항은 [현재 한계](CURRENT_LIMITATIONS.md)로 연결합니다. 과거 로드맵의 예정 작업과 현재 구현을 동시에 완료/미완료로 표시하지 않습니다.
