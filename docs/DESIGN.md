# pi-mailbox 설계

## 1. 목표

- pi 세션에 도착한 메일은 메일함에 쌓아 두고, 세션이 idle 상태가 되면 큐처럼 처리합니다.
- 긴급 메시지를 두 단계로 나눕니다. amend(보강)는 steer로 처리하고, cancel(취소)은 abort한 뒤 송신자에게 보고하게 합니다.
- 외부에서 pi에 프롬프트를 입력하거나 턴을 시작하지 않습니다. 처리 시점은 세션 안의 확장이 결정합니다.
- HAM이 있으면 HAM을 중앙 관제로 쓰고, HAM이 없어도 같은 동작을 제공합니다.

## 2. 구성

| 파일 | 역할 |
|---|---|
| `src/core.ts` | `PiMailbox`: idle, 초안, 입력 정지 판정, 긴급 처리(steer/abort), 주입, 세션 기록 기반 ACK, 상태 표시줄 |
| `src/board.ts` | 메일함 패널: 입력을 가로채지 않는 overlay, 실시간 상태 표시, 마우스 선택과 끌기(보기 전용) |
| `src/card.ts` | 전달된 묶음(`ham_mailbox`)을 대화 기록에 카드로 그리는 renderer |
| `src/palette.ts` | quota/pi-team 패널과 같은 titanium 팔레트와 틀 그리기 도구 |
| `src/types.ts` | 수신기 프로토콜 타입(HAM `ledger runtime` protocol 1과 같음) |
| `src/ham.ts` | HAM 백엔드: `python3 -m ham cli ledger runtime ...` 호출과 응답 검증 |
| `src/local.ts` | local 백엔드: 같은 프로토콜을 구현하는 파일 메일함, 송신(`send`, `urgent`, `handle`, `recover`) |
| `index.ts` | 백엔드 선택, pi 이벤트 연결, `/mail`, `alt+m`/`ctrl+shift+m`, local 전용 `mailbox_*` 도구 |

`PiMailbox`는 백엔드와 다섯 가지 동작(`register`, `inspect`, `claim`, `applied`, `release`)으로만 통신합니다. 따라서 두 백엔드에서 큐 처리 동작이 같습니다.

## 3. 백엔드 선택

`PI_MAILBOX_BACKEND`의 기본값은 `auto`입니다. Herdr 환경 변수가 있고 HAM 플러그인 root를 찾을 수 있으면 `ham`을, 그렇지 않으면 `local`을 고릅니다. 선택은 확장을 불러올 때 한 번 하며, 이후 세션 도중에 바꾸지 않습니다. 중간에 바꾸면 메일 원본이 두 곳으로 나뉘기 때문입니다.

pi-subagents의 자식 프로세스(`PI_SUBAGENT_CHILD`)에서는 아무것도 등록하지 않습니다. 메일 수신은 TUI 모드의 세션에서만 합니다.

## 4. 처리 규칙

- **일반 메일:**
  - pi가 idle 상태이고, pi 내부 큐가 비어 있고, 확장 대화상자가 닫혀 있어야 합니다.
  - editor가 비어 있고, `idle_minutes` 동안 입력이 없어야 합니다.
  - 백엔드의 wake 조건(역할, coalesce, 시간당 횟수, hop)을 통과해야 합니다.
  - 조건을 모두 만족하면 묶음 하나를 `followUp`과 `triggerTurn`으로 주입합니다.
  - 사용자가 프롬프트를 제출할 때도 대기 중인 메일을 함께 붙입니다(`before_agent_start`).
- **cancel:** 현재 run이 원본 thread를 처리하고 있으면, editor에 초안이 있어도 `ctx.abort()`를 호출합니다. 초안은 지우지 않고 그대로 둡니다. 현재 run이 처리 중인 thread는 이 확장이 그 run에 주입한 메일의 thread로 판단합니다. `agent_settled` 이후 cancel을 claim하고, 보고 턴을 시작합니다. 다른 작업 중에 도착한 cancel은 idle 상태에서 가장 먼저 처리합니다.
- **amend:** 현재 run이 원본 thread를 처리하고 있고 editor가 비어 있으면, 그 amend만 claim해서 `steer`로 주입합니다. 그 밖의 경우에는 editor가 비어 있는 idle 상태에서 가장 먼저 처리합니다.
- **긴급 claim:** turn state, coalesce, 시간당 횟수는 건너뛰고 hop 제한은 지킵니다. 원본이 아직 대기 중이면 원본도 함께 claim합니다.
- **ACK:** 세션 기록에서 `ham_mailbox` custom message의 marker, details, sha256이 정확히 일치하는 항목을 찾았을 때만 `applied`를 보고합니다. idle 상태가 되었는데도 기록에 없고 pi 큐에도 없으면, 3초가 지난 뒤 `not_applied`로 되돌립니다. 그 밖의 불확실한 경우는 `unknown`으로 남기고, 다시 주입하지 않습니다.

## 4-2. 진단(`/mail why`)

- 자동 처리 경로가 확인하는 조건을 `wakeBlockers()` 하나로 모았습니다. 자동 처리와 `/mail why`가 같은 목록을 쓰므로 설명과 실제 동작이 어긋나지 않습니다.
- 확인 순서는 세션 상태(턴 실행, 확장 대화상자, 프롬프트 준비, pi 대기열), 처리 중인 묶음, 깨울 메일 유무, HAM 역할, editor 초안과 입력 정지, HAM이 보고한 turn 상태, 시간당 횟수, 묶음 대기입니다.
- pi는 idle인데 수신기의 "턴 실행 중" 표시가 남아 있으면 따로 알립니다(`agent_settled`를 놓친 경우).
- 마지막으로 자동 처리를 건너뛴 이유와 그 이유가 유지된 시간을 메모리에 둡니다. 메모리 값은 메일이 전달되면 덮어써지므로, 사후 분석은 아래 수신 기록 파일로 합니다. `/mail why`는 `inspect`만 호출하며 claim이나 ACK를 하지 않습니다.

### 수신 기록 파일(trace)

- 수신기의 메모리 상태는 메일이 전달되면 덮어써지므로, "왜 두 시간 동안 처리되지 않았는가"는 사후에 `/mail why`로 답할 수 없습니다. 그래서 미룬 이유와 전달 결과를 파일에 남깁니다.
- 위치는 `<mailbox root>/trace/<세션 파일 이름>.jsonl`입니다(기본 `~/.pi/agent/mailbox/trace/`, HAM 백엔드도 같습니다). 한 줄이 JSON 하나입니다.
- 기록하는 사건:
  - `wait`: 메일이 대기 중이고 미루는 이유(`key`)가 바뀔 때 한 번 남깁니다. 같은 이유가 10분(`TRACE_HEARTBEAT_MS`) 넘게 이어지면 `still`을 남겨, 얼마나 오래 이어졌고 그동안 입력이 계속 들어왔는지 알 수 있게 합니다.
  - `claimed`, `sent`(`turn`/`steer`/`prompt`), `applied`, `released`, `empty`: 메일이 어떤 경로로 전달되고 확인됐는지 남깁니다.
  - `declined:<reason>`: 백엔드가 wake claim을 거절한 이유입니다.
  - `start`, `registered`, `stop`, `recovered`, `error`.
- `wait`/`still`에는 조건 값도 함께 남깁니다: 대기 수, pi idle 여부, 대화상자 수, pi 대기열, editor 글자 수, 마지막 입력 뒤 지난 초, 직전 줄 이후 입력 횟수와 마지막 입력의 종류.
- 메일 본문, 프롬프트, 입력한 글자는 남기지 않습니다. 입력 종류는 `text`, `control`, `paste`, `csi-u`처럼 모양만 남기고, 키가 아닌 단일 escape sequence만 원문으로 남깁니다(터미널 응답이 입력으로 잘못 세지는 경우를 찾기 위해서입니다).
- 파일은 256KB를 넘으면 최근 절반만 남기고, 14일 동안 쓰이지 않은 다른 세션의 파일은 수신기가 시작할 때 지웁니다. 기록 실패는 메일 처리에 영향을 주지 않습니다.
- `/mail why`는 최근 8줄과 파일 경로를 함께 보여 줍니다.

### 새 메일 감지와 타이핑

- 새 메일은 doorbell로 감지합니다. 백엔드가 메일 상태를 바꾸면 bell 파일을 건드리고, 수신기는 `fs.watch`로 받아 250ms 뒤 확인합니다. bell을 놓친 경우에 대비해 5분마다 한 번 확인합니다.
- 확인 결과 미뤄야 하면, 조건이 풀릴 수 있는 시각(마지막 입력 3분 뒤, 묶음 대기 종료 등)에 맞춰 타이머를 하나 겁니다.
- 그래서 타이핑은 확인을 일으키지 않습니다. 이전에는 키 입력마다 1초 뒤 확인을 예약해, 입력하는 동안 1초마다 백엔드 프로세스를 띄웠습니다.
- 예외는 긴급 메일이 대기 중일 때입니다. amend는 editor가 비어야 전달되므로, editor가 바뀔 때 1초 뒤 다시 확인합니다.

### pi의 idle 확인으로 깨우기(`pi_observed_idle`)

- HAM `dc42031` 이후 `inspect` 응답의 `capabilities`에 `pi_observed_idle`이 있으면, wake claim에 `observed_idle: true`와 `observed_at`(epoch 초)을 함께 보냅니다. HAM은 60초 이내의 확인이면 Herdr turn 상태 조건만 건너뛰고, 역할·시간당 횟수·묶음 대기·hop 조건은 그대로 확인합니다.
- 이때 pi-mailbox도 HAM turn 상태 사전 검사를 하지 않습니다. pi의 idle 판단은 세션 안의 조건(턴 실행, 대화상자, pi 대기열, editor, 입력 정지)으로만 합니다.
- 확인이 오래되어 HAM이 `observed_stale`로 거절하면 turn 상태로 대신 판정하지 않고 1초 뒤 다시 시도합니다.
- capability가 없는 옛 HAM과 local 백엔드에는 필드를 보내지 않습니다. 옛 HAM은 모르는 필드를 `invalid_request`로 거절하기 때문입니다.
- `/mail why`의 `Idle evidence:` 줄에 어느 근거를 쓰는지와 마지막 wake의 `idle_source`가 보입니다.

### 멈춘 상태 복구와 입력 판정

- pi는 select/confirm/input/editor 대화상자와 모든 `ctx.ui.custom()`을 같은 `ui_prompt_start`/`ui_prompt_end`로 알리며, 중첩 깊이가 0에서 바뀔 때만 보냅니다. 메일함, 쿼터, pi-team 패널은 몇 시간씩 열려 있는 `custom` overlay라서, 이를 대화상자로 세면 패널이 떠 있는 동안 자동 처리가 멈춥니다. 그래서 `custom`은 대화상자로 세지 않습니다. 사용자가 modal custom 화면에 입력하는 동안은 입력 정지 조건이 막습니다.
- editor가 프롬프트를 제출하면 modal 대화상자가 열려 있을 수 없으므로, 남은 대화상자 카운터를 0으로 되돌립니다.
- pi가 idle이고 pi 대기열도 빈 상태로 60초(`STALE_TURN_MS`) 넘게 "턴 실행 중" 표시가 남으면, `agent_settled`를 놓친 것으로 보고 표시를 풉니다.
- 입력 정지 시간은 타이핑과 붙여넣기만 초기화합니다. 마우스, focus 보고, 커서 위치·장치 속성·kitty 키보드 응답, OSC·DCS 응답은 입력으로 세지 않습니다(`isTyping`).
- 스스로 푼 상태는 `/mail why`의 `Recovered:` 줄에 보입니다.
- `/mail`, `/mail board`, 단축키는 패널을 기다리지 않습니다. 기다리면 패널이 닫힐 때까지 pi의 slash 명령 대기열이 막힙니다.

## 4-1. 메일함 패널과 메일 카드

- **패널:** `/mail`, `alt+m`, `ctrl+shift+m`으로 열고 닫습니다(`/mail board on|off|reset`).
  - 사용 한도(quota) 패널, pi-team 패널과 같은 titanium 팔레트, 틀, 폭(50칸)을 씁니다. 세 패널이 화면 오른쪽에 한 줄로 쌓이도록, 메일함은 오른쪽 아래 editor 위(`bottom-right`, 아래 6줄 비움)에 둡니다.
  - `nonCapturing` overlay이므로 열려 있어도 editor 입력을 가로채지 않습니다.
  - 렌더링할 때마다 `PiMailbox.state`를 읽고, 상태가 바뀌면 다시 그립니다. 열 때 `inspect`를 한 번 비동기로 호출하고, 경과 시간을 갱신하려고 30초마다 다시 그립니다. 수신기가 실패하는 동안에는 오래된 목록 대신 오류를 보여 줍니다.
  - 목록은 처리 순서(cancel, amend, action, FYI, 같은 종류 안에서는 오래된 순)로 정렬합니다. 고른 메일의 상세를 아래에 보여 줍니다.
  - 위치는 anchor 기준의 offset이며 `board.json`(local 메일함 root)에 저장합니다. 제목 줄 끌기는 fullscreen 모드의 마우스 capture로 처리합니다.
  - 보기 전용입니다. 열거나 고르는 것만으로 ACK하지 않습니다.
- **카드:** `pi.registerMessageRenderer("ham_mailbox")`로 전달된 묶음을 카드로 그립니다. 에이전트가 받는 content는 바꾸지 않으므로 ACK(marker와 sha256 비교)에 영향이 없습니다. 카드에는 처리 지침과 marker를 숨기고 종류, 송신자, 본문만 보여 줍니다. 펼치면(`app.tools.expand`) 전체 content를 보여 줍니다. HAM과 local 묶음 형식을 모두 해석하며, 해석할 수 없으면 pi 기본 표시로 돌아갑니다.

## 5. local 백엔드 저장 구조

| 경로(`~/.pi/agent/mailbox/` 아래) | 내용 |
|---|---|
| `agents/<agent_id>.json` | pi 세션 ID를 agent ID로 씁니다. alias(세션 이름 또는 cwd 이름), pid, generation을 기록합니다. |
| `messages/<message_id>.json` | 변하지 않는 내용과 전달 상태(queued, delivering, delivered, handled, withdrawn) |
| `claims/<claim_id>.json` | marker, hash, 포함된 메시지 목록 |
| `bell/<agent_id>` | 새 메일 알림(턴을 시작하지 않음) |
| `lock/` | 모든 변경을 직렬화하는 mkdir 잠금. 소유 프로세스가 죽었거나 15초가 지난 잠금은 회수합니다. |

모든 쓰기는 임시 파일에 쓴 뒤 rename합니다. 종료 상태의 메시지와 claim은 30일 뒤 지웁니다.

## 6. 권한

- **HAM 백엔드:** HAM 규칙을 따릅니다. 사용자와 main 에이전트만 보낼 수 있고, 자신이 보낸 메일만 대상으로 할 수 있습니다.
- **local 백엔드:** 역할이 없습니다. 사용자(`/mail`)와 에이전트 모두 자신이 보낸 메일만 amend하거나 cancel할 수 있습니다. 사용자가 보낸 메일은 같은 호스트의 어느 세션에서든 `/mail`로 고칠 수 있습니다.

## 7. 범위에서 제외한 항목

- local 백엔드의 호스트 간 전송(호스트 간 전송이 필요하면 HAM을 씁니다)
- HAM 백엔드 세션과 local 백엔드 세션 사이의 메일 교환
- 세션 이름 동기화
