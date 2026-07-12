<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner.png" alt="suwon_wiki" width="100%">
  </picture>
</p>

# llmwiki — 로컬-퍼스트 복리 엔지니어링 로그북 + 주제 백과

[English](README.md) · **한국어**

> 어떤 프로젝트든, 어떤 터미널(기본/tmux/iTerm2)·코딩 에이전트(Claude Code·Codex·OpenCode)를 쓰든,
> 그 프로젝트에 특화된 LLM 지식이 **복리로 누적**되게 한다.
> 에이전트 환경을 위한 LLM 유지 프로젝트 위키 —
> 소스를 작업 transcript로 삼고, 노동을 **사실=무인 / 판단=사람 동석**으로 분리한다.
> 구조는 **2계층** — 세션별 *로그북*(시간축: `2_milestone`·`3_decision`·`4_insight`) + 개념별 *주제 백과*(`5_topic`, 주제축·in-place 통합). 둘 다 raw transcript에서만 재유도(위키→위키 금지).

엔진은 **로컬 라이브러리** — SQLite 인덱스·결정적 lint·인용/교차참조 그래프·content-hash 증분 —
이고, 그 위에 **자동 캡처 데몬 + transcript 복리 + 노동분담(사실=AI/판단=사람)** 을 얹었다.
**MCP 등록 불필요.**

핵심 아이디어 — LLM이 유지하고 사람은 방향만 잡는 프로젝트 위키 — 는 [Andrej Karpathy의 LLM-wiki 노트](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)에서 왔다. 참고한 외부 자료는 그 노트 하나뿐이며, 설계와 코드는 자체 구현이다.

## 선순환 루프

| 고리 | 무엇 | 자동? | 구현 |
|------|------|:---:|------|
| **캡처** | 모든 세션 transcript → 중앙 큐 | ✔ | `src/daemon/watch.ts` (터미널·프로필 무관) |
| **업데이트(update)** | 큐 → 그 레포 `docs/wiki/` **로그층**(증분 append) | 1커맨드 | `/wiki-update`(이 세션, fast)·`/wiki-sync`(백로그, deep) + `src/engine/update.ts` |
| **통합(consolidate)** | 로그 → 개념별 **주제 백과** `5_topic/`(in-place 병합·raw 재-grounding) | 1커맨드 | `/wiki-update`(이 세션)·`/wiki-sync`(갭·비대 토픽 재작성) + `src/engine/consolidate.ts` |
| **읽기** | cold-start 주입 + 턴별 관련 페이지 포인터 | ✔ | `hooks/sessionstart-inject.sh` · `hooks/userpromptsubmit-inject.sh` (Claude Code; Codex/OpenCode 는 `adapters/`) |
| **자가치유** | 구조(orphan·stale·dangling)=결정적 `lint` / 의미(모순·낡은주장·개념누락)=생성적 `review`(sync 자동 — 주기 게이트 `--if-due` 기본 7일·범위한정+캐시) → 갭은 `gaps` 자가종료 큐(`0_review/gap-queue.md`) | 1커맨드 → 자동 | `lint`·`review`·`gaps` (`src/engine/{lint,review,gaps}.ts`) |

### 자가치유 흐름 (사람은 채우기만)
마감(`/wiki-update`)·deep 패스(`/wiki-sync`) 때: ① 결정적 `lint`(구조) → ② 생성적 `review`(의미 — 마감에서 `--if-due`로 자동 실행하되 **엔진이 주기를 강제**(기본 7일, `LLMWIKI_REVIEW_INTERVAL_DAYS`), 입력은 최근+태그 이웃 한정·무변경 스킵; deep은 강제 실행) → ③ `review`가 찾은 *개념 누락·다음 질문* 을 `gaps` 가 **추적 큐**로 쌓음. 갭은 **해당 주제로 한 번 작업하거나 `/wiki-sync`(deep)** 가 채우고, `review`가 2회 연속 안 띄우면 큐에서 **자동 close**. 즉 위키가 *무엇이 빠졌는지* 를 스스로 알려주고, 채우는 판단만 사람이 한다. 갭을 **자동 생성**하지 않는 건 의도 — 빈약한 근거로 페이지를 지어내지 않기 위함.

## 구조

```
setup.sh       원클릭 온보딩 (경로 무관: doctor→데몬→훅·커맨드→인덱스)
src/           TypeScript 엔진 (Bun 런타임, bun:sqlite 내장 — node_modules·빌드 0)
  cli.ts       CLI 디스패처: init·index·reindex·refs·lint·search·update-*·skeleton·autoupdate·consolidate·topics·ingest·register-transcript·review·gaps·distill-verify·git-rules·overview·reconcile·doctor·context·digest·context-audit·config·conventions·migrate·bench·compare-arm·compare-verdict
  engine/
    schema.sql   per-repo 인덱스 스키마 (documents·chunks·FTS5·references)
    db.ts        WikiIndex: 인덱싱(content_hash 증분)·검색·그래프·staleness
    chunker.ts   FTS 청킹 (~512토큰)         refs.ts    인용·링크 → 그래프 엣지
    lint.ts      구조 위생검사 (결정적)      review.ts  의미 lint (생성적·sync 자동·범위한정+무변경 스킵 캐시)
    gaps.ts      review 갭(개념누락·다음질문) → 자가종료 큐 0_review/gap-queue.md (LLM 0; 2회 부재 시 close)
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
    wire.ts      훅·커맨드 배선 (~/.claude* + $CLAUDE_CONFIG_DIR)
    list-pending-repos.ts  큐에서 pending 레포만 출력 (스케줄러용)
daemon/        install.sh (launchd/systemd/cron 자동감지) + autoupdate-*.sh (무인 사실 패스)
hooks/         sessionstart-inject.sh (cold-start 주입) · userpromptsubmit-inject.sh (턴별 포인터 주입)
adapters/      codex/ (네이티브 훅 hooks.json 템플릿) · opencode/ (플러그인 1파일)
skill/         wiki-update(fast 세션 마감)·wiki-sync(deep 주기 패스)·wiki-ask (/커맨드)
examples/      sample-wiki/ — 완성된 위키 예시(읽기 전용). 엔진이 인덱싱 안 함(IGNORE_DIRS). **복사하지 말 것** — 실제 위키는 각 프로젝트 docs/wiki에 자동 생성. examples/README.md 참조
tests/         bun:test 스위트 (chunker·refs·lint·extract·capture·db·source·review-scope·overview·gaps·마이그레이션) — `bun test`
package.json·tsconfig.json   Bun 메타(typecheck용; 런타임은 .ts 직접 실행)
```

저장 원칙: **캡처 큐 = 중앙(`<clone>/.state/capture.db`) / 콘텐츠 = 각 레포 `docs/wiki/`(co-location, markdown=진실원) / 인덱스 = `<repo>/.llmwiki/index.db`(재생성 가능)**.

## 사전 요구사항 (Prerequisites)

| | 필요 | 비고 |
|---|---|---|
| **Bun ≥ 1.1** | ✔ 필수 | 단일 바이너리 (`curl -fsSL https://bun.sh/install \| bash`). `.ts` 를 그대로 실행, `bun:sqlite` 가 FTS5 까지 번들 — 빌드·`node_modules` 0. 엔진 실행·`bun test` 는 무설치로 동작; `bun run typecheck`(tsc) 만 `bun install` 1회 필요 (dev 전용). |
| **LLM CLI** | 생성 패스에만 | 캡처·읽기 주입·`/wiki-*`·`ingest`(capture-only, 대기 목록만 기록) 는 없어도 동작. `autoupdate·review` 와 `ingest` 의 업데이트는 LLM CLI 를 호출하므로 필요 — 기본 `claude -p`([설치](https://docs.claude.com/en/docs/claude-code/setup)), 또는 `LLMWIKI_LLM_CMD` 로 다른 CLI/provider. |
| **OS** | macOS / Linux | macOS=launchd, Linux=systemd(`--user`), systemd 없으면 cron+nohup 폴백. 데몬 세부는 [`daemon/README.md`](daemon/README.md) |

### 하네스·OS 노트 (Claude Code / Codex / Windows)

- **Claude Code**: `git clone … && ./setup.sh` → 끝. 캡처·읽기 주입·`/wiki-*` 전부 자동 배선.
- **Codex (OpenAI)**: 캡처는 자동 — 데몬이 `$CODEX_HOME/sessions/**/*.jsonl[.zst]`(기본 `~/.codex`, current/legacy/압축 포맷) 어댑터로 감시. **읽기 주입은 네이티브**(0.142.0 확인): `adapters/codex/hooks.json.example` → `$CODEX_HOME/hooks.json` 복사 후 1회 신뢰(대화형 `codex` → "Trust all"), 동일한 `sessionstart-inject.sh`/`userpromptsubmit-inject.sh`가 그대로 실행됨. **생성 패스**(autoupdate/review)는 claude CLI가 없으면 `LLMWIKI_LLM_CMD`를 codex 등 자기 CLI로 지정.
- **OpenCode**: 캡처는 SQLite 세션 저장소를 읽음; 읽기 주입은 `adapters/opencode/`의 1파일 플러그인(`experimental.chat.system.transform`, 1.3.0 확인). `LLMWIKI_ROOT`를 clone 경로로 설정.
- **Windows**: Bun·`bun:sqlite`는 네이티브 동작하고 경로 매칭은 backslash 정규화됨. 단 네이티브 Windows는 (a) `.sh` 스크립트에 **Git Bash** 필요, (b) 데몬에 launchd/systemd/cron이 없어 **Task Scheduler/NSSM** 수동 등록 필요. → **WSL2 권장**(launchd→systemd·bash·경로가 무수정 동작; Claude Code·Codex 공식 권장도 동일).

## 설치 / 사용

**이 레포를 아무 데나·아무 이름으로 clone 한 뒤 `./setup.sh` 한 번** 돌리면 그 머신의 엔진이 된다.
모든 배선(데몬·훅·CLI·`/wiki-*` 커맨드)이 **clone 위치 자체에서 유도**되므로 `~/llmwiki` 같은 고정 경로가
필요 없다 (폴더 이름은 무엇이든 OK). Bun 만 있으면 추가 의존성 없이 `bun` 으로 `.ts` 가 그대로 돈다 (번들·빌드 단계 없음).

```bash
# 0) 엔진 clone (한 번, 머신당 1개) — 위치·이름 무관
git clone https://github.com/suwonleee/llmwiki
cd llmwiki

# 1) 한 방 설치 — doctor → 캡처 데몬(OS 자동감지) → SessionStart 훅 + /wiki-* 커맨드 → 인덱스 → doctor
./setup.sh                               # idempotent: clone 이동·엔진 업데이트(git pull) 후 재실행해도 안전

# 2) 그냥 작업한다 — 어느 폴더·터미널이든 세션이 자동 캡처됨
#    다른 프로젝트에서 수동으로 쓰려면 그 폴더에서:
#    bun <clone>/src/cli.ts init|index|search|lint <repo>

# 3) 세션 마감/정리 (그 레포에서)
/wiki-update                             # fast 마감(세션 끝마다): 이 세션만 반영 + 5_topic 통합 + L0 신선도 + lint — 분 단위, O(세션) (웜·사람동석)
/wiki-sync                               # deep 주기 패스(하루 마무리/주 1회쯤): 백로그 소진 + 의미 review + 갭 큐 + 비대 토픽 재작성. 미루기=무손실(transcript 불변·워터마크/큐 영속)
```

> 개별 단계로 돌리려면: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` ·
> `bun <clone>/src/daemon/wire.ts`. 되돌리기: `install.sh --uninstall` · `wire.ts --revert`.

## 설정 (환경 변수) — provider·모델·CLI 무관

생성 패스(autoupdate/review)는 기본값으로 `claude -p` + 최신 Claude 모델을 쓰지만, 전부 env 로 바꿔 끼울 수 있다 (무설정 시 기본 동작과 동일):

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
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` 주기 게이트 — 마지막 커밋된 review 이후 이 일수가 지나야 실행(그 전엔 ~0.03초에 결정적 skip). fast 마감의 review 비용을 기본 0으로. |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` 페이지 비대 경고(`topic-oversize`, advisory) 글자 예산 — 초과 시 deep 패스가 인용 transcript 로부터 다시 작성하며 `distill-verify`(인용 세트 축소 금지)로 게이트. |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview --normalize` 가 경고를 내는 overview.md 글자 예산(엔트리포인트 비대 감시). |
| `LLMWIKI_L0_BUDGET` | `1600` | cold-start L0(current-state)의 글자 **기준**. 주입은 **자르지 않음** — 기준 초과 페이지도 전량 주입하고 초과 통지 1줄을 부착(다음 마감이 트리밍하도록); `oversized-l0` lint 는 1.25×부터 경고. |

각 tier 를 "그때그때 출시된 최상위 모델"로 올리거나, 비-Anthropic 모델/엔드포인트로 교체하면 된다.

**하네스 무관 읽기**: `bun <clone>/src/cli.ts context <repo>` 가 cold-start 컨텍스트를, `... turn-context <repo>`(훅 stdin JSON 또는 `--prompt`)가 턴별 관련 페이지 포인터(≤3줄, 확신 없으면 침묵)를 출력한다. Claude Code 는 두 훅(SessionStart·UserPromptSubmit)이 자동 배선되고, 최신 Codex 는 같은 훅 스크립트를 네이티브 훅으로 실행(`adapters/codex/`), OpenCode 는 1파일 플러그인(`adapters/opencode/`)이 주입한다. 그 밖의 하네스는 AGENTS.md·시작 프롬프트에서 같은 명령을 부르면 된다. 턴별 주입은 점진적 향상 — cold-start + `search` 기준선은 어디서나 동일하다.

## 팀 사용 (한 프로젝트의 위키 공유)

혼자 쓸 때는 아래 내용이 전혀 필요 없다 — 전부 추가적(additive)이고 1인 사용에서는 조용하다.

여러 사람이 한 프로젝트에서 작업할 때는 각자 자기 로컬 엔진(자기 캡처 데몬·큐)을 돌리고 **자기 세션만** 공유 `docs/wiki/` 에 정리해 넣는다. 공유는 순수 git. 엔진이 해주는 것:

- **스캐폴드 안전장치**: skeleton 이 `.gitignore`(`.llmwiki/` — 파생 인덱스는 커밋 금지)와 `.gitattributes`(`docs/wiki/log.md merge=union` — 동시 append 가 충돌 없이 병합)를 보장.
- **귀속**: 무인 작성 페이지에 `author:`(git `user.name`) 자동 스탬프. `0_review` 질문에 `owner: <이름>` 을 달면 cold-start 에 `[→ 이름]` 으로 표시 — 자기 것 아닌 질문은 건너뛸 수 있음.
- **팀원 인용**: 다른 머신의 transcript 를 인용한 각주는 자가치유된다 — 정상 형식의 `.jsonl` 인용은 index 재빌드 때 가상 소스로 자동 등록되므로(transcript 는 어차피 회전·소멸) 팀원의 인용이 내 `lint` 게이트를 깨지 않는다. 형식이 깨진 인용은 여전히 error.
- **연속성**: 클론이 origin 보다 뒤면 cold-start 가 한 줄로 알림(팀원이 병합한 맥락이 있을 수 있음 — 시작 전 pull).
- **리뷰 흐름**: 위키 커밋을 코드처럼 취급 — 같은 브랜치, 같은 PR. **PR 리뷰가 곧 AI 작성 페이지의 사람 승인 게이트**다. `gap-queue.md`/`overview.md` 가 충돌하면 아무 쪽이나 취한 뒤 `llmwiki gaps` / `llmwiki overview --normalize` 재실행(수렴함) — 생성된 본문을 손으로 병합하지 말 것.
- **`current-state.md`(L0) 충돌**: 아무 쪽을 취해도 안전하다 — 다음 `/wiki-update` 의 L0 갱신 단계가 위키 상태에서 Now/Next 를 재생성해 수렴한다. 단 **Next** 불릿만은 양쪽 합집합을 권장(액션 대기를 잃지 않기).
- **같은 `5_topic` 페이지 동시 추가 충돌**: **양쪽 불릿을 모두 보존**한다. 토픽 페이지는 포맷 규칙상 추가 전용(기존 줄 불변·병합은 추가만)이라, 합집합이 항상 옳은 병합이다.

## 팀 컨벤션 — `llmwiki.config.toml` (선택)

기본 카테고리 구조(`0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`)가 내장 기본값이다 — **config 파일이 없으면 아무것도 바뀌지 않는다(바이트 단위 동일** — 렌더된 프롬프트/규칙이 기존 텍스트와 같음을 테스트로 고정). 다른 팀 포맷을 쓰려면 `llmwiki.config.example.toml`을 클론 루트에 `llmwiki.config.toml`로 복사해 카테고리를 선언한다:

```toml
[[category]]
dir = "1_goal"     # docs/wiki 아래 폴더명
domain = "goal"    # 이 폴더로 라우팅되는 frontmatter domain
review = "human"   # human → 0_review 큐 · model → 강모델 확정
guide = "분기 목표. 변경은 사람이 확정."
```

- **단일 진실**: WRITE 프롬프트, cold-start 운영규칙, `llmwiki conventions <repo>`(`/wiki-*` 스킬이 위임하는 출력)가 전부 이 파일에서 렌더된다 — 드리프트할 산문 사본이 없다.
- **레포별 config** (선택): `<clone>/configs/` 아래 여러 `*.toml`을 둘 수 있다. 파일 상단에 `applies_to = ["<폴더>", ...]`가 있으면 그 폴더와 하위 전체에 적용(segment-safe prefix, 가장 구체적 경로 승리, `~` 확장); `applies_to`가 없으면 전 레포 기본값(표준 이름: `configs/default.toml`). 우선순위: named 매칭 → `configs/` default → 루트 `llmwiki.config.toml` → 내장 기본값. 매칭은 세션 훅이 넘기는 경로(`CLAUDE_PROJECT_DIR`/cwd) 기준.
- **확인**: `llmwiki config [workspace]` — 어느 파일이 왜 선택됐는지 표시 (검증 포함; 잘못된/못 읽는 파일은 경고와 함께 안전 폴백 — 세션을 깨지 않음).
- **기존 위키 구조 변경**: `llmwiki migrate <repo>` (dry-run) → `--commit`: 폴더 rename + 모든 위키링크/상대링크 재작성 + frontmatter `domain:` 갱신 + `.schema-version` 스탬프. **자동 실행 없음** — cold-start 는 드리프트를 양방향(위키가 내 config 보다 새것 / config 가 위키보다 새것)으로 감지·제안만 한다.
- **팀 배포**: config를 팀 엔진 포크에 커밋 → 각자 `git pull` → 1명이 `migrate` 실행 → 결과는 여느 변경처럼 PR로 병합.
- **호환성 규율**: config 키 제거는 폐기 유예 기간 + lint 경고 + `migrate` 스텝을 거친 뒤에만 — 조용한 제거 금지.

## 회귀 측정 (엔진 개발 도구 — 일상 루프 밖)

- **`llmwiki bench <repo>`** — 결정적 검색 벤치(LLM 0, ms 단위). 골든 질의셋 `<repo>/docs/wiki/.bench/golden.toml`(레포당 ≤20, 언어 무관) → search any-hit `r@k` + turn-context 포인터 적중/침묵(refusal 질의는 turn-context가 침묵하면 정답 — 구조 판정이라 언어 무관). seed 고정 tune/sealed split(`--tune-only`=반복 조정용 / `--sealed`=최종 확인 전용 — 볼 때마다 회귀 가드 가치가 줄어든다).
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 동결 corpus A/B: 같은 transcript corpus로 설정/리비전별 격리 임시 위키를 빌드(arm 빌드만 LLM)한 뒤, 라벨된 결과 2개를 순차 게이트(회귀 차단 우선 → keep/adopt/undecided, LLM 0)로 판정. 프롬프트·모델 변경 시에만 실행.

## 원칙
- transcript = raw 불변 (인용만, 위키→위키 재유도 금지). 증분 = watermark 이후만 처리.
- 사실=AI 자동 / 판단(결정 Why·What·Alt·방향성)=사람 (`status: draft` 플래그).
- git markdown = 단일 진실원. 커밋 = 단일 작성자 명의(저장소 소유자).
- 과적재 금지: <100k 토큰이면 vector DB·RAG 불필요 (index.md 내비게이션으로 충분).

## 라이선스
[Apache License 2.0](LICENSE) © 2026 suwonleee.
