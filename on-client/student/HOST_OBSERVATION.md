# 학생 영역의 호스트 관측

근거: [수집기](collect-host.mjs), [학생 표시](extension.mjs), [통합 화면](../public/dashboard.mjs). 기존 네트워크·방화벽·Windows 기록 수집과 네 카드 표시를 재사용합니다. 별도 수집 서버·설정 변경·권한 상승을 추가하지 않습니다.

## 수집과 표시

기존 `on-client` 폴더의 일반 권한 터미널에서 실행합니다.

```sh
node student/collect-host.mjs
```

새 임시 폴더의 `observation.json` 경로가 출력됩니다. 기존 `/`의 학생 상태 영역 또는 `/dashboard.html`의 **다시 조회 · 보고서 선택**에서 지정합니다. 이 버튼은 JSON만 읽고 OS 명령을 실행하지 않습니다. 새 관측에는 수집기를 다시 실행한 새 파일이 필요합니다.

원본은 `claire.host-observation.v1`, `local-node-runtime`, `user-generated-local-file-not-authenticated` 계약입니다. 사용자가 선택한 **서명되지 않은 파일**이므로 원본 진위나 동일 PC를 인증하지 않습니다. 내부 IP·DNS가 있을 수 있으니 공개 저장소·캡처에 넣지 않습니다. POSIX 파일 생성은 0600 모드를 요청하고 Windows ACL은 환경을 따릅니다.

## OS별 실제 조회 범위

| 항목 | Windows | macOS | Linux |
|---|---|---|---|
| 네트워크 | `os.networkInterfaces`와 `dns.getServers` | 동일 | 동일 |
| 방화벽 | `Get-NetFirewallProfile -PolicyStore ActiveStore`의 프로필 설정 | `socketfilterfw --getglobalstate`의 Application Firewall | 고정된 firewalld/UFW 상태 조회 |
| OS 기록 | Get-WinEvent의 System/Application, Level 2 오류·3 경고 | Windows 전용·해당 없음 | Windows 전용·해당 없음 |

네트워크는 Node 실행 환경의 IP·인터페이스·루프백과 DNS resolver 정보입니다. 기본 게이트웨이·전체 라우팅·모든 어댑터 DNS·MAC·호스트 이름·패킷을 수집하지 않습니다. Windows 방화벽의 ActiveStore는 현재 활성 프로필·타사 방화벽·모든 규칙 적용을 보증하지 않습니다. macOS pf 및 Linux nftables/iptables 전체 상태도 이 관측 범위가 아닙니다.

System/Application은 각각 최근 24시간의 최대 2,001건을 읽어 2,000건 초과를 감지합니다. 초과하면 정확한 건수를 null로 표시합니다. 정상적으로 일치 사건이 없는 0건과 권한·도구·시간 초과의 확인 불가는 구별합니다. **이 건수는 침해나 공격 탐지 결과가 아닙니다.**

수집 명령은 코드에 고정되어 있으며 관리자 실행·sudo/runas·방화벽 변경·서비스 시작/중지·로그 삭제·공격 재현을 하지 않습니다. 한 명령의 제한 시간은 8초, 출력 상한은 64 KiB입니다. 수집 보고서 상한은 128 KiB입니다.

## 시간·상태·추이

- `producedAt`: 수집 보고서 생성 시각.
- 원천 `measuredAt`: 구현상 조회 기준 시각. 방화벽 명령 직전 또는 이벤트 집계 종료 기준이며 명령 완료 시각과 같다고 가정하지 않습니다.
- `windowStart`/`windowEnd`: Windows 이벤트의 24시간 집계 구간.
- `loadedAt`: 브라우저의 파일 검증 시각. OS 재측정 시각이 아닙니다.

현재 품질 판정은 보고서 기준 15분 경과 또는 미래 5초 초과를 구별합니다. 파일 읽기는 10초 기한, 이력은 탭 메모리 최대 10건입니다. 같은 생성 시각은 이력에서 중복으로 처리하며, 같은 시각·다른 내용 충돌을 완전히 구분하지 못하는 한계가 있습니다. 타이머의 미래 판정 임계값도 품질 함수와 차이가 남아 있으므로 [현재 한계](../../docs/CURRENT_LIMITATIONS.md)를 확인합니다.

Windows 비교는 사용자의 동일 PC·실행 환경 확인 뒤 두 보고서의 24시간 합계 차이를 보여 줍니다. 이는 그 사이 새로 발생한 사건 수가 아닙니다. 서명되지 않은 자료이므로 확인 체크가 기기 인증을 대신하지 않습니다.

## 화면·다운로드 경계

`hostPanel(state, mode)`의 상단 네 카드는 네트워크·방화벽·Windows 기록·SDP입니다. `state.hostRedraw`와 `[data-host-report-details]`를 통합 화면에서 재사용합니다. 읽는 중 버튼 비활성화·대기 안내, 오류 이유·다음 행동, 기본 상세 펼치기 조작이 있습니다. 두 화면의 초점·상세 상태는 각각 검증해야 합니다.

비식별 집계 JSON은 사용자가 직접 저장하며 `claire.host-aggregate-evidence.v1`에 개수·시각·원천·최신성·조회 상태만 넣습니다. IP·DNS 주소·인터페이스명·계정·SDP 사건은 제외합니다. `firewallBackends` 값은 Windows에서는 프로필 수, Linux에서는 확인된 도구 수, macOS에서는 해당 관리 도구 관측 수이므로 플랫폼 간 같은 대상을 센 값으로 비교하지 않습니다.

SDP 미연결·DEMO·어댑터 구성과 PC 관측은 독립입니다. 실제 연결과 권한은 기존 제공 화면의 원천 응답에서 확인합니다. 데이터가 없으면 예시 숫자를 넣지 않습니다.

[앱 실행](../docs/STUDENT_LAUNCH_GUIDE.md) · [전체 확인 순서](../docs/STUDENT_RUNBOOK.md)
