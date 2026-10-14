# llmwiki — 사용 가이드

[빠른 시작](README.ko.md)

[다른 설치 방법](#다른-설치-방법) · [동작 방식](#동작-방식) · [효과가 있나?](#효과가-있나) · [설정](#설정) · [팀 사용](#팀-사용) · [업데이트](#업데이트) · [제거](#제거) · [이 머신에 남는 데이터](#이-머신에-남는-데이터) · [사전 요구사항](#사전-요구사항) · [문제 해결](#문제-해결) · [프로젝트 구조](#프로젝트-구조) · [회귀 측정 도구 (엔진 개발용)](#회귀-측정-도구-엔진-개발용) · [기여](#기여) · [원칙](#원칙) · [라이선스](#라이선스)

## 다른 설치 방법

### 플러그인 설치 (clone 없이)

이 저장소는 Claude Code / Codex 플러그인 마켓플레이스이기도 합니다.

```bash
# Claude Code
claude plugin marketplace add suwonleee/llmwiki
claude plugin install llmwiki@llmwiki

# Codex (설치 후 /hooks 에서 훅 2개를 한 번 승인)
codex plugin marketplace add https://github.com/suwonleee/llmwiki
codex plugin add llmwiki@llmwiki
```

- 플러그인에는 읽기 루프와 `/wiki-*` 스킬이 들어 있습니다.
- 백그라운드 캡처 데몬은 **clone 설치에만** 있습니다. 머신마다 한 가지 방법만 씁니다. clone 설치가 있으면 훅이 이를 감지하고 양보합니다.
- 저장소마다 등록합니다: 그 저장소의 세션에서 `/wiki-doctor`를 실행하거나 `bun <plugin-root>/src/cli.ts init <repo>`. 등록하지 않은 저장소에는 아무것도 주입하지 않습니다.
- Bun은 여전히 필요합니다. 없으면 세션 시작 시 한 번 알리고 조용히 있습니다.
- 비용: 세션마다 상시 로드되는 스킬 메타데이터 약 330토큰.
- 설치 전에 [플러그인 공개 사항](../PLUGIN.md), [개인정보 처리방침](../PRIVACY.md), [약관](../TERMS.md), [지원 안내](../SUPPORT.md)를 확인합니다.

### 수동 설치 대안

에이전트 없이 직접 설치할 때만 사용합니다. 하네스를 하나 고릅니다. `auto`는 감지된 모든 하네스를 배선합니다.

```bash
./setup.sh --harness claude
# 또는: ./setup.sh --harness codex
# 또는: ./setup.sh --harness opencode
```

- setup이 출력한 다음 명령을 그대로 사용
    - macOS·Linux·WSL2의 모든 하네스: 사용자 `llmwiki …`
    - 네이티브 Windows의 모든 하네스: 명시적 `bun <clone>/src/cli.ts …`; 선택형 `llmwiki` 런처는 Git Bash 전용이고 Codex/OpenCode는 PowerShell을 사용
- 출력된 수동 단계 완료
    - Codex만: `/hooks`에서 현재 llmwiki 훅 2개 검토·신뢰
    - OpenCode: 최초 설치 또는 clone 경로 변경 후 재시작
- 전체 분기·복구 기준: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)
- `./setup.sh --dry-run`은 파일·서비스를 바꾸지 않고 계획만 출력합니다.
- clone 위치와 폴더 이름은 자유입니다. 모든 훅·명령·서비스가 clone 위치에서 결정됩니다.
- clone을 옮기거나 업데이트한 뒤에는 setup을 다시 실행합니다. 여러 번 실행해도 안전합니다.
- 개별 단계: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` · `bun <clone>/src/daemon/wire.ts`(Claude) · `wire-codex.ts` / `wire-opencode.ts`. 각 wire 스크립트는 `--revert`로 자기 변경만 되돌립니다.

## 동작 방식

루프는 여섯 단계입니다. 둘은 자동이고, 나머지는 명령 하나씩입니다.

1. **캡처** (자동) — 백그라운드 데몬이 모든 세션 transcript를 큐에 넣습니다. 폴더·터미널과 무관합니다.
2. **업데이트** (`/wiki-save`) — 큐의 새 부분을 프로젝트의 로그층(`2_milestone`, `3_decision`, `4_insight`)에 덧붙입니다.
3. **통합** (`/wiki-save`, `/wiki-deep`) — 로그를 개념별 페이지(`5_topic/`)로 합칩니다.
4. **읽기** (자동) — 세션 시작 시 L0와 페이지 포인터, 프롬프트마다 관련 포인터·발췌 최대 3개, 규칙이 걸린 파일을 고치기 전에는 그 규칙(Claude Code).
5. **퀴즈** (`/wiki-quiz`) — 위키의 결정에서 뽑은 간격 반복 질문. 사람을 위한 단계입니다.
6. **자가치유** (`/wiki-save`, `/wiki-deep`) — `lint`가 구조를, `review`가 의미를 점검하고, `gaps`가 빠진 것을 추적합니다.

역할 분담:

- **사실** — AI가 무인으로 작성.
- **판단**(방향·결정·모순) — 항상 사람.
- **내 결정에 대한 내 기억** — `/wiki-quiz`로 유지.
- 페이지는 raw transcript에서만 만들고, 다른 위키 페이지에서 다시 만들지 않습니다.

transcript는 llmwiki가 아니라 에이전트의 파일입니다.

- 각 에이전트의 일정대로 순환합니다(Claude Code 약 30일, Codex는 끝난 세션을 `.zst`로 압축). llmwiki는 사본을 만들지 않습니다.
- 남길 세션은 사라지기 전에 `/wiki-save`로 마감합니다. transcript가 이미 없는 큐 행은 deep 패스가 정리합니다(`capture-prune`, 30일 가드).

[Andrej Karpathy: LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) · [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)

### 퀴즈 (`/wiki-quiz`)

다른 단계는 **모델**을 근거 위에 두고, 이 단계는 **사람**의 기억을 유지합니다. 판단력은 과거 결정에 대한 기억과 함께 흐려지기 때문입니다.

- **스케줄** — 엔진이 결정적으로 처리, LLM 없음.
    - 일 단위 망각곡선: 1·3·7·16·35·60일 박스.
    - 틀리거나 건너뛰면 1일로 돌아감. 같은 항목을 하루에 두 번 묻지 않음.
    - 우선순위: 방향 > 결정 > 인사이트·주제 > 마일스톤, 같은 급이면 최신 우선.
- **한 세션**
    - 엔진이 due 항목을 고르면, 에이전트가 그 페이지를 읽고 문제를 미리 전부 작성합니다. 다음 문제가 대기 없이 나옵니다.
    - 채점은 페이지에 근거한 요지 채점입니다. 틀린 문제는 다음 날 가장 먼저 나옵니다.
    - 문항 수: `llmwiki.config.toml`의 `[quiz] questions`. 기본 **3**, 실행마다 늘릴 수 있음(`/wiki-quiz 5`), 상한 **7**.
    - 질문이 뜨는 곳: Claude Code `AskUserQuestion`(호출당 4문) · OpenCode `question` · Codex `request_user_input`(호출당 3문, Plan 모드 밖에서는 `codex features enable default_mode_request_user_input` 실행 후에만). 그 밖에는 번호 블록 하나로 표시.
- **기록** — `docs/wiki/6_quiz/`(장부와 날짜별 노트). 사람 전용 폴더로, 인덱싱·검색·주입에서 제외됩니다.

### 근거가 페이지와 함께 이동 (페이지 포맷 v3)

`[^s1]: <세션>.jsonl` 같은 인용은 **한 대의 머신에만** 있는 transcript를 가리킵니다. 팀원은 결론은 읽어도 근거는 볼 수 없습니다. v3는 근거 1~2줄을 각주 아래에 함께 둡니다.

```markdown
- 로그층을 버리지 않고 그 위에 주제층을 얹기로 했다 [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "로그는 그대로 두고 그 위에 얹자. 교체는 위험하다"
```

- **포맷**
    - 각주 줄 자체는 바뀌지 않습니다. 이 줄을 읽는 파서가 넷입니다.
    - 발췌는 `llmwiki excerpt`로만 만듭니다: 원문 그대로, 길이 상한, 비밀정보 스크리닝.
    - 판단 주장은 사람의 말을, 사실 주장은 도구 실행 기록을 인용합니다.
- **페이지 본문**
    - 읽는 순서대로 번호 섹션(`## 1. <제목>`, `### 1-1. <제목>`). 짧은 페이지는 불릿 목록만으로 충분.
    - `-` 한 줄에 요점 하나, 뒷받침은 `    -`, 더 깊은 내용은 `        -`(4단계 없음).
    - 항목이 3개를 넘는 나열은 부모 한 줄 + 항목별 자식 불릿(lint: `dense-bullet`).
    - 자연스러운 곳은 짧은 명사형 어미. 부모나 제목을 되풀이하지 않음(섹션 없는 긴 페이지는 lint: `flat-body`).
- **lint**는 transcript를 읽을 수 있는 곳에서만 인용을 검증합니다. 다른 clone에서는 침묵합니다. "확인 불가"가 "틀림"으로 읽히면 안 되기 때문입니다.
- **검색**은 발췌를 무시하므로, 근거를 붙여도 검색 품질과 페이지 예산이 줄지 않습니다.

### Open Knowledge Format (OKF v0.2)

v0.14.0부터 새 위키에 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)를 적용했습니다. 타입이 있는 YAML 메타데이터, 출처, 상대 Markdown 링크, 폴더별 인덱스와 날짜별 로그를 갖춰 llmwiki 밖에서도 읽을 수 있습니다. 기존 위키는 사용자가 선택할 때만 변환합니다.

- 모든 페이지에 `type`(`Decision` · `Topic` · `Current State` …), `status`(`stable` · `draft` · `deprecated`), `generated: { by, at }`, 각주마다 `sources` 항목 하나.
- 링크는 `[[wikilink]]`가 아닌 상대 마크다운 링크.
- 폴더마다 생성되는 `index.md`. `log.md`는 날짜 그룹, 최신순(`llmwiki log-append`).
- 기존 위키 전환은 한 번, 사람이 결정: `llmwiki okf <repo>`(dry-run) → `--commit`. 적합성 확인은 `llmwiki okf --bundle docs/wiki`.
- 외부 리더로 확인: Google 레퍼런스 파서·뷰어, `W4G1/okf`, `okf-rs`, `okf-studio`가 오류 0으로 엽니다(한국어 파일명 포함).
- llmwiki 전용 필드는 확장 키 `x-llmwiki` 하나에 둡니다. 다른 리더는 무시하고, `llmwiki okf`는 보존합니다.

### 자가치유

위키가 무엇이 빠졌는지 보고하고, 사람은 판단만 채웁니다.

- `/wiki-save`·`/wiki-deep` 때:
    1. `lint`(결정적) — 구조: orphan·stale·dangling 페이지.
    2. `review`(생성적) — 의미: 모순·낡은 주장·개념 누락. 마감 시에는 주기가 됐을 때만 실행(`--if-due`, 기본 7일, `LLMWIKI_REVIEW_INTERVAL_DAYS`)하고 최근·관련 페이지만 봅니다. deep 패스는 항상 실행합니다.
    3. `gaps` — 개념 누락과 후속 질문을 `0_review/gap-queue.md`에 모읍니다.
- 갭은 누군가 그 주제로 작업하거나, deep 패스가 채우거나, `review`가 2회 연속 보고하지 않으면 닫힙니다.
- 빈약한 근거로 페이지를 지어내지 않습니다.

## 효과가 있나?

### 에이전트가 앞선 결정을 지키는가 — 통제 실험

위키를 쓰는 건 쉽고, 코딩 에이전트가 그걸 따르게 하는 건 어렵습니다. 실제 업무 레포 2개에서 실제 Claude Code 세션으로 쟀습니다(2026-10-13/14).

1. 한 세션이 대화로 프로젝트 규칙을 정하고 마감합니다.
2. 나중의 새 세션이 그 규칙이 걸린 다른 작업을 받습니다.
3. 블라인드 채점자가 변경이 규칙을 지켰는지 봅니다.

| 에이전트가 가진 것 | 앞선 결정을 지킨 비율 |
| --- | --- |
| 위키 없음 | — (Q&A: 정확도 0.57, 환각 23%) |
| 위키 (Q&A 질문) | 정확도 0.73–0.78, 환각 4–8% (480회) |
| 결정이 위키 페이지에만 있음 (코딩 작업) | **0/8** — 코딩 32회에서 에이전트는 위키 페이지를 한 번도 열지 않고 검색도 하지 않음 |
| 결정을 L0 "유효 규칙" 한 줄로 | **8/8** |
| 결정은 페이지에만, 편집 시점 + 프롬프트별 발췌로 전달 | **8/8** (발췌만 4/8, 편집 시점 gate만 7/8) |

그 결과 v0.14.0에서 바뀐 것:

- 사람이 정한 규칙은 구체적인 한 줄로 L0에 남고, 적용 경로가 태그됩니다(`x-llmwiki: { applies_to, rule, recall }`).
- 프롬프트별 블록은 제목만이 아니라 규칙 본문을 싣습니다.
- 해당 경로 파일을 고치려 하면(Edit 도구든 Bash 쓰기든) 편집 전에 규칙이 에이전트 앞에 놓입니다(Claude Code).

이 수치를 읽을 때 주의할 점:

- 표본이 작습니다: 레포 2개, 시나리오 4개, 조건별 8회, 채점 모델 1개.
- 과제는 뻔한 변경이 규칙을 어기도록 만들었습니다. 전달 방식이 동작한다는 근거이지, 여러분의 규칙이 얼마나 자주 중요한지에 대한 주장은 아닙니다.
- OKF 전환만으로는 답변 정확도가 바뀌지 않았습니다(+0.03, 오차 범위). 이득은 에이전트에게 실제로 닿는 내용에서 나옵니다.
- 새 사용자처럼 격리된 HOME에 새로 clone해 돌린 경우(`./setup.sh` → `llmwiki init` → 세션 → `/wiki-save` → 새 세션), 2/2 시나리오에서 규칙이 지켜졌습니다. 한 번은 편집 시점 gate로, 한 번은 프롬프트별 발췌를 보고 에이전트가 결정 페이지를 직접 열어서였습니다.

### 11주 동안 매일 써 본 결과

개발자 1명, 머신 1대, 레포 19개, 페이지 997개 — 2026-08-21 실측이며 추정치가 아닙니다. 엔진이 스스로 보고하는 수치이며, `llmwiki doctor` · `llmwiki bench` · `llmwiki downstream-read`로 본인 위키에서 확인할 수 있습니다.

| 관찰한 것 | 실측 | 왜 중요한가 |
| --- | --- | --- |
| 세션 비용이 위키 크기를 따라 늘지 않음 | 가장 큰 레포(236페이지)에서 세션 시작 주입 6.7KB | 포인터 수에 상한이 있고 비례하지 않음 |
| 검색이 빠르게 유지됨 | 같은 레포에서 검색 0.11초 · 프롬프트별 훅 0.16초 | 매 프롬프트마다 도는 루프 |
| 파생 데이터는 다시 만들기 쉬움 | 전량 재색인 6.9초 | 위키는 git의 마크다운이고, 인덱스는 버려도 되는 사본 |
| 로컬 상태가 무한히 늘지 않음 | 위키 19개 합쳐 167MB | 캡처가 하네스 자체의 보관 주기와 함께 만료 |
| 위키 하나를 여러 에이전트가 읽음 | 같은 레포에서 Codex·Claude Code 양쪽 열람 기록 | 에이전트를 바꿔도 지식이 처음부터 시작되지 않음 |
| 효과가 낮을 때도 측정함 | 포인터 열람률 2.1% | 가정하지 않고 보고. 같은 계기가 자기 표본 결함(54세션 중 5개만 읽고 낸 "0%")도 잡아냄 |

한 사람이 한 대의 머신에서, 본인이 쓰는 언어의 위키로 낸 수치입니다. 이 규모에서 엔진이 가볍고 정직하게 동작한다는 뜻이며, 팀 단위·다른 코퍼스·답변 품질에 대한 주장은 아닙니다.

### 릴리즈 검증 범위

- 모든 릴리즈 후보를 고정된 새 clone에서 검증합니다: Claude 훅, Codex 훅, OpenCode 플러그인 콜백, 등록, 캡처, 마감, 재시작, 다음 세션 검색.
- 검색 fixture가 생성 페이지 10·100·1,000개에서 정확성을 확인합니다.
- 문서화된 macOS·Linux·네이티브 Windows·WSL2 분기, 로컬 전용 데이터 경계, 공개 패키지에 들어가는 정확한 파일 목록을 확인합니다.
- 주장하지 않는 것: 실제 모델이 항상 좋은 페이지를 쓴다는 것, 처음 보는 사람이 도움 없이 흐름을 이해한다는 것. 사용성 연구는 사전 등록만 되어 있고 참가자 결과는 아직 없습니다.
- 정확한 경계: [릴리즈 게이트](../reference/RELEASE_GATES.md), [지원 계약](../reference/support-contract.json), [사용성 연구 프로토콜](../reference/USABILITY_STUDY.md).

## 설정

### 설정 파일 (`llmwiki.config.toml`)

아래 항목은 전부 파일 하나에서 바꿉니다. 엔진 코드는 그대로 둡니다.

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # 영어 · 주석 상세
```

| 설정 | 무엇이 바뀌나 |
|---|---|
| `[wiki] lang` | **엔진**이 쓰는 언어. 미지정이면 세션을 따름(기존 페이지 → 내가 입력한 말). `en` · `ko` · `ja` · `zh`로 고정 가능. 페이지 언어는 항상 대화 언어 |
| `[[category]]` | 위키 폴더 구성과 각 폴더에 담을 내용 |
| `[quiz] questions` | 퀴즈 한 번의 문항 수. `5_topic` · `0_review` · `6_quiz` 폴더는 고정 |
| `[private] dirs` | 나에게는 인덱싱되지만 커밋되지 않는 폴더 |
| `[models]` | 초안 모델(`light`)과 검증 모델(`heavy`) |
| `legacy_dirs` | 이름을 바꾼 뒤에도 계속 훑을 옛 폴더. 핵심 파일(`current-state` · `overview` · `log`)은 고정 |
| `[lint.banned_terms]` | 경고할 표현(권고만, 차단 없음) |

- 가장 쉬운 방법: 원하는 것을 에이전트에게 말하고 `llmwiki.config.toml`만 고치게 합니다. 결과는 `llmwiki config <프로젝트-경로>`로 확인합니다.
- 기존 페이지는 명시적으로 승인하기 전에는 이관하지 않습니다.

### 환경 변수

생성 패스(`autoupdate`, `review`)는 **켜기 전까지 꺼져 있습니다.**

- 아무 설정이 없으면 llmwiki는 서브프로세스를 띄우지 않고, 어떤 provider에도 아무것도 보내지 않습니다.
- 머신 환경에 `LLMWIKI_LLM_CMD`를 설정하는 것이 1회성 opt-in입니다. 저장소 설정·마크다운·추적 파일·자동 로드되는 `.env`로는 켤 수 없습니다.
- 켠 뒤에도 transcript·페이지에서 나온 모든 블록은 프롬프트에 들어가기 전에 비밀정보 스크리닝을 거칩니다. 스크리닝 후 남는 게 없으면 호출을 취소합니다.

| env | 기본값 | 용도 |
|---|---|---|
| `LLMWIKI_LLM_CMD` | **미설정 — 서브프로세스·네트워크 없음** | LLM 호출 명령 템플릿. `{prompt}`·`{model}`을 토큰 단위로 치환(셸 파싱 없음). `{prompt}`가 없으면 stdin으로 전달. 따옴표가 필요한 여러 단어 값은 JSON 배열(`["my-llm","--q","{prompt}"]`). 어떤 CLI든 가능(Codex, `llm`, ollama…) |
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | 추론 tier — VERIFY와 `review` |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | 초안 tier — WRITE(페이지 생성) |
| `CLAUDE_CONFIG_DIR` | (Claude Code 표준) | 배선·캡처·doctor가 이 디렉터리도 Claude 프로필로 인식 |
| `LLMWIKI_STATE_DIR` | `$XDG_DATA_HOME/llmwiki` (또는 기존 `<clone>/.state`) | 머신 로컬 상태 경로. 저장소 `.env`로는 바꿀 수 없음. 사용자 지정 경로는 새 경로·빈 경로·이미 llmwiki 소유인 경로만 허용 |
| `LLMWIKI_LANG` | `en` | 세션 시작 규칙·헤더 언어(`ko`면 한국어). 위키 본문은 바뀌지 않음 |
| `LLMWIKI_SEARCH_RELAX` | (on) | `off`면 0건 질의를 OR로 한 번 재시도하는 폴백을 끔. A/B 측정용 |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144` (256KB) | 소스 파일당 크기 상한. 넘는 파일은 이름으로만 검색됨. 위키 페이지는 예외 |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | `review` 1회 입력 상한. 더 큰 위키는 최근·태그 관련 페이지만 검토 |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due`는 마지막 review 후 이 일수가 지나야 실행. 그 전에는 ~0.03초에 건너뜀 |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` 페이지 글자 예산(`topic-oversize`, 권고). 넘으면 deep 패스가 출처에서 다시 작성하고 `distill-verify`로 확인(인용이 줄면 안 됨) |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview`가 경고하는 글자 예산(`--check`는 쓰지 않고 미리보기) |
| `LLMWIKI_L0_BUDGET` | `1600` | L0(`current-state`) 글자 **기준**. 주입은 자르지 않음: 긴 페이지도 전부 주입하고 한 줄 알림을 붙임. `oversized-l0` lint는 1.25×부터 경고 |

- 각 tier를 최신 상위 모델이나 비-Anthropic 모델·엔드포인트로 바꿀 수 있습니다.

읽기는 어느 하네스에서든 동작합니다.

- `bun <clone>/src/cli.ts context <repo>`는 세션 시작 컨텍스트를 출력합니다. `… turn-context <repo>`(훅 stdin JSON 또는 `--prompt`)는 관련 포인터를 최대 3개 출력하고, 확신이 없으면 침묵합니다.
- Claude Code는 두 훅을 자동 배선합니다. 최신 Codex는 같은 훅 스크립트를 네이티브로 실행합니다(`adapters/codex/`). OpenCode는 파일 하나짜리 플러그인으로 주입합니다(`adapters/opencode/`).
- 그 밖의 하네스는 AGENTS.md나 시작 프롬프트에서 같은 명령을 부르면 됩니다.
- 프롬프트별 주입은 추가 기능입니다. 세션 시작 컨텍스트와 `search`는 어디서나 같습니다.
- 읽기 루프는 어떤 포인터가 실제로 열렸는지 학습하고, 이를 **순서 조정에만** 씁니다. 텍스트는 늘리지 않습니다.
    - 데몬이 하루 한 번 방출 기록과 하네스별 열람 기록을 프로젝트별 `affinity.json`으로 모읍니다.
    - 2일 이상, 8개 이상 세션에서 노출되고 한 번도 안 열린 페이지는 자리를 내줄 수 있습니다. 2일 이상, 2개 이상 세션에서 열린 페이지는 위로 올라갈 수 있습니다.
    - 세션 시작 시 제한: 최신 2개는 고정, 최근 6칸 중 최대 2칸과 spine 1칸만 변경. 프롬프트별: 관련도 2점 차를 뒤집지 못하는 작은 보정.
    - 포인터로 노출된 뒤 수정된 페이지는 처음부터 다시 셉니다(mtime 기준이라 `git checkout`/`pull`도 초기화).
    - 파일이 없으면 기존 순서 그대로. 수동 갱신: `llmwiki downstream-read <repo> --refresh-affinity`.

### 인덱스 유지보수

- `/wiki-save`는 `llmwiki db-health <repo> --notice`만 호출합니다. 쿨다운이 걸린 상태 신호를 기록하고 `/wiki-deep`을 권할 수 있을 뿐, SQLite compact나 페이지 정리는 하지 않습니다.
- `/wiki-deep`은 인덱스와 lint를 먼저 갱신하고, `db-health`가 자격을 표시했을 때만 compact한 뒤 다시 확인합니다.
- **compact 후에도** 라이브 인덱스가 30 MiB를 넘을 때만 수동·dry-run인 `llmwiki wiki-clean <repo>`를 권합니다.
- 고정 기본값(아직 환경 변수 오버라이드 없음):
    - compact 조건은 셋 모두: DB **30 MiB**, free-page 비율 **10%**, free-page **1 MiB** 이상.
    - 알림은 **7일** 쿨다운. 자격이 바뀌거나 인덱스가 10% 늘면 해제.
    - 정리 분류기는 **180일** 지난 페이지만 후보로 봅니다. gap 리포트는 최근 해소 **20건**을 보존합니다.
- `wiki-clean --date YYYY-MM-DD`는 리뷰 날짜만 고정합니다. `wiki-clean --commit`도 `wiki-clean-apply`도 save/deep 자동화에 포함되지 않습니다.

## 팀 사용

### 한 프로젝트의 위키 공유

혼자 쓸 때는 필요 없습니다. 아래 내용은 모두 추가적이며, 1인 사용에서는 조용합니다.

각자 자기 엔진(자기 데몬·큐)을 돌리고, **자기 세션만** 공유 `docs/wiki/`에 기록합니다. 공유는 순수 git입니다.

- **안전한 스캐폴드**
    - `.gitignore`에 `.llmwiki/`를 넣어, 이전 엔진이 만든 인덱스가 커밋되지 않게 합니다.
    - `.gitattributes`가 `docs/wiki/log.md`와 `docs/wiki/**/index.md`에 `merge=union`을 설정해, 동시 추가가 충돌 없이 합쳐집니다.
- **작성자**
    - 작성자 정보는 frontmatter의 `author:`에 저장하지 않고 `.mailmap`을 반영한 git 이력에서 계산합니다.
    - `0_review` 질문에는 `owner: <GitHub login>`이 붙습니다. 세션 시작 시 `[→ login]`으로 보여, 다른 사람은 건너뛸 수 있습니다.
- **팀원 인용**
    - 인덱스를 다시 만들 때, 형식이 올바른 `.jsonl` 인용은 모두 가상 소스로 등록됩니다.
    - 팀원의 인용이 내 `lint`를 깨지 않습니다. 형식이 깨진 인용은 여전히 오류입니다.
- **최신 유지** — clone이 origin보다 뒤처지면 세션 시작 시 한 줄로 알립니다. 시작 전에 pull합니다.
- **리뷰** — 위키 커밋은 코드와 같은 브랜치·PR로 갑니다. PR 리뷰가 AI 작성 페이지에 대한 사람의 확인입니다.
- **병합 충돌**
    - `gap-queue.md` / `overview.md`: 아무 쪽이나 고른 뒤 `llmwiki gaps` / `llmwiki overview`를 다시 실행. 손으로 병합하지 않습니다.
    - `current-state.md`(L0): 어느 쪽이든 안전합니다. 다음 `/wiki-save`가 다시 만듭니다. 양쪽 **Next** 불릿은 합집합으로 남깁니다.
    - 같은 `5_topic` 페이지: **양쪽 불릿 모두 보존**. 주제 페이지는 늘어나기만 하므로 합집합이 항상 맞습니다.

### 팀 컨벤션 (`llmwiki.config.toml`, 선택)

기본 폴더는 `0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`입니다. **설정 파일이 없으면 아무것도 바뀌지 않습니다.** 렌더된 프롬프트와 규칙이 바이트 단위로 같음을 테스트가 고정합니다.

다른 팀 포맷을 쓰려면 `llmwiki.config.example.toml`을 clone 루트에 `llmwiki.config.toml`로 복사하고 카테고리를 선언합니다.

```toml
[[category]]
dir = "1_goal"     # docs/wiki 아래 폴더명
domain = "goal"    # 카테고리 슬러그 — 이 폴더 페이지는 `type: Goal`
review = "human"   # human → 0_review 큐 · model → 강모델 확정
guide = "분기 목표. 변경은 사람이 확정."
```

- **한 곳에서 관리** — WRITE 프롬프트, 세션 시작 규칙, `llmwiki conventions <repo>`(`/wiki-*` 스킬이 사용)가 모두 이 파일에서 만들어집니다.
- **레포별 설정** (선택)
    - `<clone>/configs/` 아래에 `*.toml` 여러 개를 둡니다. `applies_to = ["<폴더>", …]`가 있는 파일은 그 폴더와 하위 전체에 적용됩니다(가장 구체적인 경로 우선, `~` 확장).
    - `applies_to`가 없는 파일은 모든 레포의 기본값입니다(`configs/default.toml`, `configs/default.toml.example`로 제공).
    - 우선순위: 이름 매칭 → `configs/` 기본값 → 루트 `llmwiki.config.toml` → 내장 기본값. 매칭은 세션 훅이 넘기는 경로(`CLAUDE_PROJECT_DIR`/cwd) 기준.
- **확인** — `llmwiki config [workspace]`가 어느 파일이 왜 선택됐는지 보여줍니다. 잘못된 파일은 경고와 함께 안전하게 폴백합니다.
- **기존 위키 구조 변경** — `llmwiki migrate <repo>`(dry-run) → `--commit`.
    - 폴더 이름 변경, 링크 재작성, `domain:` 갱신, `.schema-version` 기록.
    - 자동 실행은 없습니다. 어느 방향의 드리프트든 세션 시작·`llmwiki doctor`·`/wiki-deep` · `/wiki-doctor` 사전 점검에서 알립니다. 적용은 항상 명시적 `--commit`.
- **배포** — 설정을 팀 엔진 포크에 커밋 → 각자 `git pull` → 한 명이 `migrate` 실행 → 결과는 PR로 병합. `configs/*.toml`은 기본 gitignore 대상이라 팀 설정은 `git add -f configs/<team>.toml`로 추적합니다. 루트 `llmwiki.config.toml`은 그냥 커밋됩니다.
- **호환성** — 설정 키는 폐기 유예 기간, lint 경고, `migrate` 단계를 거친 뒤에만 제거합니다.

## 업데이트

업데이트는 수동입니다. 엔진이 스스로를 갱신하지 않습니다.

- 데몬이 하루 한 번 origin을 확인합니다. 새 버전이 있으면 다음 세션 시작 시 한 줄 알림과 정확한 명령이 표시됩니다.
- 알림은 에이전트만이 아니라 **사용자에게** 보입니다: Claude Code·Codex는 훅 시스템 메시지, OpenCode는 토스트, 모든 `llmwiki` 명령은 stderr에 한 번 출력합니다.
- 버전 번호는 같지만 origin 코드가 더 새로운 경우도 알립니다.

```bash
cd ~/llmwiki
git pull && ./setup.sh          # pull 만으로는 부족합니다 — 아래 참고
```

`git pull`은 clone만 바꿉니다. 데몬은 시작할 때의 코드로 계속 돌고, OpenCode 플러그인은 설정 디렉터리에 있는 사본입니다. `setup.sh`를 다시 실행하면 이것들을 새 코드로 맞추고 데몬도 재시작합니다. 여러 번 실행해도 안전합니다.

`llmwiki doctor`가 뒤처진 것을 알려줍니다.

- `[update] ⚠️ v… → v… available` — clone이 `origin`보다 뒤처짐.
- `[update] ⚠️ N commit(s) behind origin at the same version` — 버전 번호는 같지만 origin에 새 코드가 있음.
- `[update] ⚠️ clone files changed after the last successful install` — `git pull`은 했지만 setup이 설치된 구성요소와 데몬을 아직 갱신하지 않음. setup이 성공하면 사라짐.
- `[daemon] ⚠️ running code older than this clone` — 데몬이 pull 이전 코드로 돌고 있음. `llmwiki daemon-sync`가 실제로 뒤처졌을 때만 재시작하고, `llmwiki doctor --fix`도 전체 점검 안에서 같은 일을 합니다. 직접 부를 일은 드뭅니다: `/wiki-save`와 `/wiki-deep`이 마지막 단계로 `daemon-sync`를 실행합니다.
- `[opencode] ⚠️ plugin stale` — 설치된 플러그인 사본이 clone의 어댑터보다 오래됨.

## 제거

```bash
cd ~/llmwiki
./setup.sh --uninstall                 # llmwiki가 설치한 훅·플러그인·커맨드·런처·서비스 전부 제거
./setup.sh --uninstall --purge-data    # 로컬 런타임 상태까지 삭제
```

- clone을 옮기거나 지우기 **전에**, 설치된 clone에서 실행합니다.
- 백업 복원이 아니라 소유권 기준으로 제거합니다. llmwiki가 설치한 항목만 지우고, 하네스 설정의 나머지(그 사이 직접 추가한 훅 포함)는 그대로 둡니다.
- 위키는 건드리지 않습니다. `docs/wiki/`는 내 저장소의 일반 마크다운입니다.
- `--purge-data` 없이는 로컬 상태를 남기고 위치만 알려줍니다. `--purge-data`는 llmwiki가 만든 것만 지웁니다.
- 각 저장소 `.git/llmwiki/`의 등록 표식은 엔진 없이는 아무 일도 하지 않습니다. 개별 해제는 `llmwiki disable <repo>`.

## 이 머신에 남는 데이터

| 무엇 | 위치 | 보존 |
|---|---|---|
| 캡처 큐(어느 저장소에서 언제 작업했는지 — 메타데이터만) | `<state>/capture.db` | `--purge-data`까지 |
| 데몬 로그(집계 수치만, 미등록 프로젝트 경로는 기록 안 함) | `<state>/daemon.log` | `--purge-data`까지 |
| OpenCode transcript 내보내기(대화 본문 — llmwiki가 보관하는 유일한 본문) | `<state>/opencode-export/` | **30일 후 자동 삭제** |
| 프로젝트별 인덱스·캐시(재생성 가능) | `<state>/projects/<id>/` | 압축, 60일 미사용 시 삭제 |

- `<state>`의 기본값은 `$XDG_DATA_HOME/llmwiki`입니다. 이전 설치의 `<clone>/.state`가 있으면 계속 쓰며, `llmwiki migrate-state`로 옮길 수 있습니다.
- 상태 디렉터리와 그 안의 파일은 비공개 권한(`0700` / `0600`)으로 만듭니다.
- Claude·Codex transcript는 하네스 저장소에서 그 자리로 읽을 뿐, 사본을 만들지 않습니다.
- 저장 위치 셋, 각자 주인 하나:
    - 캡처 큐 — 중앙, `<state>` 아래
    - 콘텐츠 — 각 저장소의 `docs/wiki/`(마크다운이 원본)
    - 인덱스 — `<state>` 아래 프로젝트별 디렉터리(`llmwiki state-path <repo>`). 언제든 재생성 가능하므로 저장소에는 `docs/wiki/`만 남습니다

## 사전 요구사항

플랫폼·런타임·CI·개인정보에 대한 기계 판독용 계약은 [`reference/support-contract.json`](../reference/support-contract.json)입니다.

| | 필요 | 비고 |
|---|---|---|
| **Bun ≥ 1.2.21** | ✔ 필수 | 단일 바이너리. POSIX: `curl -fsSL https://bun.sh/install \| bash`. 네이티브 Windows는 PowerShell에서 `irm bun.sh/install.ps1 \| iex`. `.ts`를 그대로 실행하고 `bun:sqlite`에 FTS5 포함 — 빌드·`node_modules` 없음. `bun run typecheck`만 `bun install` 1회 필요(개발용). |
| **git** | ✔ 필수 | 캡처가 디렉터리가 워크트리인지 git에 묻습니다. setup은 `PATH` 밖(Homebrew·MacPorts·Nix·`~/.local/bin`)도 찾고, 없으면 아무것도 바꾸기 전에 멈춥니다. `llmwiki doctor`가 `[deps]`에 경로를 보고합니다. |
| **Codex · OpenCode CLI** | 해당 하네스에만 | `codex` / `opencode`가 `PATH`에 있어야 합니다. Codex는 lifecycle hook 지원과 stable `hooks` 기능 활성화도 필요합니다. setup이 훅·스킬·서비스를 바꾸기 전에 확인합니다. |
| **LLM CLI** | 선택, 명시적 활성화 | 캡처·읽기 주입·`/wiki-*`·`ingest`(캡처만)는 없어도 동작하고, **기본 상태에서는 아무것도 보내지 않습니다**. `autoupdate`·`review`와 `ingest`의 통합 단계는 셸에 `LLMWIKI_LLM_CMD`를 설정했을 때만 서브프로세스를 띄웁니다(예: `export LLMWIKI_LLM_CMD='claude -p {prompt} --model {model} --tools= --permission-mode dontAsk --strict-mcp-config --safe-mode --no-session-persistence'`). 미설정이면 해당 패스는 "unavailable"을 보고하고 건너뜁니다. |
| **OS** | macOS / Linux / Windows | 데몬과 무인 업데이트: macOS = launchd, Linux = systemd(`--user`), 없으면 cron+nohup, Windows = 사용자별 시작프로그램 폴더. macOS·Linux는 CI에서 전체 스위트를 돌리고, Windows는 플랫폼 계약 작업을 돌리며 나머지는 수동 검증합니다. 세부: [`daemon/README.md`](../daemon/README.md) |

### 하네스 · OS 노트

- **Claude Code** — `./setup.sh --harness claude`. 캡처·읽기 주입·`/wiki-*` 커맨드가 자동 배선됩니다.
- **Codex** — `./setup.sh --harness codex`
    - 사용자 CLI와 `$wiki-*` 스킬 5개를 설치하고, `$CODEX_HOME/hooks.json`에 `SessionStart`/`UserPromptSubmit` 훅을 병합합니다.
    - 최초 1회: Codex를 시작해 `/hooks`에서 정확한 명령을 검토합니다. 새 훅·바뀐 훅은 신뢰 전까지 실행되지 않습니다.
    - 캡처는 `$CODEX_HOME/sessions/**/*.jsonl[.zst]`를 감시합니다.
    - Codex Desktop의 자체 홈(런타임·계정별)도 함께 수집합니다. 같은 rollout이 여러 홈에 하드링크돼도 큐에는 **한 행**으로 남고 두 번 기록되지 않습니다.
    - 스킬은 Codex 자체로 동작합니다. 무인 `autoupdate`/`review`는 `LLMWIKI_LLM_CMD`를 설정한 경우에만 동작합니다.
- **OpenCode** — `./setup.sh --harness opencode`
    - 전역 `/wiki-*` 커맨드, clone 경로가 고정된 읽기 주입 플러그인, 사용자 CLI를 설치합니다.
    - 캡처는 OpenCode의 SQLite 세션 저장소를 읽습니다. `XDG_DATA_HOME`/`OPENCODE_DB`는 데몬 환경에 유지됩니다.
- **Windows** — 네이티브와 WSL2 모두 지원합니다.
    - WSL2에서는 모두 수정 없이 동작합니다. Claude Code·Codex의 공식 권장과도 같습니다.
    - Bun·`bun:sqlite`는 네이티브로 동작합니다(FTS5 trigram 포함). 경로 매칭은 backslash를 정규화합니다.
    - 네이티브: Bun과 Git을 설치한 뒤 Git Bash에서 `./setup.sh --harness claude`(또는 `all`). 훅 스크립트는 Windows `PATH`에 `bash`가 없어도 Claude Code가 직접 실행합니다.
    - Codex와 OpenCode는 셸 명령을 PowerShell로 넘기고, `bash`는 Windows `PATH`에 없습니다. 그래서 Windows에서는 두 하네스의 훅과 스킬이 `bun <clone>/src/cli.ts`를 직접 부릅니다 — 인터프리터도 `PATH` 등록도 필요 없습니다.
    - `~/.local/bin`의 `llmwiki` 런처는 `#!/bin/sh` 스크립트입니다. Git Bash에서만 쓸 수 있고(해당 폴더를 `PATH`에 직접 추가), PowerShell·`cmd`에서는 못 씁니다. 하네스가 설치하는 것들은 이 런처에 의존하지 않습니다.
    - 캡처 데몬은 사용자별 **시작프로그램 폴더**에 등록되어 창 없이 실행됩니다. 관리자 권한이 필요 없습니다(Task Scheduler 로그온 항목은 권한이 필요).
    - 로그온 시 시작하고, 크래시 시 자동 재시작은 **없습니다**(Linux `cron @reboot` 폴백과 같음). `llmwiki doctor`는 "로그온 시 시작"과 "실행 중"을 따로 보고합니다.

## 문제 해결

doctor는 둘이고, 하는 일이 다릅니다.

- `llmwiki doctor` — 설치 점검: 엔진 파일·데몬·훅·설치된 스킬·사용자 CLI. `--fix`는 배선을 복구합니다.
- `llmwiki wiki-doctor <repo>` — 한 프로젝트의 `docs/wiki/` 점검, 기본은 읽기 전용: 구조·인덱스 신선도·SQLite 상태·lint·캡처 연속성·gap 큐·review 주기. `--fix`는 안전한 파생 상태만 다시 만듭니다.
- `/wiki-doctor`(Codex: `$wiki-doctor`) — 전체 복구. 엔진 복구 후, 에이전트가 lint·review 근거를 읽고 페이지 내용을 고칩니다. 출처를 지우거나 프로젝트 방향을 지어내지는 않습니다.

에이전트 데이터가 예상 위치에 없을 때:

- 기본 위치가 비어 있으면 흔한 대안도 찾습니다: WSL의 `/mnt/c/Users/*` 아래 마운트된 Windows 프로필, XDG 변형, `~/.opencode`, Codex Desktop의 계정별 홈.
- 후보마다 스키마로 검증합니다. **내 홈 안에서** 검증된 후보가 하나뿐이면 묻지 않고 연결합니다.
- 홈 밖의 경로는 자동 연결하지 않습니다(마운트된 Windows 프로필은 다른 사람 것인 경우가 많음). 대신 정확한 `llmwiki connect` 명령을 알려줍니다.
- 명시적으로 지정한 `CODEX_HOME`은 그것만 씁니다. 단, Codex Desktop 자체 홈인 경우는 예외입니다(앱이 자기 터미널에 export하기 때문).
- `llmwiki locate <harness>`는 무엇을 찾았는지 보여줍니다. 진행할 수 없으면 무엇을 시도했는지, 무엇이 막았는지, 선택지를 출력합니다.
- `llmwiki connect <harness> <path>`는 검증을 통과한 경로만 기록합니다.

기타 신호:

- 마감 추출 헤더의 `# ⚠ route:` — 세션의 편집이 다른 등록 저장소로 갔다는 뜻입니다. 기록은 그 위키로 보내집니다.
- 셸에 `llmwiki` 런처 경로가 없으면 setup이 `PATH` 명령을 한 번 출력합니다.

## 프로젝트 구조

```
setup.sh       원클릭 온보딩 (경로 무관: doctor→데몬→훅·커맨드→인덱스)
src/           TypeScript 엔진 (Bun 런타임, bun:sqlite 내장 — node_modules·빌드 없음)
  cli.ts       CLI 디스패처 — 서브커맨드 40여 개: init·status·disable·index·search·lint·doctor·wiki-doctor·db-health·daemon-sync·wiki-clean·locate·connect·save-current·update-*·quiz-*·autoupdate·consolidate·review·gaps·overview·ingest·bench·… (전체 목록: 이 파일 하단의 HANDLERS)
  engine/
    schema.sql   레포별 인덱스 스키마 (documents·chunks·FTS5·references)
    db.ts        WikiIndex: 인덱싱(content_hash 증분)·검색·그래프·staleness
    chunker.ts   FTS 청킹 (~512토큰)         refs.ts    인용·링크 → 그래프 엣지
    lint.ts      구조 점검 (결정적)          review.ts  의미 lint (생성적·범위 한정·캐시)
    gaps.ts      review 갭 → 자가종료 큐 0_review/gap-queue.md (LLM 없음)
    quiz.ts      퀴즈 스케줄링 + 6_quiz/quiz-ledger.md (LLM 없음; 출제·채점은 /wiki-quiz)
    overview.ts  overview 진입점 정규화 (LLM 없음·멱등)
    synthesis.ts 결정적 주제 뷰 (태그 클러스터·통합 갭) — LLM 없음·재생성 가능
    extract.ts   transcript 증분 추출 (watermark)   update.ts  로그층 오케스트레이션
    autoupdate.ts  무인 사실 업데이트 (write→2차 검증→lint 게이트)
    consolidate.ts 로그→주제 페이지(5_topic) 통합 (write→독립 VERIFY→grounding→lint)
    source.ts    transcript 소스 추상화 (하네스 무관)
    sources/     claude.ts · codex.ts(.zst 포함) · opencode.ts(SQLite→export) · plain.ts(임의 파일)
    ingest.ts    데몬 없이 파일 1개 업데이트 (`llmwiki ingest`)
    capture.ts   중앙 캡처 큐 (source_kind)   doctor.ts   배선 점검
    config.ts    팀 컨벤션 — llmwiki.config.toml + configs/*.toml resolver
    migrate.ts   위키를 config 구조로 이관 (dry-run 기본·링크 재작성·드리프트 감지)
  daemon/
    watch.ts     캡처 데몬 (모든 소스 스윕)
    wire.ts      Claude 훅·커맨드 배선 (~/.claude* + $CLAUDE_CONFIG_DIR)
    wire-codex.ts Codex 훅 병합 + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCode 전역 플러그인 + /wiki-* + 공유 CLI
    list-pending-repos.ts  큐에서 pending 레포만 출력 (스케줄러용)
daemon/        install.sh (launchd/systemd/cron 자동 감지) + autoupdate-*.sh (무인 사실 패스)
hooks/         sessionstart-inject.sh (세션 시작) · userpromptsubmit-inject.sh (프롬프트별) · pretooluse-inject.sh (편집 시점 규칙)
adapters/      codex/ (hooks.json 템플릿) · opencode/ (플러그인 1파일)
skill/         wiki-save · wiki-deep · wiki-doctor · wiki-ask · wiki-quiz (/커맨드)
examples/      sample-wiki/ — 완성된 위키 예시. 인덱싱 안 됨. 복사하지 말 것 — 실제 위키는 각 프로젝트 docs/wiki에 생성됨. examples/README.ko.md 참조
tests/         bun:test 스위트 — `bun test`
package.json·tsconfig.json   Bun 메타데이터 (typecheck용; 런타임은 .ts 직접 실행)
```

## 회귀 측정 도구 (엔진 개발용)

일상 루프에는 쓰지 않습니다.

- **`llmwiki bench <repo>`** — 결정적 검색 벤치마크(LLM 없음, ms 단위).
    - 골든 질의: `<repo>/docs/wiki/.bench/golden.toml`(레포당 ≤20, 언어 무관).
    - search any-hit `r@k`와 프롬프트별 포인터 적중을 채점. 거절 질의는 프롬프트별 훅이 침묵하면 정답.
    - seed 고정 tune/sealed 분리: `--tune-only`는 반복용, `--sealed`는 최종 확인용(볼 때마다 가치가 줄어듦).
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 동결 corpus A/B.
    - 같은 transcript로 설정별 격리 임시 위키를 만듭니다. LLM은 이 빌드에만 씁니다.
    - 판정 전에 두 리포트를 검증합니다. 형식이 깨졌거나 호환되지 않으면 `keep`.
    - 순서 있는 게이트로 판정: 회귀 차단 먼저, 그다음 keep / adopt / undecided. LLM 없음.
    - 프롬프트·모델이 바뀔 때만 실행합니다.
- **`llmwiki bench-scale --repeats 2`** — 생성 corpus 규모 리포트.
    - 10/100/1000페이지 단계를 돌리고 검색·컨텍스트 정확성을 확인합니다.
    - 시간·디스크 수치는 관찰값이며 릴리즈 기준이 아닙니다.
- **`llmwiki bench-capture --repeats 2 [--sessions 100,1000,10000]`** — 과거 세션 규모 리포트.
    - Claude·Codex·OpenCode 탐색과 제한된 샘플 생성을 비교합니다.
    - 가벼운 훅 진입점(세션 시작·빈 프롬프트·등록 확인)을 측정하고, 전체 CLI 시작은 따로 보고합니다.
    - 개수는 결정적이고, 시간은 관찰값입니다.

재현 가능한 전체 명령과 각 결과가 허용하는 주장: [`reference/RELEASE_GATES.md`](../reference/RELEASE_GATES.md).

## 기여

- [CONTRIBUTING.md](../CONTRIBUTING.md)에서 시작합니다: 깨끗한 clone 기준 작업 흐름과 점검.
- [ARCHITECTURE.md](../ARCHITECTURE.md)에서 변경을 맡는 모듈과 안전 경계를 찾습니다.
- 작업 중에는 `bun run check:quick`, 리뷰 전에는 `bun run check`.

## 원칙

- transcript는 원본이며 바꾸지 않습니다. 페이지는 이를 인용만 하고, 다른 페이지에서 다시 만들지 않습니다. 업데이트는 watermark 이후만 처리합니다.
- 사실은 AI가 씁니다. 판단(결정의 이유·내용·대안, 방향)은 사람의 몫입니다. AI 제안은 사람이 확인할 때까지 `status: draft`로 남습니다.
- git 마크다운이 유일한 원본입니다. 커밋은 한 사람(저장소 소유자) 명의로 합니다.
- 과설계하지 않습니다. 100k 토큰 미만이면 벡터 DB·RAG 없이 `index.md` 탐색으로 충분합니다.
- 쓸수록 컨텍스트가 무거워지면 안 됩니다. 주입 예산에는 상한이 있습니다. `/wiki-*` 스킬은 절차만 상시 로드하고(`/wiki-save` ≤ 15KB) 세부 내용은 필요한 단계에서 불러옵니다(`llmwiki conventions <repo> --section <name>`). 읽기 루프는 텍스트를 늘리지 않고 사용 기록으로 순서만 바꿉니다.

## 라이선스

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
