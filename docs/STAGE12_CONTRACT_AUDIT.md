> **2026-10-27 정오표:** 아래의 `youngjinphys/choi-bujang-secret-vault`는 **2026-10-16에 검토한 예전 저장소 기록**입니다. 현재 정본은 `youngjinphys/Claire`이며 `aleph.config.json.repoUrl`·배포 메타데이터·제출 URL의 일치 여부는 [현재 감사](IDENTITY_CONSISTENCY_2026-10-27.md)를 따릅니다. 역사적 공식 심판 결과를 소급 변경한 것은 아닙니다.

# ALEPH Stage12 공식 심판·학생 계약 전수 검토 (2026-10-16)

## 범위 및 증거의 권한

GitHub youngjinphys/choi-bujang-secret-vault의 추적 파일, 작업 규칙, 테스트·제출 스크립트와 11단계 부모 287bedb8e69a2c5bc3b44ea5586ac382987cf8b0를 검사했다. 공식 심판의 41종 공격 전 목록, 런타임 채점 알고리즘, 운영 엔진 allowedReasonCodes 등록부와 요청별 엔진 감사 로그는 저장소에 없다. 따라서 로컬 검사에 성공해도 공식 판정에 합격했다고 주장할 근거는 없다.

| 출처 | 확인된 규약 | 확인 불가 |
| --- | --- | --- |
| AGENTS.md | 수정 범위, 저장점, 비밀값 취급, 자기 점검과 공식 판정 구분 | 심판 내부 구현 |
| docs/DECIDER_REQUEST.md | aleph.decision.v1의 요청 명칭 18개와 decide(request) 출력 5개 필드 | 실제 allowedReasonCodes 등록부 |
| docs/DETECT_EVENTS.md | 9단계 연습 사건·회수 제안 형식 | 공식 엔진 사건 검증·실제 회수 |
| xdr/README.md | brute-force, web-injection, known-cve, persistence, privilege, exfiltration 단독 decide(alert) 계약 | 실제 센서 통합과 심판 41종 판정 |
| docs/STAGE12_EVIDENCE.md | 12단계·41종 모두 공식 검증 후 완료, 모의·서버 HTTP·엔진 로그 분리 | 공식 공격 41건 원장과 각 결과 |
| scripts/judge-contract-check.mjs | 가상 입력의 로컬 모듈 제한 실행 검사 | 운영 심판 채점 결과 |
| scripts/bundle.mjs, src/attack-check-stage12.mjs | 규칙 이름, 제출 스키마, 공개 GET/HEAD 자기 점검 최대 20개 | 인증된 쓰기 요청과 공식 41종 전체 |

## 확인된 계약 충돌과 적용 방안

1. **단일 커밋:** 11단계 저장점 287bedb8을 직접 부모로 하고 12단계 관련 모든 변경을 단일 커밋으로 병합한다. package/bundle-commit-files.json의 목록과 실제 Git diff를 교차 검증한다.
2. **메모 계약:** 최초 수업 계약 AGENTS.md는 bundle-notes.json과 artifacts/submission.json의 커밋을 금지한다. 12단계 단일 저장점에서 추가했던 임의 예외를 철회하고 파일을 다시 Git 추적에서 제외했다. 기존 설명 세 줄은 개인 파일과 byte-equivalent인 package/bundle-notes.template.json에 보존하며, 깨끗한 clone의 bundle 생성은 이 추적 템플릿을 선택한다. 12단계 설명 형식은 그대로 유지한다.
3. **배포 주소:** 공식 공개 주소는 https://skt-aleph-defense.vercel.app 이다. 자동 배포 고유 URL인 VERCEL_URL과 혼동하지 않는다. /aleph.json은 12단계에서 canonical 공개 주소를 표기하되 1~11단계의 원래 VERCEL_URL 계약은 건드리지 않는다.
4. **격리 런타임:** 제공된 허용 모듈 범위와 공개 HTTPS GET/HEAD 요청만 제출 경로에 사용한다. URL은 허용된 node:url에서 직접 가져오고 node:fs/promises·node:os·쓰기 HTTP 및 합성 복구 파일 작업은 Stage12 bundle에 포함하지 않는다. 로컬 격리 재현 테스트는 공식 심판 구현 자체가 아니다.
5. **자기 관측 대 공식 결과:** Stage12의 최대 20개 기록은 공개 HTTPS 응답과 미실행(not_run)을 구분하는 학생 자기 점검이다. /api/ops가 보여주는 확인 3건·보류 1건·미실행 1건은 특정 서버 GET 관측일 뿐 41종 방어의 공식 점수가 아니다. officialJudgeEvidence=false, 공식 0/12와 0/41 검증을 유지한다.
6. **남은 과제:** package/README.md 및 package/DEMO.md에는 패키징·재배포 시연 칸이 남아 있다. 물리 WebAuthn 승인, 학생 A/B 엔드투엔드 접근, 운영 회수·백업 복구, 공식 41종 시나리오는 별도 증거와 강사 확인이 필요하다.

## 제출 전 재현성 기준

- 메인 HEAD는 11단계 체크포인트의 직접 자식인 Stage12 커밋 단 하나여야 한다.
- Git에서 제외한 로컬 bundle-notes.json이 있다면 추적된 기본 template과 explanation이 같고 빈 줄 제외 3줄이어야 한다. 일반 clone에는 이 개인 파일이 없으며 검증된 template 3줄을 사용한다.
- 최신 SHA의 npm ci, 전체 로컬 시험, 검증된 빌드 후 마지막에 npm run bundle을 실행한다. 시험 중 오프라인 파일이 생성됐더라도 실제 요청 결과로 제출하지 않는다.
- 배포 /aleph.json의 step, commit, publicAppUrl, repoUrl, originalApiUrl을 동일 HEAD의 설정 및 제출 결과와 비교한다. 원본 Supabase learning_notes 경로는 같은 HTTPS issuer origin이고 다른 문제를 5단계 주소 오류로 잘못 판단하지 않는다.
- 요청을 보내지 않거나 HTTP 응답을 받지 못하면 미실행으로 남긴다. 비밀값과 메모 본문은 제출에 포함하지 않는다.
- evidence_rejected가 재발하면 실제 심판 커밋 SHA·첫 오류·요청별 상태를 확인한다. 심판 비공개 규칙과 학생이 작성한 로컬 검증은 같다고 가정하지 않는다.
