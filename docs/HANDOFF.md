# 인계: rogallyx에서 pi-mailbox 관리

## 소유와 위치

- **저장소:** `https://github.com/zerodice0/pi-mailbox`(공개, MIT)이며, 기준 branch는 `main`입니다.
- **관리 주체:** **rogallyx**의 `~/workspace/development/pi-mailbox` 체크아웃과, 그 Herdr workspace에서 실행하는 pi 세션입니다. 이 세션이 저장소의 단일 조율자로서 이슈, branch, 병합, push를 맡습니다.
- **다른 호스트:** Mac Studio, macbook-pro, winmini는 사용자 입장에서만 씁니다. 각 호스트의 `~/workspace/development/pi-mailbox`는 `pi install`로 연결되어 있으며, 이 체크아웃에서는 `git pull`만 합니다. 직접 수정하지 않습니다.

## HAM과의 관계

- **HAM 쪽 지원:** HAM(`zerodice0/herdr-agent-messenger`)에 pi 수신기 지원이 있습니다. pi 등록(`client=pi`), 긴급 claim, schema 13의 `urgency`, `mail amend`/`mail cancel`, Mailbox Threads의 `u`/`c`가 그것입니다. HAM 백엔드는 이 기능을 사용합니다.
- **변경 순서:** HAM 프로토콜에 맞춰야 하는 변경은 HAM 저장소에 먼저 반영합니다. HAM은 모든 호스트를 함께 업그레이드해야 합니다.
- **HAM 없이 쓰는 경우:** HAM이 없거나 Herdr 밖이면 local 백엔드로 동작합니다(`PI_MAILBOX_BACKEND`로 강제할 수 있습니다).

## 배포 상태 (2026-11-25)

| 호스트 | pi-mailbox | HAM | Herdr pi 통합 |
|---|---|---|---|
| Mac Studio | `e408c47`(`git pull`, 테스트 통과) | `194be93`(GitHub 설치) | v9 |
| macbook-pro | `e408c47`(`git pull`, 테스트 통과) | `194be93`(`ham rollout`) | v9 |
| winmini | `e408c47`(`git pull`, 테스트 통과) | `194be93`(로컬 체크아웃) | v9 |
| rogallyx | `e408c47`(관리 체크아웃) | `194be93`(로컬 체크아웃) | v9 |
| winmax2 | 미설치(오프라인) | 미갱신 | 미확인 |

- pi-mailbox 표의 commit은 각 호스트 체크아웃의 `HEAD`입니다. 관리 체크아웃에서 push한 뒤 다른 호스트에서 `git pull --ff-only`로 맞춥니다.
- 모든 갱신 호스트의 HAM ledger는 schema 13입니다. HAM skill 사본도 갱신했습니다.
- GitHub 설치는 갱신할 때마다 plugin root 경로가 바뀝니다. 그래서 rogallyx와 winmini의 peer 등록(`ledger peer add --ssh-alias s-mac-studio|macbook-pro`)을 다시 했습니다. HAM을 다시 갱신할 때도 같은 작업이 필요합니다.
- 실행 중이던 pi 세션은 `/reload`를 실행하거나 다시 시작해야 확장이 적용됩니다. 사용자가 고른 세션만 다시 시작합니다.

## 실제 환경 검증 (Mac Studio, HAM 백엔드)

Herdr에 일회용 pi 세션을 띄우고 사용자 자격으로 메일을 보내 확인했습니다.

- **수신기 등록:** 세션이 `client=pi`, `extension_present=1`로 등록되었습니다.
- **idle 자동 처리:** idle 상태의 세션이 action 메일을 자동으로 처리했습니다. 기록은 `via=wake`, `delivered`이고, 근거는 `pi:accepted-journal:…`입니다.
- **cancel:** 실행 중이던 `sleep 90`이 `Command aborted`로 중단되었습니다. 이어서 cancel이 `via=urgent`로 주입되었고 보고 턴이 시작되었습니다.
- **발견한 문제:** 사용자(`user@HOST`)에게는 메일 주소가 없어서, 에이전트가 메일로 보고할 수 없었습니다. HAM `194be93`과 local 백엔드 모두, 사용자에게 보내는 보고는 응답으로 하도록 지침을 고쳤습니다.
- **미검증 항목:** local 백엔드는 실제 모델로 아직 검증하지 않았습니다(단위 테스트와 e2e 테스트만 있습니다).

## 실제 환경 검증 (rogallyx, Linux, HAM 백엔드, 2026-11-25)

일회용 pi 세션(`claude-haiku-5-5`)을 Herdr workspace에 띄우고, 관리 세션이 에이전트 자격으로 메일을 보내 확인했습니다. 시험 세션과 작업 디렉터리는 정리했습니다.

- **수신기 등록:** `client=pi`, `extension_present=1`로 등록되었습니다. auto 선택은 `ham`이었습니다.
- **idle 자동 처리:** `via=wake`, `delivered`로 기록되었고, 근거는 `pi:accepted-journal:…`입니다. 송신부터 전달까지 약 2.5분 걸렸습니다(입력 정지와 coalesce 대기).
- **amend:** 실행 중인 run에 steer로 주입되었습니다(`via=urgent`). 세션 기록에서 tool result 바로 다음, 같은 run 안에 들어갔고, 에이전트가 보강 내용을 반영했습니다.
- **cancel:** `sleep 120` 도중에 cancel을 보내자 명령이 중단되었습니다. 다음 단계는 실행되지 않았고, 에이전트가 응답으로 보고했습니다.
- **메일함 패널과 카드:** `alt+m`, `ctrl+shift+m`(CSI u), `/mail`로 열고 닫았습니다. 사용 한도 패널, pi-team 패널과 함께 띄워 오른쪽에 쌓이는 모습을 확인했습니다. 패널을 연 채로 메일을 보내고 회수했을 때 바로 반영되었습니다. 전달된 메일은 대화 기록에 `✉ mail` 카드로 표시되었습니다. 마우스 끌기는 SGR 입력을 직접 넣어서만 확인했습니다.

## 남은 작업

1. **winmax2:** 온라인이 되면 HAM을 갱신하고(같은 commit), pi-mailbox를 설치합니다. 그 전까지 winmax2는 긴급 메시지(`urgency`가 있는 payload)를 `invalid_message`로 거부합니다.
2. **실제 세션 검증:** local 백엔드를 실제 모델로 검증합니다. HAM 백엔드는 macOS와 Linux에서 모두 검증했습니다.
3. **local 백엔드 운영 확인:** 여러 세션이 동시에 쓸 때의 잠금 대기 시간과 `fs.watch` 동작을 확인합니다.
4. **HAM skill 문서:** HAM skill이 pi 메일함 overlay를 `/ham-mailbox`라고 적고 있습니다. 실제 명령은 `/mail`(`alt+m`, `ctrl+shift+m`)이므로 HAM 저장소에서 고쳐야 합니다.

## 지켜야 할 계약

- 외부에서 pi에 메시지를 밀어넣거나 턴을 시작하지 않습니다. bell은 알림 역할만 합니다.
- 메일을 읽는 것만으로 ACK하지 않습니다. 세션 기록에서 정확히 일치하는 항목을 확인했을 때만 전달 완료로 기록합니다.
- 불확실한 전달은 다시 주입하지 않습니다(`/mail recover` 또는 HAM 운영자 복구를 씁니다).
- 시험 산출물과 작업 파일은 `/tmp`에 두지 않습니다. 시험용으로 띄운 pi 세션은 직접 정리합니다.
