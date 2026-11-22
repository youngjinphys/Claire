# 배포 정합성 확인 — 별도 운영 절차

파일명은 과거 링크 호환을 위해 유지합니다. 과거 시점의 BLOCKED/READY·공개 alias·배포 SHA 관측은 [2026-10-30 증적](IDENTITY_CONSISTENCY_2026-10-30.md)에 있으며 현재 상태로 단정하지 않습니다.

현재 근거는 [설정](../aleph.config.json), [빌드](../scripts/build-public.mjs), [배포 증거 검증](../src/deployment-evidence.mjs), [live 확인 도구](../scripts/verify-live-identity.mjs)입니다. 설정된 저장소 URL, 공개 앱 URL, Git SHA, 정책 식별자는 각각 비교 대상이지 단독 성공 증거가 아닙니다.

Claire의 `on-client` 로컬 실행에는 Vercel이 필요하지 않습니다. 문서 작업은 배포 생성·승격·설정 변경·DB 적용을 수행하지 않습니다. 공개 서비스 현재 상태를 확인하지 않았다면 미확인으로 기록합니다.

운영자가 별도로 배포 검증을 승인한 경우에만 `identity:live` 도구의 실제 대상과 요청 범위를 먼저 확인합니다. 이것은 외부 GET을 포함하므로 오프라인 문서/구문 검사와 구분합니다. 성공한 CI와 정적 manifest만으로 공개 alias가 같은 소스를 제공한다고 판단하지 않습니다.

불일치 시 현재 소스 SHA, 관측 시각, 실제 응답의 안전한 식별값, 실패 코드를 기록합니다. 비밀 설정을 복사하거나 프로젝트를 새로 배포하는 방식으로 증거를 숨기지 않습니다. [전체 문서 구분](README.md)을 참조하세요.

## 공개 배포 중지 후 검증 정책 (2026-11-22)

GitHub Actions `.github/workflows/production-identity.yml`의 매일 예약 실행은 **중지**했습니다. 사용자가 공개 Vercel 배포를 중단한 상태에서 정기적으로 동일 SHA를 요구하면 `PUBLIC_MANIFEST_UNAVAILABLE` 또는 불일치가 반복되지만, 이는 로컬 Claire의 코드 품질이나 사용자 PC 측정 결과를 증명하지 않습니다. 중단 이유를 임의로 정상화하거나 과거 실패 기록을 지우지 않습니다.

이 검사는 **Actions → Public deployment identity drift → Run workflow**에서 운영자가 명시적으로 실행할 때만 수행합니다. 검사 대상은 `aleph.config.json`의 공개 Vercel alias `/aleph.json`을 대상으로 하는 인증 없는 읽기 전용 GET 한 건이며, 해당 alias가 사용 가능하고 정확한 main SHA를 제공해야만 성공합니다. 중단 중 수행하면 실패해도 그 결과를 유지합니다. 정상 배포를 공식적으로 재개하고 alias의 현재 식별자 검증을 완료하기 전에는 예약 실행을 다시 켜지 않습니다.

루트 `Quality checks`는 별개입니다. 모든 push/PR에 대해 Linux·Windows 로컬 회귀검사를 수행하며, `[readonly-audit]` 표시는 전체 검증을 건너뛰는 면제 사유가 아닙니다. 해당 표시는 허용 파일 범위를 추가로 검사하는 크로스플랫폼 감사 매트릭스만 활성화합니다. 프로젝트 폴더의 일반 권한 로컬 실행(`cd on-client; npm run check; npm test; npm start`)에는 Vercel이 필요하지 않습니다.
