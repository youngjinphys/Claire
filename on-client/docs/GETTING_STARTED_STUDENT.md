# 기존 Claire 프로젝트에서 시작하기

이미 작업한 저장소의 `on-client/`를 계속 사용합니다. 시작 틀 재설치, 새 프로젝트 생성, 기존 제출물 삭제는 현재 앱을 실행하는 데 필요하지 않습니다.

1. [실행 안내](STUDENT_LAUNCH_GUIDE.md)로 일반 권한 서버 하나를 켭니다.
2. 기존 `/`의 세 탭과 통합 `/dashboard.html`을 확인합니다.
3. [호스트 관측](../student/HOST_OBSERVATION.md)의 수집 명령으로 새 JSON을 만들고 수동 선택합니다.
4. 출처·시각·단위와 미연결/실패를 먼저 확인한 뒤 필요한 학생 화면만 개선합니다.
5. [확인 순서](STUDENT_RUNBOOK.md)에 실제 실행 결과를 기록합니다.

## 수정 영역

학생 뷰 진입점은 `student/extension.mjs`의 `createStudentView()`입니다. 기존 identity·decision·events·status·vulnerabilities·AI·explanation·action 훅을 보존합니다. 같은 파일의 `hostPanel()`은 통합 화면에서도 재사용됩니다. 공통 화면을 복제하거나 서버의 원천 권한 검증을 학생 표시로 대신하지 않습니다.

선택 사항이라는 이유만으로 `student/appearance.json`을 만들지 않습니다. 현재 파일과 제공 경로가 없으므로 자동 반영되는 설정으로 안내할 수 없습니다.

## 학습과 제품 상태

단계별 학습 항목은 [CURRICULUM.json](CURRICULUM.json)에 남아 있습니다. 이는 보존된 교육 자료이며 현재 공식 포털의 승인·점수·순위 정책을 코드가 증명하지 않습니다. [학생 작업 프롬프트](STUDENT_PROMPTS.md)는 현재 파일에 필요한 변경을 요청하는 형식입니다.

연결되지 않은 SDP·AI를 가상 데이터로 성공처럼 꾸미지 않습니다. 관리자 권한·방화벽 변경·공격 시험을 사용하지 않고 읽지 못한 이유를 표시합니다. 현재 알려진 코드 경계는 [한계 문서](../../docs/CURRENT_LIMITATIONS.md)를 확인합니다.
