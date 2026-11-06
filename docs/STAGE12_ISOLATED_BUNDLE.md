# 기존 단계의 격리 제출 도구 — 참고 전용

이 경로는 루트 방어전의 이전 제출 도구를 설명합니다. Claire 로컬 실행이나 현재 문서 작업의 필수 절차가 아니며 **포장 명령을 실행하지 않습니다**.

정본은 [bundle.mjs](../scripts/bundle.mjs), [변경 파일 선언](../package/bundle-commit-files.json), [원본 함수 기준](../package/baseline-functions.json), [단계별 API 목록](../package/stage-api-inventory.json)과 관련 시험입니다. 원 수업 기준표와 이후 학생 API 확장을 하나의 권한 목록으로 덮어쓰지 않습니다.

커밋 증적은 그 커밋의 부모 대비 실제 변경 경로와 일치해야 합니다. 문서만 수정해도 이 목록의 갱신이 필요할 수 있지만 목록 작성 자체가 ZIP 생성이나 제출을 뜻하지 않습니다. 기존 제출 JSON·자기 점검 결과를 새 소스의 결과로 재사용하지 않습니다.

`artifacts/submission.json`과 로컬 bundle-notes는 공개 커밋 대상이 아닙니다. 사용자 자료·키·토큰·원본 보고서를 제출 증거처럼 포함하지 않습니다. [STAGE12_EVIDENCE.md](STAGE12_EVIDENCE.md)와 [계약 복원 기록](STAGE12_CONTRACT_RESTORE.md)은 그 시점의 기록으로 보존합니다.

포장이 별도 승인된 미래 작업이 되면 그때의 HEAD·작업 트리·명령 구현·수업 기준을 다시 확인합니다. 예전 고정 SHA로 초기화하거나 기존 파일을 지우는 복구 절차를 제공하지 않습니다.
