# pi-mailbox

`pi-mailbox`는 [pi](https://pi.dev) 1.6+ 확장입니다. pi 세션에 도착한 메일을 메일함에 쌓아 두었다가, 세션이 idle 상태가 되면 큐처럼 하나씩 처리합니다. 긴급한 경우에는 진행 중인 작업에 내용을 보강하거나(amend), 작업을 중단시키고 보고를 받을 수 있습니다(cancel).

외부에서 pi에 프롬프트를 입력하거나 턴을 시작하지 않습니다. 언제 메일을 처리할지는 각 pi 세션 안의 확장이 결정합니다.

## 동작 방식

| 종류 | 처리 시점 |
|---|---|
| 일반 메일 | pi가 idle 상태이고, editor가 비어 있고, 입력이 일정 시간 없을 때 한 묶음씩 처리합니다. |
| amend(보강) | 에이전트가 원본 메일의 thread를 처리하는 중이면 steer로 현재 작업에 반영합니다. 그렇지 않으면 idle 상태에서 가장 먼저 처리합니다. editor에 초안이 있으면 기다립니다. |
| cancel(취소) | 원본이 아직 대기 중이면 회수만 하고 아무것도 전달하지 않습니다. 에이전트가 그 thread를 처리하는 중이면 초안이 있어도 작업을 중단(abort)합니다. 이어서 지금까지 한 일을 송신자에게 보고하는 턴을 시작합니다. |

- amend와 cancel은 자신이 보낸 메일에만 쓸 수 있습니다.
- 메일함을 보는 것만으로는 메일이 처리된 것으로 기록되지 않습니다. 세션 기록에 메일 내용이 들어간 것을 확인한 뒤에만 전달 완료로 기록합니다.

## 백엔드

`PI_MAILBOX_BACKEND`(`auto`, `ham`, `local`)로 고르며, 기본값은 `auto`입니다.

- **HAM:** Herdr 안에서 [HAM](https://github.com/zerodice0/herdr-agent-messenger) 플러그인을 찾으면 HAM ledger를 사용합니다.
  - repo와 호스트를 넘나드는 주소 지정, 역할, hop과 시간당 횟수 제한을 HAM이 담당합니다.
  - 에이전트는 HAM skill CLI(`mail send`, `mail amend`, `mail cancel`)를 씁니다.
  - 사용자는 HAM Mailbox의 Threads에서 `u`(amend)와 `c`(cancel)를 씁니다.
  - pi 세션 식별에 Herdr pi 통합(`herdr integration install pi`)이 필요합니다.
- **local:** 그 밖의 경우에는 같은 호스트에 있는 pi 세션끼리 파일 메일함(`~/.pi/agent/mailbox`, 변경은 `PI_MAILBOX_DIR`)을 공유합니다.
  - HAM이나 Herdr가 없어도 동작합니다.
  - 에이전트는 `mailbox_send`, `mailbox_list`, `mailbox_handle`, `mailbox_agents`, `mailbox_amend`, `mailbox_cancel` 도구를 씁니다.
  - 사용자는 `/mail` 명령을 씁니다.
  - 호스트 간 전송, 역할, 권한 구분은 없습니다. 자신이 보낸 메일만 고칠 수 있다는 규칙과 hop, 시간당 횟수 제한은 그대로 적용됩니다.

한 호스트 안에서도 HAM 백엔드를 쓰는 세션과 local 백엔드를 쓰는 세션끼리는 메일을 주고받지 못합니다.

## 설치

```sh
git clone https://github.com/zerodice0/pi-mailbox ~/workspace/development/pi-mailbox
pi install ~/workspace/development/pi-mailbox
```

설치한 뒤에는 실행 중인 pi 세션에서 `/reload`를 실행하거나 세션을 다시 시작해야 적용됩니다.

## 사용법

| 명령 | 설명 |
|---|---|
| `/mail`, `alt+m` | 이 세션의 메일함 overlay를 엽니다. 보기만 하며 처리로 기록하지 않습니다. |
| `/mail agents` | 메일을 보낼 수 있는 pi 세션을 보여 줍니다. |
| `/mail send <대상> [--fyi] <내용>` | 사용자로서 메일을 보냅니다. |
| `/mail reply <ID> <내용>` | 받은 메일에 답장합니다. |
| `/mail sent` | `/mail`로 보낸 메일을 보여 줍니다. |
| `/mail amend <ID> <내용>` | 자신이 보낸 메일을 긴급 보강합니다. |
| `/mail cancel <ID> [사유]` | 자신이 보낸 메일을 취소합니다. |
| `/mail recover <ID> applied\|requeue` | 전달 여부가 불확실한 메일을 정리합니다. |

`<ID>`에는 목록에 보이는 앞 8자리처럼, 6자 이상의 접두어를 써도 됩니다. `/mail send`, `/mail reply`, `/mail amend`, `/mail cancel`, `/mail recover`는 local 백엔드에서만 동작하며, HAM 백엔드에서는 HAM Mailbox를 씁니다.

상태 표시줄의 `mail ✉ 3 !1 …`은 대기 중인 메일 수, 긴급 메일 수, 처리 중인 묶음을 뜻합니다. HAM 백엔드에서는 `HAM ✉ 3 !1 …`처럼 앞에 `HAM`이 표시됩니다.

## 설정(local)

`~/.pi/agent/mailbox/config.json`에서 처리 조건을 바꿀 수 있습니다.

```json
{ "idle_minutes": 1, "coalesce_seconds": 10, "wakes_per_hour": 12, "max_hop": 10 }
```

- `idle_minutes`: 마지막 입력 이후 기다리는 시간(분)입니다.
- `coalesce_seconds`: 새 메일을 모아서 처리하기 위해 기다리는 시간(초)입니다.
- `wakes_per_hour`: idle 상태에서 자동으로 시작하는 턴의 시간당 최대 횟수입니다. 에이전트끼리 답장을 무한히 주고받는 것을 막습니다.
- `max_hop`: 답장이 이어질 수 있는 최대 횟수입니다.

FYI 메일은 따로 600초를 모았다가 처리합니다.

## 개발

```sh
bun test ./tests
```

설계는 [`docs/DESIGN.md`](docs/DESIGN.md)에, 관리 방식은 [`docs/HANDOFF.md`](docs/HANDOFF.md)에 있습니다.

## 라이선스

MIT
