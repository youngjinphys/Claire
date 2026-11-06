# 두 실행 대상의 구성

| 대상 | 흐름 | 필요한 실행 환경 |
|---|---|---|
| 루트 방어전 | public → api → 인증/기기/소유권/정책 → 기존 DB | 서버 함수 환경과 명시적 운영 설정 |
| Claire | on-client/public → on-client/src/server.mjs → 로컬 센서 또는 별도 원천 | 로컬 Node 서버, 기본 루프백 |
| 호스트 파일 | student/collect-host.mjs → 임시 JSON → 수동 선택한 학생 패널 | 일반 권한 OS 조회 |

정적 HTML 서버만으로 루트 API가 실행되지 않습니다. 로컬 앱의 전체 구성과 소스별 책임은 [현행 구성도](../on-client/docs/STUDENT_ARCHITECTURE.md)에 있습니다. 설정·구성도는 원격 운영 연결이나 공식 수용의 증거가 아닙니다.
