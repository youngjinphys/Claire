# 공개 npm 패키지와 OSV 대조

근거: [project-scan.mjs](project-scan.mjs), [osv.mjs](osv.mjs), [화면](../../public/vulnerabilities-view.mjs), [서버](../server.mjs). 현재 서버·UI 조회 경로가 있으므로 과거의 “서버·UI 통합 미구현” 설명은 적용하지 않습니다. 실제 원격 응답 여부는 별도 실행 증거입니다.

## 대상 선별

`ON_PROJECT_DIRECTORY`의 프로젝트와 `ON_APPROVED_PUBLIC_PACKAGES`의 공개 승인 목록을 서버에서 사용합니다. 기본 허용 목록은 빈 배열이며 승인되지 않은 패키지 이름을 공개 여부 확인 목적으로 외부에 보내지 않습니다.

package-lock v2/v3, 정확한 패키지 이름·버전·공식 registry tarball 정보와 설치 메타데이터를 확인합니다. 로컬 링크·workspace·비공개·file/git·범위 버전 등 조건을 만족하지 않는 항목은 제외하거나 확인 불가로 처리합니다. 같은 이름/버전은 중복을 제거하고 다른 버전은 구분합니다. 보호 상한은 256패키지입니다.

## 전송과 결과

승인한 npm 이름·정확 버전만 고정 OSV querybatch 경로로 전송합니다. 전체 lock, 내부 경로, 비공개 이름, 자격정보를 보내지 않습니다. 설치·업데이트·삭제·원격 코드 실행은 하지 않습니다.

| 결과 | 해석 |
|---|---|
| known_vulnerabilities | 끝까지 확인한 조회 범위에 알려진 항목 있음 |
| none_found | 끝까지 확인한 조회 범위에 알려진 항목 없음. 전체 안전 아님 |
| unverifiable | 완료 확인 불가. 이전 페이지에서 받은 발견은 보존 가능 |
| partial | 일부 패키지/페이지 조회 실패 |
| not_checked/not_configured | 대상·승인 또는 설정이 없어 미조회 |

다음 페이지 요청은 조회 연속 처리이며 실패의 자동 재시도가 아닙니다. 시간·페이지·응답 크기·반복 cursor·계약 불일치를 제한합니다. 먼저 끝난 패키지 결과를 이후 실패 때문에 성공인 것처럼 확장하거나 모두 삭제하지 않습니다.

## 확인

앱 폴더의 `npm test`는 fixture·주입 transport·로컬 HTTP와 실제 코드 계약을 검사합니다. `education/on-client`는 이 저장소의 경로가 아닙니다. 운영자 승인 없는 원격 조회를 문서 검증 명목으로 실행하지 않습니다. UI의 정확 버전·출처·조회 시각·lock 근거를 함께 확인합니다.

[실행 확인](../../docs/STUDENT_RUNBOOK.md) · [문제 해결](../../docs/CONNECTION_TROUBLESHOOT.md)
