# 기존 작업을 보존하는 업데이트

현재 저장소의 `on-client/tools/`에는 `install.mjs`와 `student-update.mjs`가 없습니다. 예전 문서에 있던 이 명령을 현재 실행 절차로 사용하지 않습니다. 설치 프로그램·포장 도구를 새로 만드는 작업도 아닙니다.

## 현재 저장소를 업데이트할 때

```sh
# 저장소 루트; 작업 파일을 바꾸지 않는 확인
git status --short
git branch --show-current
git rev-parse HEAD
git fetch origin main
git log --oneline --left-right HEAD...origin/main
```

미커밋·미추적 작업과 개인 커밋을 먼저 확인합니다. 작업 트리가 깨끗하고 로컬 main이 origin/main의 조상일 때만 fast-forward 갱신을 검토합니다. 이력이 통합되어 갈라졌거나 다른 작업이 있으면 그대로 멈추고 차이를 비교합니다. 특정 과거 SHA를 전제로 한 rebase 명령을 모든 PC에 복사하지 않습니다.

`reset --hard`, `clean`, 자동 stash, 폴더 삭제·이동으로 충돌을 숨기지 않습니다. 학생 파일과 이전 제출물은 유지합니다. 실제로 변경한 파일의 검증을 마친 뒤 같은 `on-client`에서 [실행 순서](STUDENT_LAUNCH_GUIDE.md)를 확인합니다.

## 별도 수업 배포본

운영자가 별도 배포본/업데이트 도구를 제공하면 해당 배포본의 버전·출처·보존 정책을 먼저 확인합니다. 현재 저장소에 그 도구가 존재하거나 동작한다고 가정하지 않습니다.

`.on-starter-manifest.json`은 이전 제공본의 기준 자료입니다. 현재 수정된 파일을 원본처럼 보이게 하려고 해시를 다시 써서는 안 됩니다. [수업 원본과 과거 증적의 분류](../../docs/README.md)를 따릅니다.
