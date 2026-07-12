# examples/ — 읽기 전용 예시 (위키에 복사하지 말 것)

[English](README.md) · **한국어**

`sample-wiki/`는 작은 가상 프로젝트 — **"pennywise"**(은행 CSV를 가져와 거래를 분류하고
월별 지출을 리포트하는 개인 가계부 CLI) — 로 몇 세션 작업한 뒤의 **완성형 위키 예시**(동결본)입니다.

새로 온 사람이 자기 위키를 만들기 **전에** 두 계층의 **모양**, 페이지 포맷, 자가치유 산출물을
눈으로 확인하라고 넣어 둔 것입니다.

## 무엇이 들어 있나

```
sample-wiki/
├── current-state.md      L0 — 매 세션 가장 먼저 주입되는 콜드스타트 스냅샷 (짧게 유지)
├── overview.md           표지 / 엔트리포인트 — 링크만, 세션 로그는 쌓지 않음
├── log.md                ingest/update/sync 시간순 기록 (append-only)
│
│   # ── 시간 계층 (세션별 로그북) ──
├── 2_milestone/          한 일 + 다음 할 일
│   └── 2026-01-15-csv-import-and-categorization.md
├── 3_decision/           ADR: 문제 · 대안 · 선택 (Why/What/Alt)
│   └── 2026-01-12-storage-sqlite-over-json.md
├── 4_insight/            작업 중 깨달은 점 · 함정
│   └── 2026-01-14-timezone-bug-in-date-parsing.md
│
│   # ── 주제 계층 (개념 백과, in-place 통합) ──
├── 5_topic/              개념당 한 페이지, raw transcript에서 재-grounding
│   └── transaction-import.md
│
└── 0_review/
    └── gap-queue.md      review가 표면화한 갭의 자가종료 큐
                          (해당 주제로 작업하면 채워지고, 2회 연속 부재 시 자동 close)
```

두 계층 한눈에:

- **시간 계층** (`2_milestone` / `3_decision` / `4_insight`) — *시간순 로그북*. 세션당 한 항목,
  append-only. "언제 무슨 일이 있었나."
- **주제 계층** (`5_topic`) — *개념 백과*. 개념당 한 페이지, 세션을 넘나들며 제자리 통합.
  "X에 대해 우리가 아는 것."

둘 다 raw 세션 transcript에서만 재유도됩니다(위키→위키 금지). `current-state.md`(L0) +
`overview.md`가 세션 시작 시 주입되는 엔트리포인트입니다.

## 중요 — 어디까지나 예시일 뿐

- **엔진은 여기를 읽지도 쓰지도 않습니다.** `setup.sh`는 `<repo>/docs/wiki`만 인덱싱하고
  `examples/`는 건드리지 않습니다(`IGNORE_DIRS`).
- **복사할 것이 없습니다.** 실제 위키는 프로젝트마다 그 프로젝트의 `docs/wiki/` 아래에
  자동으로 만들어집니다. 엔진을 clone하고 `./setup.sh`를 돌린 뒤 그냥 작업하면 —
  위키가 알아서 채워집니다.

관례를 익히려고 둘러본 뒤엔, 무시하세요.
