# Claire 학생 영역: 로컬 네트워크·방화벽·Windows 기록 조회

## 구현 범위

현재 프로젝트의 `student/extension.mjs` 학생 표시 영역에 **네트워크 / 방화벽 / Windows System·Application 기록 / SDP 연결 상태**를 네 카드로 추가합니다. 아래에는 실제 보고서의 출처, 시간, 수집된 구성 정보, 24시간 기록 집계 및 사용자가 선택한 보고서 간 비교를 둡니다.

- 기존 공통 화면 `public/app.js`, `public/index.html`, `public/style.css` 및 `src/` 서버 코드는 **변경하지 않습니다**.
- `student/appearance.json`은 존재하지 않으며, 현재 제공 앱이 이 파일을 로드하지 않으므로 새로 만들지 않습니다.
- 기존 `renderIdentity`, `renderStatus`, `renderEvents` 등 제공 학생 훅을 보존합니다. 별도 OS 조회 API를 만들어 제공 학생 허용 경로(6개)를 우회하지 않습니다.
- **SDP 미연결**은 `renderStatus()`가 전달하는 엔진 모드에서 판단하고, 로컬 PC 보고서의 성공으로 변경하지 않습니다. `connected`도 운영 SDP 서버의 실계정 연결·보안 정책 성공이 아니라 어댑터 연결 구성만 뜻할 수 있으므로 기존 제공 정보에서 별도로 확인합니다.
- Windows 경고·오류 건수는 **침해나 공격 탐지 결과가 아닙니다**. 24시간 범위의 이벤트 로그 수치이며 악성·정상 원인을 판정하지 않습니다.

## 일반 권한 수집 방법

기존 Claire의 `on-client` 폴더에서 다음을 실행합니다. Node.js 권장 버전은 수업 검증 기준 **24.19.0**입니다. `node student/collect-host.mjs`는 앱 서버를 시작하거나 Windows 권한을 상승시키지 않습니다.

Windows PowerShell:

```powershell
cd .\on-client
node --version
node .\student\collect-host.mjs
npm run check
npm test
npm start
```

macOS / Linux 셸:

```sh
cd on-client
node --version
node student/collect-host.mjs
npm run check
npm test
npm start
```

수집 명령은 OS 임시 폴더 밑에 **새 하위 폴더**를 만들고 `observation.json`을 생성한 후, **경로만** 표준 출력으로 알려 줍니다. 원래 프로젝트 폴더, 제출물, 방화벽 정책, 서비스, 이벤트 로그를 쓰거나 수정하지 않습니다. 파일은 OS 권한 범위 안에서 새로 만들어지며 POSIX에서는 파일 모드 0600을 요청합니다. Windows의 실제 ACL은 계정·상위 임시 폴더 정책을 따르므로 파일에 개인정보가 있을 수 있음을 유의하세요. 필요 없어진 보고서는 본인이 삭제해 주세요.

앱을 연 뒤 `http://127.0.0.1:5189/` → `보호 현황` → **학생 상태·알림 표시** → `다시 조회 · 보고서 선택`을 누르고 이 `observation.json` 파일을 지정합니다. **이 버튼은 OS 수집기를 실행하지 않고 파일을 다시 읽습니다.** 새로운 관측이 필요하면 터미널에서 먼저 수집기를 재실행하여 **새 파일**을 선택해야 합니다. 수집 파일이 바뀌지 않았는데 다시 선택하면 가짜 새 측정 시각을 추가하지 않습니다. 브라우저가 파일 원본을 서명으로 인증하는 기능은 없으므로, 출처는 '사용자가 선택한 로컬 보고서(원본 자체는 별도 인증되지 않음)'로 구분합니다.

프로젝트에 이미 있는 `http://127.0.0.1:5189/dashboard.html`의 CPU·메모리·디스크 측정 기능은 재구현하지 않습니다. 필요하면 해당 화면을 따로 엽니다. 설치 프로그램이나 포장 명령은 실행하지 않습니다.

## 운영체제별 계측 정의

| 계측 | Windows | macOS | Linux | 주의 |
| --- | --- | --- | --- | --- |
| 네트워크 | `node:os.networkInterfaces`, `node:dns.getServers` | 동일 | 동일 | Node 프로세스가 보는 인터페이스(IP·IPv4/IPv6·loopback) 및 DNS만. **MAC, 사용자, 호스트 이름, 패킷** 수집하지 않음. 기본 게이트웨이는 미조회로 명시 |
| 방화벽 | `Get-NetFirewallProfile -PolicyStore ActiveStore` 읽기 | `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` | `/usr/bin/firewall-cmd --state`, `/usr/sbin/ufw status` | 읽기 전용. 관리 도구가 다르면 범위도 다름. **활성 도구 조회가 전체 OS 방화벽 정책의 증명은 아님** |
| OS 기록 | `Get-WinEvent -FilterHashtable` (`System`, `Application`, Level 2 오류·Level 3 경고, 24시간, 로그별 최대 2,001건 조회) | `Windows 전용 · 해당 없음` | `Windows 전용 · 해당 없음` | 각 로그에서 2,000건 초과시 정확한 수치가 아닌 **조회 상한 초과/확인 불가**. 보안 탐지가 아닌 OS 이벤트 집계 |
| SDP | 기존 제공 `renderStatus({mode,...})` 재사용 | 동일 | 동일 | 운영 계정 SDP 서버의 실연결·정책 판단을 PC 조회 결과로 대체할 수 없음 |

Windows 명령은 `-NoProfile -NonInteractive`로 실행하고 실행된 명령·인자는 코드에 고정되어 있습니다. 관리자 실행·`sudo`·`runas`·방화벽 규칙 변경·서비스 시작/종료·이벤트 로그 삭제, 드라이버/자체 터널, 공격 재현, 원격 스캔은 실행하지 않습니다. 이벤트 로그에서는 **건수만** 계산하고 원본 메시지, 사용자·기기 식별자, 사건 세부정보를 JSON에 넣지 않습니다.

네트워크 IPv4/IPv6 주소와 DNS 서버 주소는 개인정보 또는 네트워크 구성 기밀일 수 있습니다. 보고서를 Git·공개 폴더·공유 캡처에 넣지 않습니다. 수집 도구에서 OS 구성이나 비밀값을 바꾸지 않으며 웹 UI는 선택한 JSON을 로컬 브라우저 안에서만 읽고 외부로 업로드하지 않습니다.

## 상태 해석·실패 안내

| 상태 | 뜻 | 다음 행동 |
| --- | --- | --- |
| `ok` | 해당 범위의 읽기와 형식 검증이 완료됨 | 측정 시각·단위·원천 및 범위를 대조 |
| `partial` | 일부 조회만 성공했거나 기록 상한에 도달함 | 정확한 총건수 또는 전체 방화벽 상태라고 단정하지 않음 |
| `unavailable` | 권한·도구·시간 초과·형식 등으로 해당 값을 확인할 수 없음 | 실패 코드를 보고 담당자에게 조회 권한·도구를 문의. 관리자 권한으로 재실행하지 않음 |
| `not_applicable` | Windows 전용 로그를 macOS/Linux에서 조회하지 않음 | 0건으로 표시하지 않고 Windows 전용으로 유지 |
| `SDP 미연결` | 원천 엔진이 연결되지 않음 | 기존 제공 화면에서 별도 연결·계정 상태 확인 |
| `DEMO` | 제공 SDP의 가상 예제 | OS 실측·실제 SDP 연결 성공과 혼합 금지 |

수집 시각은 ISO 8601 문자열로 보관하고 화면에서 현재 로컬 시간으로 변환합니다. PC는 Node 프로세스가 실행되는 OS 환경입니다. Docker·WSL·VM에서는 물리 PC 전체 대신 해당 실행 환경의 주소나 관리 도구를 보고할 수 있습니다.

같은 파일을 두 번 불러와도 역사 데이터가 두 건으로 늘지 않습니다. 서로 다른 생성 시각의 보고서만 세션 메모리에 최대 10건 보존합니다. Windows 두 시점의 최근 24시간 경고·오류 집계 차이는 **지난 24시간의 이동 창 합계 차이이지, 두 측정 사이 새로 발생한 이벤트 수가 아닙니다**. 맥·리눅스에는 이 수치의 변화량을 계산하지 않습니다. 과거 기록은 새 브라우저 탭/페이지 로드에서 초기화됩니다.

## 테스트 및 실제 검증 경계

- `npm run check`: 기존 학생/서버 구문 확인
- `npm test`: 기존 제공 테스트 및 `test/host-collection.test.mjs`, `test/student-host-view.test.mjs`의 읽기 전용 호출, 실패, UI, 출처 검증
- 실제 PC에서: **수집 실행 → JSON 경로 확인 → '다시 조회' → 네 카드와 System/Application별 건수·시각 확인 → 의도된 파일 오류 확인 → 다른 보고서 선택 → SDP 미연결/DEMO 상태 확인 → Ctrl+C 종료**
- 관리자 권한 필요 항목을 억지로 성공시키거나 침투/공격 시험을 하지 않습니다.
- Windows/macOS 실기기 사용자 환경의 실제 수집 결과는 해당 사용자 PC에서 재현하고 명시적으로 기록하기 전까지 확정하지 않습니다. CI/모의 결과를 사용자 PC 실측이라고 하지 않습니다.

참고: [Node OS 인터페이스](https://nodejs.org/docs/latest-v24.x/api/os.html#osnetworkinterfaces), [Get-NetFirewallProfile](https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallprofile), [Get-WinEvent](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-winevent), [firewalld](https://firewalld.org/documentation/utilities/firewall-cmd.html), [Ubuntu UFW](https://ubuntu.com/server/docs/firewalls/).
