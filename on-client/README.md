# Claire 로컬 앱 0.2.11

기존 프로젝트의 이 폴더에서 실행합니다. 단계마다 새 폴더를 만들거나 이전 제출물을 지울 필요가 없습니다. 내부 `alekov` 식별자는 프로토콜 호환용입니다.

```sh
node --version
npm run check
npm start
```

Node 지원 선언: `>=22 <25 || >=26 <27`. CI 기준: 24.19.0. 외부 npm 의존성 없음. 기본 주소는 `http://127.0.0.1:5189/`, 통합 관제는 `/dashboard.html`, 종료는 Ctrl+C입니다. `.env.example`은 참고 자료이고 시작 시 자동 로드되지 않습니다.

| 화면/자료 | 실제 동작 | 한계 |
|---|---|---|
| 기존 `/` | 보호 현황·업무 앱·보안 기록, 학생 렌더러, 조건부 AI·조치·패키지 조회 | 기본 실행은 SDP 미연결 |
| `/dashboard.html` | 학생 `hostPanel()` 재사용, 네 카드, 자원 추이·측정 기록·SDP 기록 | 조회 원천이 서로 다르며 통합 화면이 동일 PC/계정임을 인증하지 않음 |
| 호스트 보고서 | 일반 권한에서 `node student/collect-host.mjs`; 출력된 JSON을 수동 선택 | 파일 재선택은 새 OS 측정이 아님. 원본 미인증 |
| `/api/local-pc` | 실행 OS의 CPU %, 메모리 %·GiB, 앱 파일시스템 여유 GiB | 단위·관측 시각·오류 이유를 함께 확인 |
| `npm run demo` | 가상 SDP 자료 | PC 실측·운영 연결·공식 통과로 보고하지 않음 |

Windows System·Application의 최근 24시간 경고·오류 건수는 **침해나 공격 탐지 결과가 아닙니다**. macOS/Linux에서는 해당 없음이며, 권한·도구·시간 초과는 확인 불가입니다. 수집기는 방화벽·보안 설정을 바꾸거나 권한을 상승시키지 않습니다.

`npm run check`는 학생 확장과 서버 두 파일의 구문 검사입니다. `npm test`는 이 폴더의 테스트를 실행하며 운영 계정 연결을 대신하지 않습니다. 런타임 기능이 있다는 사실, CI 성공, 실제 PC 관측, 공식 평가를 분리해 기록합니다.


**관측 실패·최신성 표시:** PC 센서 조회가 모두 실패하면 `측정 실패 · 다시 측정 필요`, 일부 센서만 성공하면 `일부 측정 실패`, 기존 표본이 30초 이상 지나면 `측정값 오래됨`을 표시합니다. 조회 실패나 SDP 미연결은 수치 0이나 정상 판정으로 바꾸지 않습니다. 학생 보고서의 상세 영역은 최신성 갱신 후에도 열린 상태와 키보드 초점을 유지합니다.

[실행 안내](docs/STUDENT_LAUNCH_GUIDE.md) · [운영 확인 순서](docs/STUDENT_RUNBOOK.md) · [문제 해결](docs/CONNECTION_TROUBLESHOOT.md) · [호스트 수집 정의](student/HOST_OBSERVATION.md) · [전체 문서 분류](../docs/README.md)

근거: [package.json](package.json), [서버](src/server.mjs), [학생 표시](student/extension.mjs), [수집기](student/collect-host.mjs). 현재 작업에는 포장 명령과 배포가 필요하지 않습니다.
