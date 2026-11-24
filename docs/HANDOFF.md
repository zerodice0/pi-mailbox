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
| Mac Studio | 설치 | 갱신 | v9 |
| macbook-pro | 설치 | 갱신 | v9 |
| winmini | 설치 | 갱신 | v9 |
| rogallyx | 설치(관리 체크아웃) | 갱신 | v9 |
| winmax2 | 미설치(오프라인) | 미갱신 | 미확인 |

실행 중인 pi 세션은 `/reload`를 실행하거나 다시 시작해야 확장이 적용됩니다. 사용자가 고른 세션만 다시 시작합니다.

## 남은 작업

1. **winmax2:** 온라인이 되면 HAM을 갱신하고(같은 commit), pi-mailbox를 설치합니다. 그 전까지 winmax2는 긴급 메시지(`urgency`가 있는 payload)를 `invalid_message`로 거부합니다.
2. **실제 세션 검증:** 실제 모델로 idle 처리, amend의 steer, cancel의 abort와 보고 턴을 검증합니다. Linux(rogallyx)와 macOS에서 모두 확인합니다.
3. **local 백엔드 운영 확인:** 여러 세션이 동시에 쓸 때의 잠금 대기 시간과 `fs.watch` 동작을 확인합니다.

## 지켜야 할 계약

- 외부에서 pi에 메시지를 밀어넣거나 턴을 시작하지 않습니다. bell은 알림 역할만 합니다.
- 메일을 읽는 것만으로 ACK하지 않습니다. 세션 기록에서 정확히 일치하는 항목을 확인했을 때만 전달 완료로 기록합니다.
- 불확실한 전달은 다시 주입하지 않습니다(`/mail recover` 또는 HAM 운영자 복구를 씁니다).
- 시험 산출물과 작업 파일은 `/tmp`에 두지 않습니다. 시험용으로 띄운 pi 세션은 직접 정리합니다.
