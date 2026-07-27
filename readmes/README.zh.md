<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki — 本地轻量运行、复利增长的项目 wiki，佐以一份反过来考你的测验

*别名: quiz wiki · llmwiki quiz · Quiz_wiki — 用间隔重复（spaced repetition）反问你自己过往决定的记忆层。*

[English](../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文**

无论什么项目、什么终端（默认/tmux/iTerm2）、哪个编码智能体（Claude Code · Codex · OpenCode），项目专属的 LLM 知识都不会蒸发，而是**以复利累积**。

## 你需要做的，只有这些

如果已经安装 Git、[Bun](https://bun.sh) 和任意一个编码智能体，剩下的只有一次 clone 和一段提示词。

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

以上命令会安装当前公开版本。如果需要可复现的部署，请在setup之前到
[Releases页面](https://github.com/suwonleee/llmwiki/releases)选择一个发布标签。更新始终由你手动执行。
移动或删除此目录前，请先卸载（见下文），因为已安装的钩子会指向这个路径。

在这个目录中只启动**一个**智能体。

```bash
claude
# 或: codex
# 或: opencode
```

把下面这段原样粘贴到智能体输入框中。

```text
请阅读setup_text.md，为这台机器和我当前使用的编码智能体安装llmwiki。严格按照文件执行，完成健康检查，并告诉我是否还有必须手动完成的步骤。
```

这是推荐的安装路径。README只保留面向人的入口；harness分支、健康检查、`PATH`、钩子信任、OS和恢复规则位于智能体契约 [`setup_text.md`](../setup_text.md) 及其[安装流程参考](../reference/INSTALLATION_FLOW.md)。

### 接着，每个项目只启用一次

安装发生在整台机器上，但在登记仓库之前，**它在任何地方都不会自动运行**。

```bash
llmwiki init /absolute/path/to/my-project
```

`init` 会建立wiki骨架，并在该worktree自己的 `.git/` 目录下写入登记标记。在这之前，即使仓库已经
含有完整的 `docs/wiki/`，也不会注入冷启动上下文、逐轮提示或捕获会话；clone本身不等于信任。
登记后不再要求额外确认。

- `llmwiki status <repo>` — 查看是否启用，以及未启用的原因
- `llmwiki disable <repo>` — 关闭自动集成但保留wiki
- 自动集成仅用于Git，且按worktree隔离；移动仓库后需重新运行 `init`
- `llmwiki` 启动器由Codex与OpenCode的接线安装。**仅安装Claude时没有该命令**，请直接从克隆目录运行：
  `bun ~/llmwiki/src/cli.ts init /absolute/path/to/my-project`（`status`、`disable` 同理）

setup正常完成后，在同一个安装会话中告诉智能体：

```text
使用刚安装的引擎，在 /absolute/path/to/my-project 初始化 llmwiki。验证项目wiki，并告诉我这个编码智能体的会话收尾命令。
```

然后在该项目中打开编码智能体并照常工作。一次有意义的会话结束时，在Claude Code或OpenCode中输入 `/wiki-save`，在Codex中输入 `$wiki-save`。定期使用 `/wiki-deep`（Codex: `$wiki-deep`）处理积压并做深度维护。如果项目 wiki 看起来有问题，运行 `/wiki-doctor`（Codex: `$wiki-doctor`）。

要检查wiki是否正在正确积累，请在目标项目的智能体会话中粘贴：

```text
请检查这个项目的docs/wiki是否正在正确积累文档。运行合适的llmwiki健康、状态和lint检查，然后概括哪些正常、哪些需要处理。
```

### 想按自己的方式来？只需一个文件

引擎代码不用动，下面这些都在同一个配置文件里改。

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # 英文，注释齐全
```

| 配置项 | 改变什么 |
|---|---|
| `[wiki] lang` | **引擎**书写所用的语言。不设置时跟随本次会话（先看 wiki 已有页面，没有就看你打给智能体的话）；要固定就写 `en` · `ko` · `ja` · `zh`。页面语言无论如何都跟随你的对话 |
| `[[category]]` | wiki 的文件夹结构，以及每个文件夹放什么 |
| `[topic]` `[queue]` `[quiz]` | 这些文件夹的名字，以及一次测验出几道题 |
| `[private] dirs` | 对你可索引、但永不提交的文件夹 |
| `[models]` | 谁写初稿（`light`）、谁做校验（`heavy`） |
| `[files]` · `legacy_dirs` | 三个特殊文件的名字，以及改名后仍继续扫描的旧文件夹 |
| `[lint.banned_terms]` | 需要提醒的措辞（仅建议，不阻止） |

最省事的做法: 把想要的效果告诉智能体，让它只修改 `llmwiki.config.toml`，然后用 `llmwiki config <项目路径>` 查看结果。未经用户明确批准，不会迁移已有页面。

不需要MCP服务器、Docker、外部数据库、向量数据库或云服务。llmwiki在本地使用Bun、钩子、捕获守护进程、SQLite和git markdown。供智能体遵循的安装契约见 [`setup_text.md`](../setup_text.md)。

- **它是什么**
    - 面向智能体环境、由 LLM 维护的项目 wiki — 素材是你的工作 transcript（会话转录），存储是纯 git markdown
    - 引擎 = 一个本地库: SQLite 索引 · 确定性 lint · 引用/交叉引用图 · content-hash 增量
    - 之上再加自动捕获守护进程 + transcript 复利 — **无需注册 MCP**
- **分工**
    - 事实 — 由 AI 无人值守写入
    - 判断（方向 · 决定 · 矛盾）— 永远有人在场
    - 人的记忆 — 每日遗忘曲线测验（`/wiki-quiz`），让你对自己决定的记忆和模型的上下文一样锋利
- **两层结构，单一来源**
    - 按会话的*日志册* — 时间轴: `2_milestone` · `3_decision` · `4_insight`
    - 按概念的*主题百科* — `5_topic`，主题轴 · 原地整合
    - 两层都只从原始 transcript 重新推导 — 禁止 wiki→wiki

核心想法 — 由 LLM 维护、人只负责把握方向的项目 wiki — 来自 [Andrej Karpathy 的 LLM-wiki 笔记](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。外部参考仅此一篇，设计与代码均为自研。

## 手动安装备选

仅在明确不使用智能体而直接安装时使用。选择一个harness；除非确实要接入所有已检测harness，否则不要使用 `auto`。

```bash
./setup.sh --harness claude
# 或: ./setup.sh --harness codex
# 或: ./setup.sh --harness opencode
```

- 原样使用setup输出的下一条命令
    - Claude-only: 固定到clone的 `bun <clone>/src/cli.ts …`
    - Codex/OpenCode: 用户级 `llmwiki …`
- 完成输出中的手动操作
    - 仅Codex: 在 `/hooks` 中检查并信任两个当前llmwiki钩子
- 完整分支与恢复规则: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)

## 复利循环

六个环节 — 两个完全无人值守，其余各一条命令。

| 环节 | 内容 | 自动? | 实现 |
|------|------|:---:|------|
| **捕获** | 每个会话 transcript → 中央队列 | ✔ | `src/daemon/watch.ts`（终端/配置无关） |
| **凝练（update）** | 队列 → 该仓库 `docs/wiki/` **日志层**（增量 append） | 1 条命令 | Codex: `$wiki-save` / `$wiki-deep` · Claude/OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/update.ts` |
| **整合（consolidate）** | 日志 → 按概念的**主题百科** `5_topic/`（原地合并·raw 再接地） | 1 条命令 | Codex: `$wiki-save` / `$wiki-deep` · Claude/OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/consolidate.ts` |
| **读取** | 冷启动注入 + 每轮相关页面指针 | ✔ | `hooks/sessionstart-inject.sh` · `hooks/userpromptsubmit-inject.sh`（Claude Code; Codex/OpenCode → `adapters/`） |
| **测验（人的记忆）** | wiki 的判断层 → **给人做的**按天遗忘曲线间隔重复测验（`6_quiz/` 记录 — 永不索引/搜索; 冷启动显示一行到期数） | 1 条命令 | Codex: `$wiki-quiz` · Claude/OpenCode: `/wiki-quiz` + `src/engine/quiz.ts`（`quiz-status`·`quiz-next`·`quiz-record`） |
| **自愈** | 结构（orphan·stale·dangling）= 确定性 `lint` / 语义（矛盾·过时主张·概念缺失）= 生成式 `review`（sync 时自动 — 引擎节流 `--if-due` 默认 7 天·限定范围+缓存）→ 缺口进入 `gaps` 的自闭队列（`0_review/gap-queue.md`） | 1 条命令 → 自动 | `lint`·`review`·`gaps`（`src/engine/{lint,review,gaps}.ts`） |

- **transcript 保留** — transcript 是智能体自己的文件，不是 llmwiki 的
    - 按各智能体的保留策略轮转（Claude Code 默认约 30 天 · Codex 把结束的会话压缩为 `.zst`）— llmwiki 从不复制它们
    - 值得保留的会话请在轮转前用 `/wiki-save` 收尾 · transcript 已消失的队列行由深度整理清除（`capture-prune`，30 天防护）

### 人的记忆循环（`/wiki-quiz`）

其余环节都在让**模型**有据可依，唯独这个环节在磨砺**人**。

- **为何存在**
    - 分工留给人的唯一不可委托之事 = 方向 + 矛盾的判断
    - 这种判断力会随着你对自己过往决定的记忆一起钝化
- **调度方式** — 引擎侧确定性调度，零 LLM
    - 按天的遗忘曲线: 盒子 1·3·7·16·35·60 天
    - 答错或跳过 → 重置为 1 天 · 同一条目一天内不会问第二次
    - 范围: wiki 的判断层 — 方向 > 决定 > 洞见·主题 > 里程碑，同级则新者优先
- **一场测验怎么进行** — 一次性全部预先出题
    - 引擎选出到期条目后，会话把相关页面一起读完、把所有题一次写好 — 答完一题下一题即刻出现，无需等待
    - 按页面内容做要点（gist）评分 · 答错的题第二天最先回来
    - 题量: `llmwiki.config.toml` 的 `[quiz] questions` — 默认 **3**，可像 `/wiki-quiz 5` 一样用参数加大，引擎上限 **7**（会被人跳过的测验什么也强化不了）
- **记录位置**
    - `docs/wiki/6_quiz/` — 台账 + 按日会话笔记
    - 从索引/搜索/冷启动中排除的纯人类层 — LLM 永远不会吃回自己的测验输出: wiki → 人，严格单向

### 证据随页面一起移动（页面格式 v3）

`[^s1]: <会话>.jsonl` 这样的引用指向**只存在于一台机器**的 transcript — 队友能读到你的结论，却打不开背后的依据。v3 把证据本身的 1–2 行放在脚注正下方的缩进行里:

```markdown
- 我们保留了日志层，并在其上叠加主题层 [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "日志保持原样，往上叠 — 替换才是有风险的那步"
```

- **格式契约**
    - 脚注定义行与之前逐字节相同 — 有四个解析器读这一行，其中一个负责让队友的引用不报错
    - 摘录只能由 `llmwiki excerpt` 生成 — 逐字保留 · 长度封顶 · 机密筛查（原始 transcript 里确实常混有凭证）
    - 判断性主张引用人的原话；事实性主张附带工具执行记录
- **给人扫读的正文结构**
    - 按阅读顺序编号的小节 — `## 1. <标签>`，小节确实要拆分时才用 `### 1-1. <标签>`；只有一组要点的短页面保持纯要点列表
    - 小节内：每个 `-` 一条具体事实·决定·结果·动作 · 支撑细节放 `    -` · 更深的细节放 `        -`（没有第四层）
    - 一行不塞整份清单：条目超过三个就改成父行 + 每项一个子要点（禁止 `·` 串联 — lint `dense-bullet`）
    - 句尾用该页面语言里自然的名词短语/电报式表达 · 只有在行为者·条件·结果会含混时才保留动词
    - 禁止抽象包装 · 重复标题/TL;DR · 只是复述父行的子要点（长页面没有小节时 lint `flat-body`）
- **lint 的立场**
    - 仅在**能读到该 transcript 的机器上**校验引文；在读不到的克隆上保持沉默 — 决不能让"无法校验"被读成"错误"
- **零检索成本**
    - 摘录不进搜索索引、不占主题页预算 — 添加证据既不损检索质量，也不占正文篇幅

### 自愈流程（人只负责填）

wiki 自己报告缺了什么，人只提供补上它的判断。

- **收尾（`/wiki-save`）· 深度整理（`/wiki-deep`）时**
    - ① 确定性 `lint` — 结构（orphan · stale · dangling）
    - ② 生成式 `review` — 语义（矛盾 · 过时主张 · 概念缺失）; 经 `--if-due` 自动运行且节奏由引擎强制（默认 7 天，`LLMWIKI_REVIEW_INTERVAL_DAYS`）· 输入限定为近期+标签相邻页面 · 无变更即跳过 · 深度整理则无条件运行
    - ③ `gaps` — 把 `review` 找到的*概念缺失 · 后续问题*堆入追踪队列（`0_review/gap-queue.md`）
- **缺口如何关闭**
    - 有人就该主题工作过一次，或深度整理补上，即告填补
    - `review` 连续两次不再提出 → 自动 close
- **刻意不自动生成缺口页面** — 不用单薄的证据凭空造页

## 结构

```
setup.sh       一键上手（路径无关: doctor→守护进程→钩子·命令→索引）
src/           TypeScript 引擎（Bun 运行时，内置 bun:sqlite — 零 node_modules·构建）
  cli.ts       CLI 调度器: init·index·reindex·refs·lint·search·update-*·skeleton·autoupdate·consolidate·topics·ingest·register-transcript·review·gaps·distill-verify·git-rules·overview·reconcile·doctor·context·digest·context-audit·config·conventions·migrate·quiz-*·capture-prune·bench·compare-arm·compare-verdict
  engine/
    schema.sql   按仓库的索引 schema（documents·chunks·FTS5·references）
    db.ts        WikiIndex: 索引（content_hash 增量）·搜索·图·staleness
    chunker.ts   FTS 分块（~512 token）        refs.ts    引用·链接 → 图边
    lint.ts      结构卫生检查（确定性）      review.ts  语义 lint（生成式·sync 自动·限定范围+无变更跳过缓存）
    gaps.ts      review 缺口（概念缺失·后续问题）→ 自闭队列 0_review/gap-queue.md（零 LLM; 缺席 2 次即 close）
    quiz.ts      人的记忆循环 — 遗忘曲线（按天）调度 + 优先级挑选 + 6_quiz/quiz-ledger.md（零 LLM; 出题·评分由 /wiki-quiz 温热执行）
    overview.ts  overview 入口规范化（Recent Updates→log 指针·预算警告，零 LLM·幂等）
    synthesis.ts 确定性关系综合 + 主题视图（标签簇·整合缺口，`topics`）— 零 LLM·可再生（`digest`/`topics`+冷启动 spine）
    extract.ts   transcript 增量提取（watermark）   update.ts  日志层编排
    autoupdate.ts  无人值守的事实 update（write→二次校验→lint 门）
    consolidate.ts 日志→主题百科（5_topic）整合（write→独立 VERIFY（新增 claim）→接地→lint，独立 watermark）
    source.ts    transcript 源抽象（discover/probe/parse 适配器 — harness 无关）
    sources/     claude.ts（claude-jsonl）· codex.ts（Codex rollout，含 .zst）· opencode.ts（OpenCode SQLite→export）· plain.ts（任意文件投放）
    ingest.ts    不用守护进程凝练单个文件（`llmwiki ingest` — 投放一个来源）
    capture.ts   中央捕获队列（.state/capture.db，source_kind）   doctor.ts   接线体检
    config.ts    团队约定 — llmwiki.config.toml + configs/*.toml 按仓库 resolver（applies_to 前缀; 零配置=原生结构; 提示词/规则从这里渲染的单一事实源）
    migrate.ts   按 config 重构 wiki（默认 dry-run·链接重写·.schema-version·漂移检测）
  daemon/
    watch.ts     捕获守护进程（轮询 sources() — 默认 Claude 配置的 transcript）
    wire.ts      Claude 钩子·命令接线（~/.claude* + $CLAUDE_CONFIG_DIR）
    wire-codex.ts Codex 钩子合并 + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCode 全局插件 + /wiki-* + 共享 CLI
    list-pending-repos.ts  只输出队列中 pending 的仓库（供调度器）
daemon/        install.sh（launchd/systemd/cron 自动检测）+ autoupdate-*.sh（无人值守事实通道）
hooks/         sessionstart-inject.sh（冷启动注入）· userpromptsubmit-inject.sh（每轮指针注入）
adapters/      codex/（原生钩子 hooks.json 模板）· opencode/（单文件插件）
skill/         wiki-save（会话收尾）·wiki-deep（周期深度整理）·wiki-doctor（诊断与修复）·wiki-ask·wiki-quiz（人的记忆）（/命令）
examples/      sample-wiki/ — 一个完成态 wiki 示例（只读展示）。引擎不索引（IGNORE_DIRS）。**请勿复制** — 真实 wiki 会在各项目 docs/wiki 下自动生成。见 examples/README.md
tests/         bun:test 套件（chunker·refs·lint·extract·capture·db·source·review-scope·overview·gaps·quiz·迁移）— `bun test`
package.json·tsconfig.json   Bun 元数据（供 typecheck; 运行时直接执行 .ts）
```

存储原则 — 三个居所，各有唯一主人:

- 捕获队列 — 中央: `<clone>/.state/capture.db`
- 内容 — 各仓库自己的 `docs/wiki/`（同址存放; markdown = 事实源）
- 索引 — `<repo>/.llmwiki/index.db`（随时可再生）

## 卸载

```bash
cd ~/llmwiki
./setup.sh --uninstall
./setup.sh --uninstall --purge-data    # 同时删除本地运行状态
```

卸载依据所有权标记，只移除llmwiki安装的钩子、插件、命令和服务；其他配置及各项目的
`docs/wiki/` 保持不变。移动或删除安装用clone之前，应先从该clone运行卸载。不加
`--purge-data` 时会保留本地状态并报告其位置。

## 本机保留的数据

| 内容 | 位置 | 保留期 |
|---|---|---|
| 捕获队列（仓库与时间的元数据） | `<clone>/.state/capture.db` | 直到 `--purge-data` |
| 守护进程日志（仅汇总） | `<clone>/.state/daemon.log` | 直到 `--purge-data` |
| OpenCode transcript导出（对话正文） | `<clone>/.state/opencode-export/` | **30天后自动删除** |

状态目录使用 `0700`，其中的文件使用 `0600`。Claude和Codex的transcript只从各自harness的
原始存储中读取，llmwiki不会另存副本。

## 前置条件

| | 必需 | 备注 |
|---|---|---|
| **Bun ≥ 1.1** | ✔ 必需 | 单一二进制（`curl -fsSL https://bun.sh/install \| bash`）。直接运行 `.ts`，`bun:sqlite` 连 FTS5 一并打包 — 零构建·`node_modules`。运行引擎和 `bun test` 无需安装; 仅 `bun run typecheck`（tsc）需要一次 `bun install`（仅开发用）。 |
| **Codex · OpenCode CLI** | 仅各自的快速开始 | `codex` / `opencode` 需在 `PATH` 上。Codex 另需支持 lifecycle hook 且启用 stable `hooks` 功能。setup 在改动钩子·技能·服务之前，会先确认支持情况与既有功能设置。 |
| **LLM CLI** | 可选，需显式开启 | 捕获·读取注入·`/wiki-*`·`ingest`（capture-only，只排队待更新）没有它也能工作，且**默认不向任何地方发送任何内容**。只有在 shell 环境中设置 `LLMWIKI_LLM_CMD` 后，`autoupdate·review` 和 `ingest` 的整合才会启动生成子进程（例如 `export LLMWIKI_LLM_CMD='claude -p {prompt} --model {model} --disallowedTools Write Edit NotebookEdit Bash'`）。未设置时这些通道报告“不可用”并跳过，确定性功能照常工作。 |
| **OS** | macOS / Linux | macOS=launchd，Linux=systemd（`--user`），无 systemd 则回退 cron+nohup。守护进程细节见 [`daemon/README.md`](../daemon/README.md) |

### Harness · OS 备注（Claude Code / Codex / OpenCode / Windows）

- **Claude Code** — `git clone … && ./setup.sh`，完事
    - 捕获 · 读取注入 · `/wiki-*` 命令全部自动接线
- **Codex (OpenAI)** — `./setup.sh --harness codex`
    - 安装用户 CLI + 5 个 `$wiki-*` 技能，并把原生 `SessionStart`/`UserPromptSubmit` 钩子合并进 `$CODEX_HOME/hooks.json`
    - 仅一次: 启动 Codex，在 `/hooks` 里审查确切命令 — 新钩子·改动过的钩子在被信任前不会执行
    - 捕获监视 `$CODEX_HOME/sessions/**/*.jsonl[.zst]`
    - 温热技能靠 Codex 本身即可运行 · 无人值守的 `autoupdate`/`review` 仅在设置了 `LLMWIKI_LLM_CMD` 时运行
- **OpenCode** — `./setup.sh --harness opencode`
    - 安装全局 `/wiki-*` 自定义命令、内嵌克隆路径的读取注入插件、用户 CLI
    - 捕获读取 SQLite 会话存储 · `XDG_DATA_HOME`/`OPENCODE_DB` 也会保留在守护进程环境里
- **Windows** — 推荐 WSL2
    - Bun·`bun:sqlite` 原生可跑 · 路径匹配会规范化反斜杠
    - 但原生 Windows 仍需 Git Bash 跑 `.sh` 脚本 + 手动注册 Task Scheduler/NSSM（没有 launchd/systemd/cron）
    - WSL2 下一切原样可用（launchd→systemd · bash · 路径）— 与 Claude Code·Codex 的官方建议一致

## 安装 / 使用

**把本仓库 clone 到任何位置、起任何名字，跑一遍 `./setup.sh`** — 它就成了那台机器的引擎。

- 所有接线（守护进程 · 钩子 · CLI · `/wiki-*` 命令）都从 clone 的位置推导 — 不需要 `~/llmwiki` 这类固定路径，文件夹名随意
- 只要有 Bun，`.ts` 原样即跑 — 无打包、无构建
- 移动或更新 clone 之后重跑 setup — 幂等地刷新生成的技能与接线

```bash
# 0) clone 引擎（每台机器一次）— 位置·名字不限
git clone https://github.com/suwonleee/llmwiki.git
cd llmwiki

# 1) 一步安装 — doctor → 捕获守护进程（OS 自动检测）→ harness 接线 → doctor
./setup.sh --harness auto                # 只钉一个则: claude · codex · opencode

# 2) 该干嘛干嘛 — 任何文件夹·终端里的会话都会被自动捕获
#    按仓库手动命令: bun <clone>/src/cli.ts init|index|search|lint <repo>

# 3) 在智能体输入框里收尾会话
/wiki-save                               # 会话收尾（Codex: $wiki-save）
/wiki-deep                               # 周期深度整理（Codex: $wiki-deep）
/wiki-doctor                             # 诊断并修复此 wiki（Codex: $wiki-doctor）
/wiki-quiz                               # 人的记忆循环（Codex: $wiki-quiz）
```

> 单步执行: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` ·
> `bun <clone>/src/daemon/wire.ts`（Claude）· `wire-codex.ts` / `wire-opencode.ts`（Codex/OpenCode）—
> 每个 wire 脚本都带 `--revert`，只回滚它自己的改动。

## 配置（环境变量）— 供应商 · 模型 · CLI 无关

生成通道（autoupdate/review）在**明确启用之前保持关闭**。不配置时不会启动子进程，也不会向
任何provider发送内容。只有机器环境中设置了 `LLMWIKI_LLM_CMD` 才会启用；仓库配置、Markdown、
跟踪文件和自动载入的 `.env` 都不能启用它。所有外发内容都先经过secret screening。

| env | 默认值 | 用途 |
|---|---|---|
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | 推理档 tier — VERIFY（对抗性门）·review（语义检查） |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | 草稿档 tier — WRITE（页面生成） |
| `CLAUDE_CONFIG_DIR` | （Claude Code 标准） | 设置后该目录也被识别为 Claude 配置 — 钩子接线（wire）·捕获（claude source）·doctor 一并尊重。 |
| `LLMWIKI_LLM_CMD` | **未设置 — 不启动子进程、不联网** | LLM 调用的 argv 模板。`{prompt}`·`{model}` 按 token 替换（不做 shell 解析）。没有 `{prompt}` 时提示词走 stdin。需要引号的多词值用 JSON 数组（`["my-llm","--q","{prompt}"]`）。任何 CLI 皆可 — Codex·`llm`·ollama 等。 |
| `LLMWIKI_STATE_DIR` | `<clone>/.state` | 可选的机器本地状态路径。仓库 `.env` 无法改写。只接受新目录、空目录或已由llmwiki拥有的路径；遇到非空外部目录会拒绝。 |
| `LLMWIKI_LANG` | `en` | 冷启动运行规则/标题的语言。`ko` 为韩语。（wiki 正文保持原样 — 只切换 UI 文案。） |
| `LLMWIKI_SEARCH_RELAX` | （开） | 设为 `off` 关闭宽松召回回退 — 自然语言查询在 strict AND 命中 0 行时，用同一批词 OR 连接只重试一次（trigram 安全·Unicode/CJK 感知·无停用词表）。A/B 测量用的开关。 |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144`（256KB） | 每个来源文件的内容上限。超限文件（数 MB 的 yaml/json fixture 等）只登记元数据 — 按名字·路径可查，但不做全文索引。wiki 页面不受限。让 fixture 多的仓库索引依旧紧凑、搜索依旧快 — 搜索/turn-context 质量不变。 |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | 单次 `review` 的输入上限。wiki 超过时只审近期+标签相邻页面（防提示词溢出）。 |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` 的节奏门 — 距上次已提交 review 满这个天数才运行（之前约 0.03 秒即确定性跳过）。让会话收尾的 review 成本默认为零。 |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` 页面的超大警告（`topic-oversize`，advisory）字符预算 — 超预算时深度整理会从其引用的 transcript 重写页面，由 `distill-verify` 把关（引用集不得缩小）。 |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview --normalize` 发出警告的 overview.md 字符预算（监控入口膨胀）。 |
| `LLMWIKI_L0_BUDGET` | `1600` | 冷启动 L0（current-state）的字符**基准**。注入**从不截断**: 超基准的页面也整页注入并附一行超额提示（推动下次收尾去修剪）; `oversized-l0` lint 从 1.25× 起警告。 |

- 把各档换成"当下刚发布的顶级模型"，或换成非 Anthropic 的模型/端点，都可以
- **Harness 无关的读取**
    - `bun <clone>/src/cli.ts context <repo>` — 冷启动上下文 · `… turn-context <repo>`（钩子 stdin JSON 或 `--prompt`）— 每轮相关页面指针（≤3 行，没把握就沉默）
    - Claude Code 自动接线两个钩子 · 近期 Codex 可原生执行同一批钩子脚本（`adapters/codex/`）· OpenCode 用单文件插件注入（`adapters/opencode/`）
    - 其他 harness 从 AGENTS.md 或启动提示词调用同样的命令即可
    - 每轮注入是渐进增强 — 冷启动 + `search` 的基线在哪里都一样

## 团队使用（共享同一项目的 wiki）

单人是默认形态，下面这些完全用不上 — 全部是可加的（additive），单人使用时保持安静。多人共用一个项目时，各自跑自己的本地引擎（自己的捕获守护进程·队列），只把**自己的会话**凝练进共享的 `docs/wiki/`；共享就是纯 git。

- **脚手架安全装置**
    - 自动播种 `.gitignore` — `.llmwiki/`（派生索引）永不入库
    - 自动播种 `.gitattributes` — `docs/wiki/log.md merge=union`，并发 append 无冲突合并
- **署名**
    - 作者信息不写入frontmatter的 `author:`，而是从考虑 `.mailmap` 的git历史中计算
    - `0_review` 的问题记录 `owner: <GitHub login>` — 冷启动显示为 `[→ login]`，队友可跳过不属于自己的问题
- **队友引用自愈**
    - 格式正确的 `.jsonl` 引用会在索引重建时自动登记为虚拟来源（transcript 本来就会轮转消失）
    - 队友的引用不会打破你的 `lint` 门 · 格式坏掉的引用照旧报错
- **连续性**
    - 克隆落后于 origin 时，冷启动会提示一行 — 可能有队友合并过的上下文，开工前先 pull
- **评审流程**
    - wiki 提交与代码同分支、同 PR — **PR 评审就是 AI 所写页面的人工把关**
    - `gap-queue.md` / `overview.md` 冲突时: 任取一边，重跑 `llmwiki gaps` / `llmwiki overview --normalize`（会收敛）— 决不手工合并生成的正文
- **两类已验证安全的冲突**
    - `current-state.md`（L0）: 任取一边都安全 — 下次 `/wiki-save` 会从 wiki 状态重推 Now/Next 并收敛 · 唯 **Next** 列表建议取双方并集（不丢待办动作）
    - 同一 `5_topic` 页面的并发追加: **保留双方全部条目** — 主题页按格式规则只增不改（既有行不可变·合并只做添加），并集永远是正确的合并

## 团队约定 — `llmwiki.config.toml`（可选）

原生类目结构（`0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`）是内置默认 — **没有 config 文件时一切不变，逐字节相同**（渲染出的提示词/规则与历史文本一致，由测试钉死）。想用别的团队格式，就把 `llmwiki.config.example.toml` 复制为克隆根目录的 `llmwiki.config.toml` 并声明类目:

```toml
[[category]]
dir = "1_goal"     # docs/wiki 下的文件夹名
domain = "goal"    # 路由到此文件夹的 frontmatter domain
review = "human"   # human → 0_review 队列 · model → 强模型裁决
guide = "季度目标。变更须人工确认。"
```

- **单一事实源**
    - WRITE 提示词、冷启动运行规则、`llmwiki conventions <repo>`（`/wiki-*` 技能所依赖的输出）全部从这个文件渲染 — 没有会漂移的散文副本
- **按仓库 config**（可选）
    - `<clone>/configs/` 下可放多个 `*.toml` — 带 `applies_to = ["<文件夹>", …]` 的文件治理那些文件夹及其全部下级（segment-safe 前缀 · 最具体路径胜出 · 支持 `~` 展开）
    - 不带 `applies_to` = 全仓库默认（规范名: `configs/default.toml`）
    - 优先级: 具名匹配 → `configs/` 默认 → 根 `llmwiki.config.toml` → 内置默认 · 匹配依据会话钩子传入的路径（`CLAUDE_PROJECT_DIR`/cwd）
- **查看** — `llmwiki config [workspace]`
    - 显示选中了哪个文件、为什么（含校验）· 无效或读不了的文件带警告安全回退 — 决不弄坏会话
- **重构既有 wiki** — `llmwiki migrate <repo>`（dry-run）→ `--commit`
    - 文件夹改名 + 重写全部 wikilink/相对链接 + 更新 frontmatter `domain:` + 盖 `.schema-version` 戳
    - 决不自动运行 — 冷启动只做双向漂移检测（wiki 比你的引擎 config 新 / config 比 wiki 新）并给出建议
- **团队分发**
    - 把 config 提交到团队的引擎 fork; 成员 `git pull`，一人执行 `migrate`，结果像任何变更一样走 PR 合并
- **兼容性纪律**
    - 删除 config 键必须先经过弃用窗口 + lint 警告 + `migrate` 步骤 — 决不悄悄删除

## 回归测量（引擎开发工具 — 永不进入日常循环）

- **`llmwiki bench <repo>`** — 确定性检索基准（零 LLM，毫秒级）
    - 黄金查询集: `<repo>/docs/wiki/.bench/golden.toml`（每仓库 ≤20，语言不限）
    - 计分: search any-hit `r@k` + turn-context 指针命中/沉默 — refusal 查询在 turn-context 沉默时即为正确（结构判定，语言中立）
    - 固定种子的 tune/sealed 切分 — `--tune-only` 随便迭代，`--sealed` 只用于最终确认（sealed 结果每看一次，作为回归护栏的价值就少一分）
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 冻结语料 A/B
    - 用同一批 transcript 语料为每个配置/代码版本构建隔离的临时 wiki — arm 构建是唯一的 LLM 步骤
    - 用顺序门裁决两个带标签的结果: 回归拦截优先 → keep/adopt/undecided，零 LLM
    - 仅在提示词·模型变化时运行

## 原则

- transcript = 原始且不可变 — 只引用，禁止 wiki→wiki 再推导 · 增量 = 只处理 watermark 之后的部分
- 事实 = AI 自动 / 判断（决定的 Why·What·Alt·方向）= 人 — `status: draft` 标记
- git markdown = 单一事实源 — 提交使用单一作者身份（仓库所有者）
- 拒绝过度设计 — 不到 100k token 就不需要 vector DB·RAG（index.md 导航足矣）

## 许可证

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
