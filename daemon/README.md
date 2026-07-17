# llmwiki 캡처 데몬

복리 사이클의 **캡처(write) 고리**. `src/daemon/watch.ts` 가 모든 Claude 프로필의 transcript
디렉터리(`~/.claude*/projects/**/*.jsonl`)를 감시하다가, 새 세션이 끝나면 그 "업데이트 대기
(pending update)"를 중앙 캡처 큐(`<clone>/.state/capture.db`)에 기록한다. **LLM은 호출하지
않는다** — 단지 대기 목록만 적는다. 실제 업데이트는 `/wiki-fast` 로 한다.

어느 터미널(기본/tmux/iTerm2)·폴더에서 작업하든 transcript는 이 경로로 떨어지므로, 클라이언트별
훅 없이도 캡처가 된다. 50줄 미만의 짧은 Q&A 세션은 작업량 신호로 보아 건너뛴다(`src/daemon/watch.ts`).

> **주의**: `~`(홈) 에서 시작한 세션은 프로젝트가 특정되지 않아 per-project 누적이 안 된다.
> 누적을 원하면 **그 프로젝트 폴더 안에서** 세션을 시작하라.

`./setup.sh` 가 OS를 감지해 아래 중 하나로 자동 설치한다. 수동으로는
`bash <clone>/daemon/install.sh` / 제거는 `--uninstall`.

---

## macOS — launchd

`install.sh` 가 `~/Library/LaunchAgents/com.llmwiki.daemon.plist` 를 생성하고
`launchctl load` 한다. 해석된 `bun` 절대경로를 plist에 박아넣어 launchd의 최소 PATH
문제를 피한다.

```bash
launchctl list | grep llmwiki          # 상태
tail -f <clone>/.state/daemon.log      # 로그
bash <clone>/daemon/install.sh --uninstall
```

## Linux (systemd) — `systemd --user` 서비스

`install.sh` 가 `~/.config/systemd/user/llmwiki-daemon.service` 를 생성하고
`systemctl --user enable --now` 한다.

```bash
systemctl --user status llmwiki-daemon.service
journalctl --user -u llmwiki-daemon.service -f   # 또는 tail -f <clone>/.state/daemon.log
bash <clone>/daemon/install.sh --uninstall
```

**헤드리스 지속성**: 로그인 세션이 없을 때도 캡처를 유지하려면 한 번 실행:

```bash
loginctl enable-linger "$USER"
```

## Linux (systemd 없음, 예: WSL·미니 컨테이너) — cron + nohup

`systemctl` 이 없으면 `install.sh` 가 `crontab` 에 `@reboot` 라인을 등록하고, 지금 부팅에서도
캡처가 시작되도록 즉시 `nohup bun <clone>/src/daemon/watch.ts &` 로 백그라운드 실행한다.

```bash
pgrep -af watch.ts                     # 실행 확인
crontab -l | grep llmwiki              # @reboot 라인 확인
tail -f <clone>/.state/daemon.log      # 로그
bash <clone>/daemon/install.sh --uninstall
```

`systemctl` 도 `crontab` 도 없으면, 자동 재시작 없이 1회 실행만 된다. 부팅마다 `install.sh` 를
다시 돌리거나, 직접 프로세스 매니저로 `bun <clone>/src/daemon/watch.ts` 를 올려라.

---

## 동작 점검 / 디버깅

```bash
bun <clone>/src/cli.ts doctor          # 데몬·훅 배선 종합 점검
bun <clone>/src/daemon/watch.ts --once # 1회 스윕(데몬 없이 즉시 캡처 + 큐 통계 출력)
```

- **캡처가 안 됨**: ① 50줄 미만 세션은 의도적으로 드랍 ② `~` 에서 시작한 세션은 `_home` 으로
  라우팅(위 주의) ③ `.state/daemon.log` 확인.
- **launchd/cron의 최소 PATH**: 생성된 유닛/plist엔 `bun` 절대경로가 박혀 있으나, `claude`
  CLI까지 쓰는 생성 패스(`autoupdate` 등)를 데몬 맥락에서 돌릴 일이 있으면 PATH 주입이 필요할 수
  있다. 캡처 자체는 LLM을 안 쓰므로 영향 없음.
