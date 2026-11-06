# 루트 방어전의 기기 승인 경계

대상은 루트 [api/device.js](../api/device.js), [device-access.mjs](../src/device-access.mjs), 자료실 API입니다. `on-client`의 호스트 보고서나 CPU 측정과 다른 기능입니다.

서버가 발급한 WebAuthn challenge와 검증 결과로 기기 등록/사용을 구분합니다. 등록만으로 자료실을 열지 않고 새 assertion과 서버 승인 상태를 확인합니다. grant는 인증 사용자·JWT 바인딩·만료·현재 기기 상태에 결속되며 브라우저의 설치 배지나 device 플래그는 권한이 아닙니다.

| 단계 | 경계 |
|---|---|
| 로그인 | 기존 인증 사업자와 서버 JWT 검증 |
| 등록 | 서버 challenge 및 WebAuthn 결과 검증 |
| 사용 | 새 assertion과 제한된 grant 확인 |
| 데이터 요청 | 현재 사용자와 저장된 소유권·기기 증명 재검사 |

PWA 설치와 Service Worker의 공개 오프라인 안내는 기기 인증과 별개입니다. 실제 기관 관리자 승인·제조사 attestation·모든 동기화 패스키·외부 SDP 등록부 연결을 구현했다고 주장하지 않습니다. 최초 등록 정책은 별도 운영 검토 대상입니다.

개발 검증은 루트 package.json의 `test:device`와 관련 회귀시험으로 분리합니다. 실제 인증기·사용자 계정·배포 검증은 해당 환경의 별도 기록이 필요합니다. 문서 정리 중 장치 등록, DB 적용, 포장, 원격 시험을 실행하지 않습니다.

[현재 전체 범위](STAGE12_ROADMAP.md) · [인증 쿠키](AUTH_COOKIE_GENERATIONS.md)
