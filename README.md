# Claire

이 저장소에는 서로 다른 두 실행 대상이 있습니다. **PC에서 Claire를 실행하려면 `on-client/`를 사용합니다.**

| 대상 | 경로 | 실행 범위 |
|---|---|---|
| Claire 로컬 앱 | `on-client/` | 같은 PC의 Node 서버와 브라우저. 기본 주소 `http://127.0.0.1:5189/`, 통합 화면 `/dashboard.html` |
| 기존 1–12단계 방어전 | 루트 `api/`, `src/`, `public/` | 서버 함수·인증·자료실·작전실. 루트에는 시작 스크립트가 없으며 정적 미리보기만으로 API가 동작하지 않음 |

## 기존 폴더에서 실행

지원 선언은 Node.js `>=22.15 <23 || >=23.5 <25 || >=26 <27`이며 CI 기준은 24.19.0입니다. `on-client`에는 외부 npm 의존성이 없습니다. 루트 서비스의 직접 의존성과 정확한 버전은 [package.json](package.json)과 [잠금 파일](package-lock.json)을 기준으로 합니다. 루트 기기 승인과 작전실은 [기기 승인 경계](docs/STAGE11_DEVICE.md) 및 [루트 구성](package/ARCHITECTURE.md)에서 확인합니다.

```sh
# Claire 저장소 루트에서, 현재 작업을 보존한 채 확인
git status --short
git rev-parse HEAD
cd on-client
node --version
npm run check
npm start
```

브라우저에서 `/dashboard.html`을 열고, 종료는 실행 터미널에서 Ctrl+C를 누릅니다. 기존 `/`의 보호 현황·업무 앱·보안 기록도 유지됩니다. 설치 프로그램, 포장, Vercel 배포는 로컬 실행의 전제 조건이 아닙니다.

계정 연결 없이 화면을 살펴보려면 저장소 루트에서 `npm --prefix on-client run demo`를 실행합니다. `/`에서 보호 현황과 업무 앱을 확인하고, `/dashboard.html`에서 **한 번 측정**을 눌러 실행 환경의 CPU·메모리·디스크를 관측할 수 있습니다. SDP 판정과 이벤트는 예제 데이터입니다.

## 정보의 출처

- 상단 네 카드: 네트워크·방화벽·Windows 기록·SDP. 앞의 세 항목은 `node student/collect-host.mjs`로 생성한 보고서를 사용자가 선택하여 표시합니다. 버튼은 수집기를 실행하지 않습니다.
- CPU·메모리·디스크: 로컬 서버의 `/api/local-pc`가 관측합니다. VM·컨테이너·WSL에서는 해당 실행 환경의 값일 수 있습니다.
- SDP·XDR·AI: 별도 원천 연결과 권한이 필요합니다. PC 조회 성공은 SDP 연결 성공이 아닙니다.
- `npm run demo`는 SDP 예제입니다. 실제 로컬 자원 값이나 선택 파일의 원본 진위를 인증하지 않습니다.
- System·Application의 경고·오류 건수는 **침해나 공격 탐지 결과가 아닙니다**. 미조회·실패·해당 없음은 0건과 다릅니다.

## 오류 복구와 검증

측정 캐시는 경과 시간을 단조 시계로 관리합니다. PC 시계가 뒤로 바뀌면 그래프의 연속 구간을 끊으며, 화면과 JSON은 같은 최근 10분·최대 120개 보관 규칙을 사용합니다. 원천의 시각을 현재 시각으로 덮어쓰지는 않습니다.

연결·기기 승인·배포 식별 조회는 요청과 응답 본문을 제한 시간 안에서 처리합니다. 늦은 응답은 현재 상태를 갱신하지 않으며, 취소된 읽기와 폐기한 HTTP 본문을 정리합니다. 내보내기는 다운로드 요청 결과를 표시하고 실패 시 기존 관측 자료를 유지합니다.

루트 인증의 enforce 모드는 서명된 v2 세대 쿠키만 허용합니다. 이전 쿠키를 가진 사용자는 다시 로그인해야 합니다. 서버의 인증 수락 기한과 브라우저의 쿠키 보관 기한은 별도이며, 배포 절차·시계 조건은 [쿠키 세대 계약](docs/AUTH_COOKIE_GENERATIONS.md)을 따릅니다. 로컬 PC 관측에는 이 루트 인증 설정이 필요하지 않습니다.

저장소 루트에서 `npm test`와 `npm --prefix on-client test`로 회귀 검증을 실행합니다. 제출 묶음 테스트는 별도 임시 폴더의 합성 자료를 사용하며 기존 제출 증적을 출력 대상으로 삼지 않습니다. 실제 외부 서비스·개인 PC·운영 DB 검증은 별도입니다.

7개 독립 기준의 재귀 검토 결과와 적용 범위는 [검토 기록](docs/RECURSIVE_REVIEW_2026-11-23.json)에 기록합니다.

## 문서

[전체 문서 색인](docs/README.md)에서 현행 안내, 수업 원본, 과거 증적을 구분합니다.

- [실행·종료·포트](on-client/docs/STUDENT_LAUNCH_GUIDE.md)
- [기능·검증 순서](on-client/docs/STUDENT_RUNBOOK.md)
- [구성·신뢰 경계](on-client/docs/STUDENT_ARCHITECTURE.md)
- [호스트 보고서](on-client/student/HOST_OBSERVATION.md)
- [현재 코드의 한계](docs/CURRENT_LIMITATIONS.md)

## 개발·운영 경계

루트 개발에는 `package-lock.json`에 고정된 의존성이 필요하지만 로컬 앱만 실행할 때 루트 설치는 필요하지 않습니다. 루트의 AI·위협정보 API는 501 미구현 응답과 로컬 앱의 조건부 AI 연결을 혼동하지 않습니다. 자세한 범위는 [루트 기능](docs/STAGE12_ROADMAP.md)을 봅니다.

`aleph.config.json`의 단계 값 12, 저장소·발급자·배포 주소는 설정이며 현재 공개 배포 성공이나 공식 평가 통과의 증거가 아닙니다. 소스·문서 갱신 자체는 운영 DB 적용, 방화벽 변경, 기존 제출물 수정 또는 공개 배포의 증거가 아닙니다. 이전 README의 단계별 기록은 [원문 보존본](docs/history/README_BEFORE_2026-11-06.md)에 두었으며 현재 사용법으로 적용하지 않습니다.
