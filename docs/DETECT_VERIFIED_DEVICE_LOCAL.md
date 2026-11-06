# 검증된 기기 사건에 대한 선택적 로컬 확장

정본은 [detect-verified-device.mjs](../src/detect-verified-device.mjs)입니다. 원 수업 사건 계약 [DETECT_EVENTS.md](DETECT_EVENTS.md)를 바꾸지 않는 별도 함수 `detectVerifiedDeviceAnomaly(events, { verifyEngineEvent })`입니다.

독립적인 원천 verifier가 없으면 observe를 반환합니다. 각 사건은 verifier에서 받은 GET/allow, 유효 시각·subject·deviceId, 검증된 네트워크 기준선과 unusual 편차를 모두 만족해야 합니다. 브라우저 헤더나 사용자가 쓴 네트워크 이상 문자열은 증거가 아닙니다.

현재 구현은 동일 subject/device의 10분 구간에서 **120건을 초과**하는 검증 자료를 찾아 `propose_revocation`을 제안합니다. 이는 실제 기기 회수·원천 집행·공식 탐지 판정이 아닙니다. 정확한 필드·정렬·동률 처리는 함수가 정본입니다.

Claire의 파일 기반 네트워크 보고서와 Windows 경고·오류 합계는 이 함수의 검증된 사건을 대신하지 않습니다. 수치를 만들기 위해 트래픽·공격을 발생시키지 않습니다. 테스트 이름은 루트 package.json의 `test:verified-device`에 있으며 합성 자료 검증과 운영 사건을 구분합니다.
