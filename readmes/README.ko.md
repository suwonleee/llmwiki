<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki — 로컬에서 가볍게 돌아가는 선순환 프로젝트 위키, 근데 이제 퀴즈를 곁들인

*다른 이름: quiz wiki · llmwiki quiz · Quiz_wiki — 내가 내린 결정을 다시 물어보는 간격 반복(spaced repetition) 레이어.*

[English](../README.md) · **한국어** · [日本語](README.ja.md) · [中文](README.zh.md)

어떤 프로젝트든, 어떤 터미널(기본/tmux/iTerm2)·코딩 에이전트(Claude Code · Codex · OpenCode)를 쓰든, 그 프로젝트에 특화된 LLM 지식이 날아가지 않고 **복리로 쌓입니다**.

## 사용자가 할 일은 이것뿐

Git, [Bun](https://bun.sh), 코딩 에이전트 하나가 이미 설치되어 있다면 나머지는 clone 한 번과 프롬프트 한 번입니다.

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

이 폴더에서 에이전트 **하나만** 실행합니다.

```bash
claude
# 또는: codex
# 또는: opencode
```

에이전트 입력창에 그대로 붙여 넣습니다.

```text
setup_text.md를 읽고, 지금 사용 중인 코딩 에이전트와 이 머신에 llmwiki를 설치해줘. 파일의 지시를 정확히 따르고 상태 점검까지 실행한 뒤, 내가 직접 해야 할 단계가 남았다면 알려줘.
```

이 방식이 권장 설치 경로입니다. README는 사람용 시작점만 담고, 하네스별 분기·상태 점검·`PATH`·훅 신뢰·OS·복구 규칙은 에이전트 계약 [`setup_text.md`](../setup_text.md)와 [설치 플로우 참조](../reference/INSTALLATION_FLOW.md)에 둡니다.

설치가 정상으로 끝나면 같은 설치 세션에서 에이전트에게 요청합니다.

```text
방금 설치한 엔진으로 /내/프로젝트/절대경로에 llmwiki를 초기화해줘. 프로젝트 위키를 검증하고, 지금 코딩 에이전트의 세션 마감 명령도 알려줘.
```

그 프로젝트에서 코딩 에이전트를 열고 평소처럼 작업합니다. 의미 있는 세션의 마지막에는 Claude Code·OpenCode에서 `/wiki-save`, Codex에서 `$wiki-save`를 입력합니다. 백로그와 깊은 정리는 주기적으로 `/wiki-deep`(Codex: `$wiki-deep`)을 실행합니다. 프로젝트 위키가 이상해 보이면 `/wiki-doctor`(Codex: `$wiki-doctor`)를 실행합니다.

위키가 제대로 쌓이는지 확인하려면 해당 프로젝트의 에이전트 입력창에 붙여 넣습니다.

```text
이 프로젝트의 docs/wiki에 문서가 제대로 쌓이는지 확인해줘. 알맞은 llmwiki 상태·진행·lint 점검을 실행하고, 정상인 부분과 조치가 필요한 부분을 요약해줘.
```

### 내 방식대로 바꾸고 싶다면 — 파일 하나

엔진 코드는 그대로 두고, 아래 항목은 전부 설정 파일 하나에서 바꿉니다.

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # 영어 · 주석 상세
```

| 설정 | 무엇이 바뀌나 |
|---|---|
| `[wiki] lang` | **엔진**이 쓰는 언어 (`en` · `ko` · `ja` · `zh`) — 페이지 언어는 이 값이 아니라 항상 대화 언어를 따릅니다 |
| `[[category]]` | 위키 폴더 구성과 각 폴더에 담을 내용 |
| `[topic]` `[queue]` `[quiz]` | 해당 폴더 이름, 그리고 퀴즈 한 세션의 문항 수 |
| `[private] dirs` | 나에게는 인덱싱되지만 커밋되지 않는 폴더 |
| `[models]` | 초안을 쓰는 모델(`light`)과 검증하는 모델(`heavy`) |
| `[files]` · `legacy_dirs` | 특별한 파일 3개의 이름, 이름 변경 후에도 계속 훑을 옛 폴더 |
| `[lint.banned_terms]` | 경고할 표현 (권고일 뿐 차단 안 함) |

가장 쉬운 방법: 원하는 바를 에이전트에게 말하고 `llmwiki.config.toml`만 고치게 한 뒤, `llmwiki config <프로젝트-경로>`로 결과를 확인합니다. 기존 문서 이관은 사용자가 명시적으로 승인하기 전에는 실행되지 않습니다.

MCP 서버·Docker·외부 데이터베이스·벡터 DB·클라우드 서비스는 필요 없습니다. llmwiki는 로컬의 Bun·훅·캡처 데몬·SQLite와 git markdown을 사용합니다. 에이전트가 따르는 설치 계약은 [`setup_text.md`](../setup_text.md)에 있습니다.

- **무엇인가**
    - 에이전트 환경을 위한 LLM 유지 프로젝트 위키 — 소스는 작업 transcript, 저장은 순수 git markdown
    - 엔진 = 로컬 라이브러리: SQLite 인덱스 · 결정적 lint · 인용/교차참조 그래프 · content-hash 증분
    - 그 위에 자동 캡처 데몬 + transcript 복리 — **MCP 등록 불필요**
- **노동 분담**
    - 사실 — AI가 무인으로 작성
    - 판단(방향성 · 결정 · 모순) — 항상 사람 동석
    - 사람 기억 — 일 단위 망각곡선 퀴즈(`/wiki-quiz`)로, 모델의 컨텍스트만큼 내 결정에 대한 내 기억도 유지
- **2계층, 단일 소스**
    - 세션별 *로그북* — 시간축: `2_milestone` · `3_decision` · `4_insight`
    - 개념별 *주제 백과* — `5_topic`, 주제축 · in-place 통합
    - 둘 다 raw transcript에서만 재유도 — 위키→위키 금지

핵심 아이디어 — LLM이 유지하고 사람은 방향만 잡는 프로젝트 위키 — 는 [Andrej Karpathy의 LLM-wiki 노트](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)에서 왔습니다. 참고한 외부 자료는 그 노트 하나뿐이며, 설계와 코드는 자체 구현입니다.

## 수동 설치 대안

에이전트 없이 직접 설치하려는 경우에만 사용합니다. 하네스 하나를 선택하고, 감지된 모든 하네스를 설치할 의도가 아니면 `auto`를 사용하지 않습니다.

```bash
./setup.sh --harness claude
# 또는: ./setup.sh --harness codex
# 또는: ./setup.sh --harness opencode
```

- setup이 출력한 다음 명령을 그대로 사용
    - Claude-only: clone 고정 `bun <clone>/src/cli.ts …`
    - Codex/OpenCode: 사용자 `llmwiki …`
- 출력된 수동 단계 완료
    - Codex만: `/hooks`에서 현재 llmwiki 훅 2개 검토·신뢰
- 전체 분기·복구 기준: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)

## 선순환 루프

여섯 고리 — 둘은 완전 무인, 나머지는 각 1커맨드입니다.

| 고리 | 무엇 | 자동? | 구현 |
|------|------|:---:|------|
| **캡처** | 모든 세션 transcript → 중앙 큐 | ✔ | `src/daemon/watch.ts` (터미널·프로필 무관) |
| **업데이트(update)** | 큐 → 그 레포 `docs/wiki/` **로그층**(증분 append) | 1커맨드 | Codex: `$wiki-save` / `$wiki-deep` · Claude·OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/update.ts` |
| **통합(consolidate)** | 로그 → 개념별 **주제 백과** `5_topic/`(in-place 병합·raw 재-grounding) | 1커맨드 | Codex: `$wiki-save` / `$wiki-deep` · Claude·OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/consolidate.ts` |
| **읽기** | cold-start 주입 + 턴별 관련 페이지 포인터 | ✔ | `hooks/sessionstart-inject.sh` · `hooks/userpromptsubmit-inject.sh` (Claude Code; Codex/OpenCode 는 `adapters/`) |
| **퀴즈(사람 기억)** | 위키의 판단층 → **사람을 위한** 망각곡선(일 단위) 간격반복 퀴즈 (`6_quiz/` 기록 — 인덱스·검색 제외; cold-start 에 due 카운트 1줄) | 1커맨드 | Codex: `$wiki-quiz` · Claude·OpenCode: `/wiki-quiz` + `src/engine/quiz.ts` (`quiz-status`·`quiz-next`·`quiz-record`) |
| **자가치유** | 구조(orphan·stale·dangling)=결정적 `lint` / 의미(모순·낡은주장·개념누락)=생성적 `review`(sync 자동 — 주기 게이트 `--if-due` 기본 7일·범위한정+캐시) → 갭은 `gaps` 자가종료 큐(`0_review/gap-queue.md`) | 1커맨드 → 자동 | `lint`·`review`·`gaps` (`src/engine/{lint,review,gaps}.ts`) |

- **transcript 보존** — transcript는 llmwiki가 아니라 에이전트의 파일
    - 각 에이전트의 보존정책대로 회전 (Claude Code 기본 ~30일 · Codex는 종료 세션을 `.zst` 압축) — llmwiki는 사본을 만들지 않음
    - 남길 세션은 회전 전에 `/wiki-save`로 마감 · transcript가 이미 사라진 큐 행은 deep 패스가 정리 (`capture-prune`, 30일 가드)

### 사람 기억 루프 (`/wiki-quiz`)

다른 고리는 전부 **모델**을 grounded하게 만들고, 이 고리만 **사람**을 벼립니다.

- **왜 존재하는가**
    - 노동 분담이 사람에게 남긴 위임 불가능한 단 하나의 일 = 방향성 + 모순 판단
    - 그 판단력은 자기 과거 결정에 대한 기억과 함께 무뎌짐
- **스케줄 방식** — 엔진이 결정적으로, LLM 0
    - 일 단위 망각곡선: 박스 1·3·7·16·35·60일
    - 오답·모름 → 1일로 리셋 · 하루에 같은 항목 재출제 없음
    - 범위: 위키의 판단층 — 방향성 > 결정 > 인사이트·주제 > 마일스톤, 같은 급이면 최신 우선
- **세션 진행 방식** — 한 번에 전량 선출제
    - 엔진이 due 항목을 뽑으면 세션이 해당 페이지들을 함께 읽고 문제를 전부 미리 작성 — 하나 답하면 다음 문제가 대기 없이 표시
    - 채점은 페이지에 근거한 요지(gist) 채점 · 틀린 것은 다음 날 가장 먼저 재출제
    - 문항 수: `llmwiki.config.toml`의 `[quiz] questions` — 기본 **3**, `/wiki-quiz 5`처럼 인자로 증가, 엔진 상한 **7** (사람이 건너뛰는 퀴즈는 아무것도 강화하지 않음)
- **기록 위치**
    - `docs/wiki/6_quiz/` — 장부 + 날짜별 세션 노트
    - 인덱스·검색·cold-start에서 제외되는 사람 전용 레이어 — LLM이 자기 퀴즈 산출물을 되먹지 않음: 위키 → 사람, 엄격한 단방향

### 근거가 페이지와 함께 이동 (페이지 포맷 v3)

`[^s1]: <세션>.jsonl` 같은 인용은 **한 대의 머신에만** 있는 transcript를 가리킵니다 — 팀원은 결론은 읽어도 그 근거는 열 수 없습니다. v3는 근거 1~2줄을 각주 바로 아래 들여쓴 줄에 함께 둡니다.

```markdown
- 로그층을 버리지 않고 그 위에 주제층을 얹기로 했다 [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "로그는 그대로 두고 그 위에 얹자. 교체는 위험하다"
```

- **포맷 계약**
    - 각주 정의 줄은 이전과 바이트 단위 동일 — 이 줄을 읽는 파서가 넷이고, 그중 하나가 팀원 인용의 에러를 막아 줌
    - 발췌는 `llmwiki excerpt`로만 생성 — 원문 그대로 · 길이 상한 · 비밀정보 스크리닝 (원재료가 세션 transcript라 자격증명이 실제로 섞임)
    - 판단 주장은 사람의 발언을, 사실 주장은 도구 실행 기록을 인용
- **사람이 훑는 본문 구조**
    - 읽는 순서대로 번호 섹션 — `## 1. <제목>`, 섹션이 갈라질 때만 `### 1-1. <제목>`; 묶음이 하나뿐인 짧은 페이지는 불릿 목록만
    - 섹션 안: `-` 한 줄에 구체적 사실·결정·결과·행동 하나 · 뒷받침은 `    -` · 더 깊은 detail은 `        -` (4단계는 없음)
    - 한 줄에 열거를 뭉치지 않음: 항목이 3개를 넘으면 부모 한 줄 + 항목별 자식 불릿 (`·` 나열 금지 — lint `dense-bullet`)
    - 어미는 페이지 언어에서 자연스러운 명사형·개조식 · 행위자·조건·결과가 흐려질 때만 동사 유지
    - 추상적 포장 · 제목/TL;DR 반복 · 부모를 되풀이하는 자식 불릿 금지 (긴 페이지에 섹션이 없으면 lint `flat-body`)
- **lint의 태도**
    - 인용 검증은 그 transcript를 **읽을 수 있는 머신에서만** 수행 — 없는 클론에서는 침묵 ("검증 못 함"이 "틀림"으로 읽히면 안 됨)
- **검색 비용 0**
    - 발췌는 검색 인덱스·주제 페이지 예산에서 제외 — 근거를 붙여도 검색 품질·본문 분량 무손실

### 자가치유 흐름 (사람은 채우기만)

위키가 무엇이 빠졌는지 스스로 보고하고, 사람은 채우는 판단만 합니다.

- **마감(`/wiki-save`) · deep 패스(`/wiki-deep`) 때**
    - ① 결정적 `lint` — 구조 (orphan · stale · dangling)
    - ② 생성적 `review` — 의미 (모순 · 낡은 주장 · 개념 누락); `--if-due`로 자동 실행하되 엔진이 주기를 강제(기본 7일, `LLMWIKI_REVIEW_INTERVAL_DAYS`) · 입력은 최근+태그 이웃 한정 · 무변경 시 스킵 · deep 패스는 무조건 실행
    - ③ `gaps` — `review`가 찾은 *개념 누락 · 다음 질문*을 추적 큐(`0_review/gap-queue.md`)로 적재
- **갭이 닫히는 방식**
    - 그 주제로 한 번 작업하거나 deep 패스가 채우면 충족
    - `review`가 2회 연속 띄우지 않으면 자동 close
- **갭의 자동 생성은 의도적으로 없음** — 빈약한 근거로 페이지를 지어내지 않기 위함

## 구조

```
setup.sh       원클릭 온보딩 (경로 무관: doctor→데몬→훅·커맨드→인덱스)
src/           TypeScript 엔진 (Bun 런타임, bun:sqlite 내장 — node_modules·빌드 0)
  cli.ts       CLI 디스패처: init·index·reindex·refs·lint·search·update-*·skeleton·autoupdate·consolidate·topics·ingest·register-transcript·review·gaps·distill-verify·git-rules·overview·reconcile·doctor·context·digest·context-audit·config·conventions·migrate·quiz-*·capture-prune·bench·compare-arm·compare-verdict
  engine/
    schema.sql   per-repo 인덱스 스키마 (documents·chunks·FTS5·references)
    db.ts        WikiIndex: 인덱싱(content_hash 증분)·검색·그래프·staleness
    chunker.ts   FTS 청킹 (~512토큰)         refs.ts    인용·링크 → 그래프 엣지
    lint.ts      구조 위생검사 (결정적)      review.ts  의미 lint (생성적·sync 자동·범위한정+무변경 스킵 캐시)
    gaps.ts      review 갭(개념누락·다음질문) → 자가종료 큐 0_review/gap-queue.md (LLM 0; 2회 부재 시 close)
    quiz.ts      사람 기억 루프 — 망각곡선(일 단위) 스케줄링 + 우선순위 선별 + 6_quiz/quiz-ledger.md (LLM 0; 출제·채점은 /wiki-quiz 가 웜으로)
    overview.ts  overview 엔트리포인트 정규화 (Recent Updates→log 포인터·예산경고, LLM 0·멱등)
    synthesis.ts 결정적 관계형 종합 + 주제 뷰(태그 클러스터·통합 갭, `topics`) — LLM 0·재생성 (`digest`/`topics`+cold-start spine)
    extract.ts   transcript 증분 추출 (watermark)   update.ts  로그층 오케스트레이션
    autoupdate.ts  무인 사실 update (write→2차검증→lint 게이트)
    consolidate.ts 로그→주제 백과(5_topic) 통합 (write→독립 VERIFY(추가 claim)→grounding→lint, 독립 watermark)
    source.ts    transcript 소스 추상화 (discover/probe/parse 어댑터 — 하네스 무관)
    sources/     claude.ts(claude-jsonl) · codex.ts(Codex rollout, .zst 포함) · opencode.ts(OpenCode SQLite→export) · plain.ts(임의 파일 drop)
    ingest.ts    데몬 없이 파일 1개 업데이트 (`llmwiki ingest` — drop a source)
    capture.ts   중앙 캡처 큐 (.state/capture.db, source_kind)   doctor.ts   배선 점검
    config.ts    팀 컨벤션 — llmwiki.config.toml + configs/*.toml 레포별 resolver (applies_to prefix; zero-config=기본 구조; 프롬프트/규칙이 여기서 렌더되는 단일 진실)
    migrate.ts   위키를 config 구조로 이관 (dry-run 기본·링크 재작성·.schema-version·드리프트 감지)
  daemon/
    watch.ts     캡처 데몬 (sources() 스윕 — 기본 Claude 프로필 transcript)
    wire.ts      Claude 훅·커맨드 배선 (~/.claude* + $CLAUDE_CONFIG_DIR)
    wire-codex.ts Codex 훅 병합 + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCode 전역 플러그인 + /wiki-* + 공유 CLI
    list-pending-repos.ts  큐에서 pending 레포만 출력 (스케줄러용)
daemon/        install.sh (launchd/systemd/cron 자동감지) + autoupdate-*.sh (무인 사실 패스)
hooks/         sessionstart-inject.sh (cold-start 주입) · userpromptsubmit-inject.sh (턴별 포인터 주입)
adapters/      codex/ (네이티브 훅 hooks.json 템플릿) · opencode/ (플러그인 1파일)
skill/         wiki-save(세션 마감)·wiki-deep(deep 주기 패스)·wiki-doctor(진단·복구)·wiki-ask·wiki-quiz(사람 기억) (/커맨드)
examples/      sample-wiki/ — 완성된 위키 예시(읽기 전용). 엔진이 인덱싱 안 함(IGNORE_DIRS). **복사하지 말 것** — 실제 위키는 각 프로젝트 docs/wiki에 자동 생성. examples/README.md 참조
tests/         bun:test 스위트 (chunker·refs·lint·extract·capture·db·source·review-scope·overview·gaps·quiz·마이그레이션) — `bun test`
package.json·tsconfig.json   Bun 메타(typecheck용; 런타임은 .ts 직접 실행)
```

저장 원칙 — 세 저장소, 각자 주인 하나:

- 캡처 큐 — 중앙: `<clone>/.state/capture.db`
- 콘텐츠 — 각 레포의 `docs/wiki/` (co-location; markdown = 진실원)
- 인덱스 — `<repo>/.llmwiki/index.db` (언제든 재생성 가능)

## 사전 요구사항

| | 필요 | 비고 |
|---|---|---|
| **Bun ≥ 1.1** | ✔ 필수 | 단일 바이너리 (`curl -fsSL https://bun.sh/install \| bash`). `.ts` 를 그대로 실행, `bun:sqlite` 가 FTS5 까지 번들 — 빌드·`node_modules` 0. 엔진 실행·`bun test` 는 무설치로 동작; `bun run typecheck`(tsc) 만 `bun install` 1회 필요 (dev 전용). |
| **Codex · OpenCode CLI** | 각 빠른 시작에만 | `codex` / `opencode` 가 `PATH`에 있어야 함. Codex는 추가로 lifecycle hook 지원 + stable `hooks` 기능 활성 필요. setup은 훅·스킬·서비스 변경 전에 지원 여부와 기존 기능 설정을 확인. |
| **LLM CLI** | 생성 패스에만 | 캡처·읽기 주입·`/wiki-*`·`ingest`(capture-only, 대기 목록만 기록)는 없어도 동작. `autoupdate·review` 와 `ingest` 의 통합은 LLM CLI 를 호출 — 기본 `claude -p`([설치](https://docs.claude.com/en/docs/claude-code/setup)), 또는 `LLMWIKI_LLM_CMD` 로 다른 CLI/provider. |
| **OS** | macOS / Linux | macOS=launchd, Linux=systemd(`--user`), systemd 없으면 cron+nohup 폴백. 데몬 세부는 [`daemon/README.md`](../daemon/README.md) |

### 하네스 · OS 노트 (Claude Code / Codex / OpenCode / Windows)

- **Claude Code** — `git clone … && ./setup.sh`, 끝
    - 캡처 · 읽기 주입 · `/wiki-*` 커맨드 전부 자동 배선
- **Codex (OpenAI)** — `./setup.sh --harness codex`
    - 사용자 CLI + `$wiki-*` 스킬 5개 설치, `$CODEX_HOME/hooks.json`에 native `SessionStart`/`UserPromptSubmit` 훅 병합
    - 최초 1회: Codex를 시작해 `/hooks`에서 정확한 명령을 검토 — 새 훅·변경된 훅은 신뢰 전까지 실행되지 않음
    - 캡처는 `$CODEX_HOME/sessions/**/*.jsonl[.zst]` 감시
    - 웜 스킬은 Codex 자체로 동작 · 무인 `autoupdate`/`review`는 Claude CLI가 없으면 `LLMWIKI_LLM_CMD` 필요
- **OpenCode** — `./setup.sh --harness opencode`
    - 전역 `/wiki-*` custom command, clone 경로가 내장된 읽기 주입 플러그인, 사용자 CLI 설치
    - 캡처는 SQLite 세션 저장소를 읽음 · `XDG_DATA_HOME`/`OPENCODE_DB`도 데몬 환경에 보존
- **Windows** — WSL2 권장
    - Bun·`bun:sqlite`는 네이티브 동작 · 경로 매칭은 backslash 정규화
    - 단 네이티브 Windows는 `.sh` 스크립트에 Git Bash 필요 + 데몬은 Task Scheduler/NSSM 수동 등록 (launchd/systemd/cron 부재)
    - WSL2에서는 전부 무수정 동작 (launchd→systemd · bash · 경로) — Claude Code·Codex 공식 권장과도 일치

## 설치 / 사용

**이 레포를 아무 데나, 아무 이름으로 clone한 뒤 `./setup.sh`를 실행**하면 그 머신의 엔진이 됩니다.

- 모든 배선(데몬 · 훅 · CLI · `/wiki-*` 커맨드)이 clone 위치 자체에서 유도 — `~/llmwiki` 같은 고정 경로 불필요, 폴더 이름 자유
- Bun만 있으면 `.ts`가 그대로 실행 — 번들·빌드 단계 없음
- clone을 이동·업데이트한 뒤에는 setup 재실행 — 생성 스킬과 배선을 멱등하게 갱신

```bash
# 0) 엔진 clone (머신당 1회) — 위치·이름 무관
git clone https://github.com/suwonleee/llmwiki.git
cd llmwiki

# 1) 한 방 설치 — doctor → 캡처 데몬(OS 자동감지) → 하네스 배선 → doctor
./setup.sh --harness auto                # 하나만 지정하려면: claude · codex · opencode

# 2) 그냥 작업한다 — 어느 폴더·터미널이든 세션이 자동 캡처됨
#    레포별 수동 명령: bun <clone>/src/cli.ts init|index|search|lint <repo>

# 3) 에이전트 입력창에서 세션 마감
/wiki-save                               # 세션 마감 (Codex: $wiki-save)
/wiki-deep                               # deep 주기 패스 (Codex: $wiki-deep)
/wiki-doctor                             # 이 위키 진단·복구 (Codex: $wiki-doctor)
/wiki-quiz                               # 사람 기억 루프 (Codex: $wiki-quiz)
```

> 개별 단계: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` ·
> `bun <clone>/src/daemon/wire.ts`(Claude) · `wire-codex.ts` / `wire-opencode.ts`(Codex/OpenCode) —
> 각 wire 스크립트는 `--revert`로 자기 변경만 되돌림.

## 설정 (환경 변수) — provider · 모델 · CLI 무관

생성 패스(autoupdate/review)는 기본값으로 `claude -p` + 아래에 표시된 고정 내장 모델 ID를 쓰며, 무설정이면 기본 동작과 완전히 동일합니다.

| env | 기본값 | 용도 |
|---|---|---|
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | 추론급 tier — VERIFY(적대적 게이트)·review(의미 검토) |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | 초안급 tier — WRITE(페이지 생성) |
| `CLAUDE_CONFIG_DIR` | (Claude Code 표준) | 설정 시 해당 디렉토리도 Claude 프로필로 인식 — 훅 배선(wire)·캡처(claude source)·doctor 가 함께 존중. |
| `LLMWIKI_LLM_CMD` | `claude -p {prompt} --model {model} --disallowedTools …` | LLM 호출 argv 템플릿. `{prompt}`·`{model}` 을 토큰 단위로 치환(셸 파싱 안 함). `{prompt}` 가 없으면 prompt 를 stdin 으로 보냄. 따옴표 multi-word 가 필요하면 JSON 배열(`["my-llm","--q","{prompt}"]`)로. Codex·`llm`·ollama 등 아무 CLI 나. |
| `LLMWIKI_LANG` | `en` | 콜드스타트 운영 규칙/헤더 언어. `ko` 면 한국어. (위키 본문 자체는 작성된 그대로 — UI 문구만 스위치.) |
| `LLMWIKI_SEARCH_RELAX` | (on) | `off`면 완화 폴백 비활성 — 자연어 질의가 strict AND 0건일 때 같은 단어들을 OR로 1회 재시도(trigram 안전·유니코드/CJK 인식·stopword 목록 없음). A/B 측정용 킬스위치. |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144` (256KB) | 소스 파일당 콘텐츠 캡. 초과 파일(수 MB yaml/json 픽스처 등)은 메타데이터만 등록 — 이름·경로로는 검색되지만 전문 색인은 제외. 위키 페이지는 캡 무관. 픽스처 많은 레포에서도 인덱스를 작게, 검색을 빠르게 유지 — 검색·turn-context 품질 무변. |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | `review` 단일패스 입력 cap. 위키가 이보다 크면 최근+태그 이웃만 검토(프롬프트 오버플로 방지). |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` 주기 게이트 — 마지막 커밋된 review 이후 이 일수가 지나야 실행(그 전엔 ~0.03초에 결정적 skip). 세션 마감의 review 비용을 기본 0으로. |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` 페이지 비대 경고(`topic-oversize`, advisory) 글자 예산 — 초과 시 deep 패스가 인용 transcript 로부터 다시 작성하며 `distill-verify`(인용 세트 축소 금지)로 게이트. |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview --normalize` 가 경고를 내는 overview.md 글자 예산(엔트리포인트 비대 감시). |
| `LLMWIKI_L0_BUDGET` | `1600` | cold-start L0(current-state)의 글자 **기준**. 주입은 **자르지 않음** — 기준 초과 페이지도 전량 주입하고 초과 통지 1줄을 부착(다음 마감이 트리밍하도록); `oversized-l0` lint 는 1.25×부터 경고. |

- 각 tier를 "그때그때 출시된 최상위 모델"로 올리거나, 비-Anthropic 모델/엔드포인트로 교체 가능
- **하네스 무관 읽기**
    - `bun <clone>/src/cli.ts context <repo>` — cold-start 컨텍스트 · `… turn-context <repo>`(훅 stdin JSON 또는 `--prompt`) — 턴별 관련 페이지 포인터 (≤3줄, 확신 없으면 침묵)
    - Claude Code는 두 훅이 자동 배선 · 최신 Codex는 같은 훅 스크립트를 네이티브로 실행(`adapters/codex/`) · OpenCode는 1파일 플러그인이 주입(`adapters/opencode/`)
    - 그 밖의 하네스는 AGENTS.md·시작 프롬프트에서 같은 명령 호출
    - 턴별 주입은 점진적 향상 — cold-start + `search` 기준선은 어디서나 동일

## 팀 사용 (한 프로젝트의 위키 공유)

혼자 쓸 때는 아래가 전혀 필요 없습니다 — 전부 추가적(additive)이고 1인 사용에서는 조용합니다. 여러 사람이 한 프로젝트를 쓸 때는 각자 자기 로컬 엔진(자기 캡처 데몬·큐)을 돌리고 **자기 세션만** 공유 `docs/wiki/`에 정리해 넣으며, 공유는 순수 git입니다.

- **스캐폴드 안전장치**
    - `.gitignore` 자동 시딩 — `.llmwiki/`(파생 인덱스)는 커밋되지 않음
    - `.gitattributes` 자동 시딩 — `docs/wiki/log.md merge=union`, 동시 append가 충돌 없이 병합
- **귀속**
    - 작성자 정보는 frontmatter의 `author:`에 저장하지 않고 `.mailmap`을 반영한 git 이력에서 계산
    - `0_review` 질문에는 `owner: <GitHub login>`을 기록 — cold-start가 `[→ login]`으로 표시, 자기 것 아닌 질문은 건너뜀
- **팀원 인용 자가치유**
    - 정상 형식의 `.jsonl` 인용은 인덱스 재빌드 때 가상 소스로 자동 등록 (transcript는 어차피 회전·소멸)
    - 팀원의 인용이 내 `lint` 게이트를 깨지 않음 · 형식이 깨진 인용은 여전히 error
- **연속성**
    - 클론이 origin보다 뒤면 cold-start가 한 줄로 알림 — 팀원이 병합한 맥락이 있을 수 있으니 시작 전 pull
- **리뷰 흐름**
    - 위키 커밋은 코드와 같은 브랜치·같은 PR — **PR 리뷰가 곧 AI 작성 페이지의 사람 승인 게이트**
    - `gap-queue.md`/`overview.md` 충돌 시: 아무 쪽이나 취한 뒤 `llmwiki gaps` / `llmwiki overview --normalize` 재실행(수렴함) — 생성된 본문의 수동 병합 금지
- **안전이 확인된 충돌 2종**
    - `current-state.md`(L0): 아무 쪽을 취해도 안전 — 다음 `/wiki-save`가 위키 상태에서 Now/Next를 재유도해 수렴 · 단 **Next** 불릿만은 양쪽 합집합 권장(액션 대기를 잃지 않기)
    - 같은 `5_topic` 페이지 동시 추가: **양쪽 불릿 모두 보존** — 토픽 페이지는 포맷 규칙상 추가 전용(기존 줄 불변·병합은 추가만)이라 합집합이 항상 옳은 병합

## 팀 컨벤션 — `llmwiki.config.toml` (선택)

기본 카테고리 구조(`0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`)가 내장 기본값입니다 — **config 파일이 없으면 아무것도 바뀌지 않습니다(바이트 단위 동일**, 렌더된 프롬프트/규칙이 기존 텍스트와 같음을 테스트로 고정). 다른 팀 포맷을 쓰려면 `llmwiki.config.example.toml`을 클론 루트에 `llmwiki.config.toml`로 복사해 카테고리를 선언합니다:

```toml
[[category]]
dir = "1_goal"     # docs/wiki 아래 폴더명
domain = "goal"    # 이 폴더로 라우팅되는 frontmatter domain
review = "human"   # human → 0_review 큐 · model → 강모델 확정
guide = "분기 목표. 변경은 사람이 확정."
```

- **단일 진실**
    - WRITE 프롬프트, cold-start 운영규칙, `llmwiki conventions <repo>`(`/wiki-*` 스킬이 위임하는 출력)가 전부 이 파일에서 렌더 — 드리프트할 산문 사본 없음
- **레포별 config** (선택)
    - `<clone>/configs/` 아래 여러 `*.toml` 배치 — `applies_to = ["<폴더>", …]`가 있으면 그 폴더와 하위 전체에 적용 (segment-safe prefix · 가장 구체적 경로 승리 · `~` 확장)
    - `applies_to`가 없으면 전 레포 기본값 (표준 이름: `configs/default.toml`)
    - 우선순위: named 매칭 → `configs/` default → 루트 `llmwiki.config.toml` → 내장 기본값 · 매칭 기준은 세션 훅이 넘기는 경로(`CLAUDE_PROJECT_DIR`/cwd)
- **확인** — `llmwiki config [workspace]`
    - 어느 파일이 왜 선택됐는지 표시(검증 포함) · 잘못된/못 읽는 파일은 경고와 함께 안전 폴백 — 세션을 깨지 않음
- **기존 위키 구조 변경** — `llmwiki migrate <repo>` (dry-run) → `--commit`
    - 폴더 rename + 모든 위키링크/상대링크 재작성 + frontmatter `domain:` 갱신 + `.schema-version` 스탬프
    - 자동 실행 없음 — cold-start는 드리프트를 양방향(위키가 config보다 새것 / config가 위키보다 새것)으로 감지·제안만 함
- **팀 배포**
    - config를 팀 엔진 포크에 커밋 → 각자 `git pull` → 1명이 `migrate` 실행 → 결과는 여느 변경처럼 PR로 병합
- **호환성 규율**
    - config 키 제거는 폐기 유예 + lint 경고 + `migrate` 스텝을 거친 뒤에만 — 조용한 제거 금지

## 회귀 측정 (엔진 개발 도구 — 일상 루프 밖)

- **`llmwiki bench <repo>`** — 결정적 검색 벤치마크 (LLM 0, ms 단위)
    - 골든 질의셋: `<repo>/docs/wiki/.bench/golden.toml` (레포당 ≤20, 언어 무관)
    - 채점: search any-hit `r@k` + turn-context 포인터 적중/침묵 — refusal 질의는 turn-context가 침묵하면 정답 (구조 판정이라 언어 중립)
    - seed 고정 tune/sealed 분리 — `--tune-only`는 자유 반복용, `--sealed`는 최종 확인 전용 (sealed 결과는 볼 때마다 회귀 가드 가치가 줄어듦)
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 동결 corpus A/B
    - 같은 transcript corpus로 설정/리비전별 격리 임시 위키를 빌드 — arm 빌드만 LLM 사용
    - 라벨된 결과 2개를 순차 게이트로 판정: 회귀 차단 우선 → keep/adopt/undecided, LLM 0
    - 프롬프트·모델 변경 시에만 실행

## 원칙

- transcript = raw 불변 — 인용만, 위키→위키 재유도 금지 · 증분 = watermark 이후만 처리
- 사실 = AI 자동 / 판단(결정 Why·What·Alt·방향성) = 사람 — `status: draft` 플래그
- git markdown = 단일 진실원 — 커밋은 단일 작성자 명의(저장소 소유자)
- 과적재 금지 — 100k 토큰 미만이면 vector DB·RAG 불필요 (index.md 내비게이션으로 충분)

## 라이선스

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
