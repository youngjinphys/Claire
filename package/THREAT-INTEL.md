# 위협정보와 패키지 조회의 구분

루트 [api/threat-intel.js](../api/threat-intel.js)는 현재 501 미구현 경로입니다. 문서에 공급자·키·받은 시각 예시를 넣어 실제 수집이 된 것처럼 표시하지 않습니다.

Claire 로컬 앱에는 별도의 [공개 패키지 OSV 대조](../on-client/src/vulnerabilities/README.md)가 있습니다. 승인된 공개 npm 이름과 정확 버전만 조회하며, 알려진 취약점 정보와 실제 침해 탐지는 다릅니다. 기본 허용 목록이 비어 있으면 외부 조회는 없습니다.

Windows System/Application 로그 건수, XDR 합성 fixture, 공개 취약점 목록은 서로 다른 자료입니다. 결과·시각·출처·조회 범위를 함께 확인하고 없는 원천을 예제로 대신하지 않습니다.
