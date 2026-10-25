# 최초 수업 계약·테스트 출처 복원 기록

검토 기준: 저장소 최초 README-only 커밋 a59ee96e100d0fe4dc9fbb0a88647993ff36ce77,
최초 수업 자산 도입 커밋 ea5c6d043fdeb22e3427d9b5f92f87b7fe8cf157,
11단계 저장점 287bedb8e69a2c5bc3b44ea5586ac382987cf8b0.

## 원자적 복원

- AGENTS.md: 수업 최초 계약 바이트와 일치하도록 복원. 특히 bundle-notes.json을 커밋하지 않는 규칙을 복원.
- .gitignore: 11단계의 bundle-notes.json 제외 설정으로 복원하고 실제 추적에서 파일 제거. 공개 가능한 설명 3줄은 package/bundle-notes.template.json에 원문 보존.
- docs/DETECT_EVENTS.md: 최초 제공된 사건 계약을 정확히 복원. 이후 추가된 비공식 검증 기기 탐지 아이디어는 docs/DETECT_VERIFIED_DEVICE_LOCAL.md로 분리.
- xdr/README.md와 scripts/xdr-run.mjs: 최초 제공된 XDR 계약 및 실행기를 정확히 복원. 보너스 검문소 확장 모듈은 보존하지만 수업 실행기 실행 경로를 임의로 개조하지 않음.
- package/baseline-functions.json: 최초 allowedNew=['api/ai.js','api/threat-intel.js']를 정확히 복원. 이후 단계 API 6개는 별도의 package/stage-api-inventory.json에 도입 단계와 함께 표기하며, 원래 스타터 허용 목록에 편입하지 않음.
- test/r5.test.mjs: 최초 두 테스트를 정확히 복원. 이후 단계 14개 회귀 시험은 test/r5-stages2-5.test.mjs로 분리하고 npm의 test:r5에서 함께 실행.

## 의도적으로 초기 상태로 되돌리지 않은 항목

- test/package-starter.test.mjs: 최초 테스트는 api/ai.js와 api/threat-intel.js만 존재한다고 가정한다. 현재는 2~12단계 서버 라우트 6개가 실제 추가되어 원본 테스트를 그대로 실행하면 실패한다. 원본 allowlist 기대값은 그대로 고정하고 별도 학생 확장 목록으로 실제 파일을 교차 검증한다. 초기 계약을 변경해 허가한 것처럼 만들지 않는다.
- docs/DECIDER_REQUEST.md: 최초 수업 계약과 동일한 Git 객체이므로 복원 불필요.
- test/xdr-run.test.mjs: 최초 수업 테스트와 동일한 Git 객체이므로 복원 불필요.
- src/decider.mjs, src/detect.mjs, package/POLICIES.md, package/DEMO.md: 과제 단계별로 학생에게 구현 또는 작성하라고 명시된 영역이다. 11단계 기능을 삭제하는 일괄 롤백은 수행하지 않는다.

이 문서는 **파일·테스트 출처**만 검증한다. ALEPH 운영 엔진의 공식 reason-code 등록부와 41종 실제 판정 결과는 확인되지 않았으므로 통과를 주장하지 않는다.

## 자동 불변성 검증

test/course-original-provenance.test.mjs는 수업 최초 도입 Git blob SHA와 AGENTS.md, 공통 계약, 원본 테스트, XDR 실행기를 바이트 단위로 대조한다. 최초 test/r5.test.mjs의 2건과 분리된 단계별 14건을 npm run test:r5에서 모두 실행한다.
