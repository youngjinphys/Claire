# SDP 호스트 연결 계약

현재 [sdp-host.mjs](../src/engine/sdp-host.mjs), [설정 검증](../src/engine/sdp-host-config.mjs), [학생 어댑터](../student/engine-adapter.mjs), [서버](../src/server.mjs)를 기준으로 합니다. 과거의 “조회 메서드 3개뿐” 또는 “기록·기기·세션 미구현” 설명은 현재 코드에 맞지 않습니다.

## 기본 상태와 명시적 설정

설정이 없는 기본 실행은 미연결입니다. 원천 기능이 없으면 빈 성공을 만들지 않고 오류를 반환합니다. DEMO와 실제 SDP 설정은 혼합하지 않습니다. `connected` 모드는 어댑터 구성 상태일 수 있으므로 개별 원천 응답을 확인해야 합니다.

운영자가 준비한 프로젝트 밖의 개인 설정을 서버의 `--sdp-host-config` 또는 Windows 실행 도구의 `-SdpHostConfig`로 전달합니다. 설정·CA·개인 인증서·개인키·토큰 파일은 Git·제출물 밖에 둡니다. 값 자체를 문서나 명령행에 넣지 않습니다.

설정의 허용 키는 `schema`, `projectId`, `host`, `port`, `servername`, `caFile`, `certFile`, `keyFile`, `tokenFile`이며 schema는 `alekov.sdp.host.v1`입니다. 경로·파일·중복 키·TLS·시간·응답 검증의 정확한 조건은 설정 모듈이 정본입니다. HTTP, 인증서 검증 해제, 임의 URL/헤더 주입을 연결 해결책으로 사용하지 않습니다.

## 현재 제공되는 기능

| 메서드/경로 | 의미 |
|---|---|
| readIdentity | 원천 context에서 현재 본인 신원·기기·세션 투영 |
| readApps / decideAccess | 본인 프로젝트의 업무 앱과 원천 접근 판정 |
| readEvents / readDevices / readSessions | 본인 기록·등록 기기·현재 세션의 제한된 조회 |
| 조치 관련 호스트 메서드 | 별도 조치 구성과 권한 검증이 있을 때 사용. 기본 관측과 구별 |

학생 어댑터는 호스트가 실제 제공한 메서드만 전달합니다. [조회 범위](SDP_HOST_OBSERVATION.md)와 [조치 모듈](../src/actions/README.md)을 함께 확인합니다.

## 신뢰·개인정보 경계

요청은 승인된 개인 mTLS·JWT와 HTTPS 경계를 사용합니다. 현재 subject/project/session·정책·파일 증거가 변하면 이전 결과를 현재 결과로 내보내지 않습니다. 요청 시간 초과·취소·원천 오류는 deny나 빈 성공과 다릅니다.

설정과 파일 검사가 모든 Windows ACL/reparse 위험이나 운영 인증서 발급을 완전히 입증한다는 뜻은 아닙니다. Native AI 신원과 SDP 신원도 자동으로 같다고 판단하지 않습니다. 실제 원천 발급·릴레이 수용·개인 권한은 운영 환경의 별도 확인 대상입니다.

이 문서는 로컬 소스 계약입니다. 저장소 밖의 과거 시험 경로나 날짜별 PASS를 현재 검증 완료 주장으로 사용하지 않습니다.
