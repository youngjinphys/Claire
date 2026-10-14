# 검문소·탐지 규칙

공식 SDP 입력 계약(`docs/DECIDER_REQUEST.md`)에서 확인한 조건만 판정합니다. 엔진이 제공하지 않는 사용자 소유자·강사 역할을 학생 코드가 추측하지 않습니다.

| 규칙 | 단계 | 막는 공격·제약 | 확인 방법 |
|---|---:|---|---|
| `device_registered` | 6 | 등록·사용자 결합이 확인되지 않은 기기의 보호된 요청 거부 | `npm run decider:test` |
| `step_up_required` | 7 | 가상 사건에서 낯선 네트워크·비정상 시간·최근 위험 신호가 결합되면 추가 확인 | `npm run fixture:7` |
| `memo_zone` | 8 | 허용된 개별 메모 GET/PUT 경로 이외 거부; 저장된 소유권은 메모 API에서 재검사 | `npm run test:zone` |
| `announcement_read` | 8 | 허용된 공지 GET 경로 이외 거부; 조회 권한·객체 존재는 API에서 확인 | `npm run test:zone` |
| `announcement_instructor_write` | 8 | 공식 SDP v1 요청에 검증된 강사 역할이 없으므로 공지 변경은 기본 거부 | `npm run test:zone` |

**별도 9단계 탐지 함수:** `detect(events)`는 `burst_read`를 제안할 수 있지만 실제 회수를 집행하지 않습니다. `burst_read`는 `RULE_IDS`에 넣는 SDP 규칙이 아니라 별도 탐지 결과입니다.

브라우저에서 버튼을 숨기는 것만으로 서버 접근이 차단됐다고 적지 마세요. 공식 엔진의 `allowedReasonCodes` 등록부는 이 저장소에 없으므로 실제 코드 목록의 일치 여부는 별도 확인이 필요합니다.
