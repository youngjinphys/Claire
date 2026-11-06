# Claire 실행·종료 안내

대상은 기존 저장소의 `on-client/`입니다. 루트 방어전 서비스와 실행 방법이 다릅니다. [package.json](../package.json)과 [서버](../src/server.mjs)를 기준으로 합니다.

## Windows·macOS·Linux 공통

지원 선언은 Node.js `>=22 <25 || >=26 <27`, CI 기준은 24.19.0입니다. 기본 앱은 외부 npm 의존성이 없습니다.

```sh
# 저장소 루트
git status --short
git rev-parse HEAD
cd on-client
node --version
npm run check
npm start
```

`http://127.0.0.1:5189/`는 기존 세 탭, `http://127.0.0.1:5189/dashboard.html`은 통합 관제입니다. 서버 창을 유지하고 종료할 때 Ctrl+C를 누릅니다. 브라우저만 닫아서는 서버가 종료되지 않습니다. 다시 켤 때는 같은 폴더에서 같은 명령을 사용합니다.

기본 상태는 SDP 미연결입니다. 예제 확인은 먼저 기존 서버를 종료하고 `npm run demo`로 실행합니다. DEMO는 가상 SDP 자료이며 실제 PC 자원 측정과 별도입니다.

## 호스트 보고서 선택

별도 일반 권한 터미널의 같은 앱 폴더에서 실행합니다.

```sh
node student/collect-host.mjs
```

출력된 임시 `observation.json`을 학생 화면 또는 통합 관제의 **다시 조회 · 보고서 선택**에서 지정합니다. 새 관측에는 수집기를 다시 실행한 새 파일이 필요합니다. 원본에는 내부 IP·DNS가 있으므로 Git·공개 캡처에 올리지 않습니다.

## 포트 충돌

다른 프로그램을 종료하지 말고 앱 포트를 바꿉니다. 허용 포트는 1024–65535입니다. `.env.example`만 편집해도 포트가 바뀌지는 않습니다.

PowerShell:

```powershell
$env:ON_PORT = '5190'
npm start
```

macOS/Linux 셸:

```sh
ON_PORT=5190 npm start
```

브라우저 포트도 5190으로 맞춥니다. 시스템 방화벽·실행 정책을 바꾸거나 관리자 권한으로 실행하지 않습니다.

## 선택 사항: 기존 Windows 실행 도구

[tools/start-alekov.ps1](../tools/start-alekov.ps1)은 Node 버전·폴더·포트를 확인합니다. 일반 PowerShell에서 실행할 수 있는 정책일 때만 사용합니다. 정책 때문에 실행되지 않으면 정책을 우회하는 대신 위의 `npm start` 경로를 사용합니다.

```powershell
powershell -NoProfile -File .\tools\start-alekov.ps1
```

지원 옵션은 `-Port`, `-Demo`, `-Background`, `-WaitSeconds`, `-NativeHostConfig`, `-SdpHostConfig`입니다. 백그라운드 실행은 안내된 해당 프로세스를 별도로 종료해야 하므로 기본 안내는 전경 실행입니다. 도구는 일부 민감 환경변수를 자식 프로세스에서 제외하므로 수동 서버 실행과 상속 환경까지 동일하지는 않습니다.

Native/SDP 설정은 운영자가 준비한 별도 비밀 파일을 사용합니다. 로컬 관제 실행에는 필요하지 않습니다. [AI](AI_SETUP_GUIDE.md)와 [SDP](SDP_HOST_CONNECTION.md)의 신원·권한 경계를 먼저 확인합니다.

## 확인 범위

앱 시작은 로컬 HTTP 응답을 확인한 것입니다. AI 승인, SDP 정책, 원천 조치 효과, 사용자 PC의 다른 OS 환경, 공식 단계 통과는 각각 다른 증거가 필요합니다. [검증 순서](STUDENT_RUNBOOK.md)와 [오류 안내](CONNECTION_TROUBLESHOOT.md)를 이어 봅니다.
