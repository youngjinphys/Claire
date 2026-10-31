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

통합 관제 화면 `http://127.0.0.1:5189/dashboard.html`은 이 학생 화면의 기존 `hostPanel()`을 그대로 가져와 **상단 4개 카드**와 선택 파일의 상세를 표시합니다. 기존 CPU·메모리·디스크 조회는 `/api/local-pc` 하나를 재사용하고, SDP·XDR도 이미 존재하는 제공 API만 조회합니다. 통합 화면과 `/`는 **하나의 로컬 Node 서버**에서 동작합니다. 설치 프로그램이나 포장 명령은 실행하지 않습니다.

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
## OBS의 출처별 품질 판단 적용 (2026-10-31)

이 변경은 OBS의 최신성·수집 범위·출처 분리 원칙만 학생 화면의 기존 로컬 JSON 관측에 도입합니다. 새로운 API·관리자 권한 명령·원격 네트워크 업로드·방화벽 변경·자동 재조회는 없습니다.

hostReportQuality(report, now)는 수집된 원천을 네트워크 / 방화벽 / Windows 이벤트로 나누고 observed, partial, unavailable, not_applicable를 표시합니다. 보고서가 15분보다 오래되거나 OS 시각이 5초보다 미래이면 세 관측 카드의 현재 값은 확인 불가로 표시하며, 세부 원본은 역사적 자료로 구분해 남깁니다. SDP 카드와 판단은 기존 제공 기능을 그대로 따릅니다.

원천별 관측 개수, OS/원천 시간, 조회 상태, 결측 사유를 펼쳐 확인할 수 있습니다. Linux/macOS에서 Windows 이벤트는 미적용이지 0건이 아닙니다. 일부 관측 성공은 전체 OS 안전, 공격 탐지, 전체 방화벽 규칙 검증의 증거가 아닙니다. 파일은 여전히 사용자 선택 자료이고 디지털 서명으로 진위 검증되지 않았습니다.

검증: on-client 폴더에서 npm run check 및 npm test; Node 24.19.0 일반 사용자 실행 후 기존 보호 현황 학생 화면에서 정상/오래된 JSON을 각각 선택해 표시를 비교합니다. 실제 사용자 PC 결과와 CI 테스트 예제를 혼동하지 않습니다.

OBS 측에는 인증 후 이미 위생 처리된 호스트 집계 자료만을 별도의 로컬 JSON 증적으로 출력하도록 추가했으며, OBS의 호스트 비밀 로그나 사용자의 Claire 보고서를 다른 서비스로 이동하지 않습니다.

## OBS → Claire: 비식별 진단 증적 내보내기 (2026-10-31)

OBS의 **비식별·출처 명시·수동 내보내기** 원칙을 적용했습니다. 기존 원본 `observation.json`에는 로컬 IP·DNS 구성이 포함될 수 있으므로 공유용으로 직접 사용하지 않습니다.

- 로컬 보고서를 검증한 다음 학생 화면에서 **비식별 집계 JSON 저장**을 직접 누르면 `claire.host-aggregate-evidence.v1` JSON을 다운로드하도록 요청합니다. 버튼은 보고서를 선택하기 전이나 읽는 동안 비활성화됩니다.
- 포함 범위는 수집기 실행 OS, 생성·내보내기 UTC 시각, unsigned 근거, 원천별 상태·이유, 인터페이스/DNS/방화벽 조회 백엔드 **개수**, Windows 24시간 System/Application 경고·오류 **건수**에 한합니다. 원시 IP, DNS 주소, 인터페이스 이름, 파일 경로, 사용자·세션 식별자, SDP 사건 본문과 인증값은 제외됩니다.
- 값마다 개수 단위·원천 시각·출처·상태를 붙입니다. macOS/Linux의 Windows 이벤트는 `not_applicable`과 `null`, 실패는 `unavailable`과 `null`입니다. 실제 0건과 구분합니다.
- `freshness: recent|stale|clock_skew`, `coverage: observed|partial|unverifiable|unavailable`, 적용 가능한 원천 수와 실제 조회된 원천 수를 기록합니다. 오래된 보고서도 **과거 자료**로 저장할 수 있지만 현재 정상 판단으로 승격하지 않습니다.
- 보고서는 여전히 **사용자가 직접 선택한 서명되지 않은 파일**에 기반합니다. 집계 JSON은 수집기 진위/동일 PC/완전한 방화벽 정책/침해 부재에 대한 증명이 아닙니다. 원본을 OBS로 보내거나 OBS 수집기와 합치지 않습니다.
- 기존 학생 `extension.mjs` 파일 안에서 승인된 보고서만 가공합니다. 새 권한·서비스·원격 API·관리자 명령·포장 기능을 추가하지 않습니다.

검증: `cd on-client && npm run check && npm test` 실행 후 보호 현황 학생 화면에서 실제 보고서 선택 → 집계 저장 → 주소·개인 식별자가 없는지 파일 내용을 확인합니다. 시험 합성 데이터와 본인 PC 결과를 구분합니다.

## 단일 화면에서 확인하기

`npm start`로 `127.0.0.1:5189`의 서버 **하나만** 켭니다. 일반 권한에서 `node student/collect-host.mjs`를 실행하고 출력된 임시 JSON을 `/dashboard.html`의 네트워크·방화벽·Windows 기록·SDP 영역에서 수동 선택합니다. 상단 4개 상태 카드 및 출처, CPU·메모리·디스크 3개 측정 카드와 최근 10분 추이, 선택한 보고서의 Windows System/Application 구분 및 네트워크·방화벽 상세, 본인 XDR 기록을 순서대로 확인합니다.

- 선택 JSON은 파일 읽기 경로만 사용하고 자동 실행·권한 상승·설정 변경이 없습니다. 새 OS 조회에는 새 수집기 실행과 새 파일 선택이 필요합니다.
- 로그 경고·오류는 **침해나 공격 탐지 결과가 아닙니다.** 읽지 못한 값은 확인 불가, macOS/Linux의 Windows 이벤트는 해당 없음입니다.
- SDP 정책/기록의 진위와 PC 수집 파일의 진위는 별개의 출처이며, 서로 비교·인증되지 않습니다. 예제 DEMO는 원천 실연결이 아닙니다.
- 기존 수업용 `/`와 `student/extension.mjs`의 13~22단계 렌더링·제출 동작은 유지됩니다.
