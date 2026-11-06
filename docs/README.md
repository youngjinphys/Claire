# Claire 문서 색인

**현재 안내 기준:** `e139029312db2bce069be7ae0052698180d6ac7c`의 코드, 2026-11-06. 문서 변경은 실행 코드·운영 DB·설정·공식 성취를 바꾸지 않습니다. 코드 존재, 합성 시험, CI 실행, 사용자 PC 실측, 운영 연결, 공식 평가를 분리합니다.

## 먼저 읽기

- [로컬 앱 시작](../on-client/README.md) → [실행/종료](../on-client/docs/STUDENT_LAUNCH_GUIDE.md) → [확인 순서](../on-client/docs/STUDENT_RUNBOOK.md)
- [현재 기능](../on-client/docs/PRODUCT_OVERVIEW.md) · [구성/신뢰 경계](../on-client/docs/STUDENT_ARCHITECTURE.md) · [문제 해결](../on-client/docs/CONNECTION_TROUBLESHOOT.md)
- [호스트 보고서](../on-client/student/HOST_OBSERVATION.md) · [알려진 한계](CURRENT_LIMITATIONS.md)

다른 문서에서 실행 순서를 중복 정의하지 않고 해당 주제 문서로 연결합니다. 링크나 코드와 설명이 충돌하면 실행 코드·시험·명시적인 현재 원천을 확인합니다. 앱 코드가 외부 포털의 채점·순위·수료 정책을 정의하지 않습니다.

## 현행 안내

아래 문서는 현재 사용/개발 범위입니다. 날짜가 파일명에 남아 있어도 이 목록에 있으면 내용은 현행 안내이며, 과거 실측과 현재 live 상태를 섞지 않습니다. `AUTH_COOKIE_GENERATIONS.md`의 상세 경계는 기존 내용을 유지합니다.

- [README.md](../README.md)
- [docs/AUTH_COOKIE_GENERATIONS.md](AUTH_COOKIE_GENERATIONS.md)
- [docs/DEPLOYMENT_DRIFT_RUNBOOK_2026-10-30.md](DEPLOYMENT_DRIFT_RUNBOOK_2026-10-30.md)
- [docs/DETECT_VERIFIED_DEVICE_LOCAL.md](DETECT_VERIFIED_DEVICE_LOCAL.md)
- [docs/STAGE11_DEVICE.md](STAGE11_DEVICE.md)
- [docs/STAGE12_AUTH_XDR.md](STAGE12_AUTH_XDR.md)
- [docs/STAGE12_ISOLATED_BUNDLE.md](STAGE12_ISOLATED_BUNDLE.md)
- [docs/STAGE12_ROADMAP.md](STAGE12_ROADMAP.md)
- [docs/STAGE8_RESOURCE_ZONES.md](STAGE8_RESOURCE_ZONES.md)
- [on-client/README.md](../on-client/README.md)
- [on-client/docs/AI_SETUP_GUIDE.md](../on-client/docs/AI_SETUP_GUIDE.md)
- [on-client/docs/CONNECTION_TROUBLESHOOT.md](../on-client/docs/CONNECTION_TROUBLESHOOT.md)
- [on-client/docs/FINAL_PRODUCT_GUIDE.md](../on-client/docs/FINAL_PRODUCT_GUIDE.md)
- [on-client/docs/GETTING_STARTED_STUDENT.md](../on-client/docs/GETTING_STARTED_STUDENT.md)
- [on-client/docs/IMPLEMENTATION_CONTRACT.md](../on-client/docs/IMPLEMENTATION_CONTRACT.md)
- [on-client/docs/PRODUCT_OVERVIEW.md](../on-client/docs/PRODUCT_OVERVIEW.md)
- [on-client/docs/SDP_HOST_CONNECTION.md](../on-client/docs/SDP_HOST_CONNECTION.md)
- [on-client/docs/SDP_HOST_OBSERVATION.md](../on-client/docs/SDP_HOST_OBSERVATION.md)
- [on-client/docs/STARTER_UPDATE.md](../on-client/docs/STARTER_UPDATE.md)
- [on-client/docs/STUDENT_ARCHITECTURE.md](../on-client/docs/STUDENT_ARCHITECTURE.md)
- [on-client/docs/STUDENT_LAUNCH_GUIDE.md](../on-client/docs/STUDENT_LAUNCH_GUIDE.md)
- [on-client/docs/STUDENT_PROMPTS.md](../on-client/docs/STUDENT_PROMPTS.md)
- [on-client/docs/STUDENT_RUNBOOK.md](../on-client/docs/STUDENT_RUNBOOK.md)
- [on-client/src/actions/README.md](../on-client/src/actions/README.md)
- [on-client/src/ai/README.md](../on-client/src/ai/README.md)
- [on-client/src/vulnerabilities/README.md](../on-client/src/vulnerabilities/README.md)
- [on-client/student/HOST_OBSERVATION.md](../on-client/student/HOST_OBSERVATION.md)
- [package/ARCHITECTURE.md](../package/ARCHITECTURE.md)
- [package/DEMO.md](../package/DEMO.md)
- [package/POLICIES.md](../package/POLICIES.md)
- [package/README.md](../package/README.md)
- [package/SELF-CHECK.md](../package/SELF-CHECK.md)
- [package/THREAT-INTEL.md](../package/THREAT-INTEL.md)

## 수업 원본·출처 — 원문 보존

수업 제공 계약의 Git blob 해시를 `test/course-original-provenance.test.mjs`가 확인합니다. 이를 최신 구현처럼 다시 쓰거나 테스트를 약화시키지 않습니다. vendor NOTICE는 저작·재사용 조건이므로 삭제하지 않습니다. 원 계약과 학생 확장 범위는 구분합니다.

- [AGENTS.md](../AGENTS.md)
- [docs/DECIDER_REQUEST.md](DECIDER_REQUEST.md)
- [docs/DETECT_EVENTS.md](DETECT_EVENTS.md)
- [on-client/vendor/NOTICE.md](../on-client/vendor/NOTICE.md)
- [xdr/README.md](../xdr/README.md)

## 과거 제출·감사 증적 — 현재 안내로 사용하지 않음

이 자료의 당시 HEAD·PASS/NOT_RUN·배포 상태는 기록된 시점에만 적용됩니다. 현재 문서에서 주장하지 않는 동작이나 경로가 남아 있어도 증적을 고쳐 현재 사실처럼 만들지 않습니다. 실제 사용자 제출물과 파일은 삭제·이동하지 않습니다.

- [docs/AUTH_RECENT_COMMITS_AUDIT_2026-11-01.md](AUTH_RECENT_COMMITS_AUDIT_2026-11-01.md)
- [docs/IDENTITY_CONSISTENCY_2026-10-27.md](IDENTITY_CONSISTENCY_2026-10-27.md)
- [docs/IDENTITY_CONSISTENCY_2026-10-30.md](IDENTITY_CONSISTENCY_2026-10-30.md)
- [docs/QUALITY_AUDIT_2026-10-26.md](QUALITY_AUDIT_2026-10-26.md)
- [docs/STAGE12_CONTRACT_AUDIT.md](STAGE12_CONTRACT_AUDIT.md)
- [docs/STAGE12_CONTRACT_RESTORE.md](STAGE12_CONTRACT_RESTORE.md)
- [docs/STAGE12_EVIDENCE.md](STAGE12_EVIDENCE.md)
- [on-client/docs/OBSERVATORY_AUDIT_2026-10-30.md](../on-client/docs/OBSERVATORY_AUDIT_2026-10-30.md)
- [on-client/docs/STUDENT_RELEASE_RECORD.md](../on-client/docs/STUDENT_RELEASE_RECORD.md)

기존 README와 장문 프롬프트는 현행 진입 문서에서 제거하되, 과거 단계 기록을 잃지 않도록 원문 바이트를 별도 보존했습니다. **보존본의 명령·상대 링크는 당시 경로 기준이며 지금 실행 안내가 아닙니다.** 원 위치·원 blob은 문서 분류 JSON에 남깁니다.

- [이전 README 원문](history/README_BEFORE_2026-11-06.md)
- [이전 학생 프롬프트 원문](history/STUDENT_PROMPTS_BEFORE_2026-11-06.md)

`tmp.md`는 기존 빈 파일로 남깁니다. CURRICULUM·시작 틀 manifest·재현 JSON·원 함수 기준표·기존 설명 템플릿도 원자료로 보존하며 현행 기능과 자동 동기화된 자료로 주장하지 않습니다.

## 문서 유지 규칙

1. 현재 사용법에는 존재하는 파일·명령·경로만 적습니다. 포장/배포/원격 조회는 기본 실행에 섞지 않습니다.
2. 기능 추가·수정 시 해당 주제 안내와 한계를 같이 대조합니다. 계획을 완료 기능으로 적지 않습니다.
3. 버전·실행 결과는 package/같은 커밋의 CI·실제 관측 근거를 확인합니다. 과거 시험 횟수·성능 보장·모델 작업 메타정보를 현재 사실로 반복하지 않습니다.
4. 기존 원본·제출 증적의 해시를 바꾸어 현재 코드에 맞춘 것처럼 만들지 않습니다.
5. 커밋 시 `package/bundle-commit-files.json`은 해당 부모 대비 실제 변경 목록과 일치시킵니다. 이는 포장 명령이 아닙니다.

전체 분류는 [DOCUMENTATION_STATUS.json](DOCUMENTATION_STATUS.json)에 있습니다. 기존 Markdown 48개를 현행 33개, 보호 원문 5개, 과거 증적 9개, 빈 파일 1개로 구분했습니다. 현행 32개를 개정하고 상세 인증 쿠키 문서 1개는 유지했습니다.
