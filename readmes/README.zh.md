<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki

由编码智能体编写和读取的本地项目 wiki，还会用测验反问你自己做过的决定。

[English](../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文**

编码智能体每次会话都从零开始。llmwiki 在每个项目中（`docs/wiki/`）维护一个 wiki，根据你过去的智能体会话，以 git 中的普通 Markdown 记录下来。在会话开始时和每次提问时，它把相关的部分交给智能体。事实由 AI 记录；决定和方向由人来定。

## 主要特点

- **从会话生成** — 会话结束时运行 `/wiki-save`，这次会话就会变成 wiki 页面，可以在 git 中阅读、修改和评审。
- **自动读回** — 会话开始时给出简短的当前状态页（*L0*），每次提问给出相关摘录，修改受规则约束的文件之前给出该规则（Claude Code）。
- **支持 Claude Code、Codex 和 OpenCode** — 这些编码智能体（下文称 *harness*）可以在每个项目中共用一个 wiki。
- **普通文件** — git 中的 Markdown，格式为 [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)（OKF v0.2）。
- **只在本地运行** — 只用你机器上的 Bun 和 SQLite。不需要 MCP 服务器、Docker、向量数据库或云服务。除非你设置 `LLMWIKI_LLM_CMD`，否则不会向外发送任何内容。
- **成本不增长** — 注入的上下文有上限，不随 wiki 大小成比例增长。
- **启用前不生效** — 在你运行 `llmwiki init` 之前，项目不受任何影响。
- **测验** — `/wiki-quiz` 用间隔重复的方式，简短地问你过去做过的决定。

## 快速开始

需要 Git、[Bun](https://bun.sh) 1.1 及以上版本和一个编码智能体。

### 1. 安装

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

- 这会安装当前的公开版本。如需可复现的安装，请先在 [Releases 页面](https://github.com/suwonleee/llmwiki/releases) 选择一个标签。
- 把克隆放在原处：已安装的钩子指向这个路径。移动或删除之前请先卸载。

在这个文件夹中只启动**一个**智能体：

```bash
claude
# 或: codex
# 或: opencode
```

把下面这段粘贴给智能体：

```text
请阅读 setup_text.md，为这台机器和我当前使用的编码智能体安装 llmwiki。严格按文件执行，运行健康检查，并告诉我还剩哪些需要手动完成的步骤。
```

- 这是推荐的安装方式。智能体会按照 [`setup_text.md`](../setup_text.md) 执行，并运行健康检查。
- 各 harness 的分支、`PATH`、钩子信任、操作系统说明和恢复方法见 [安装流程参考](../reference/INSTALLATION_FLOW.md)。
- 不用智能体？请看 [手动安装备选](#手动安装备选)。

### 2. 在项目中启用

只安装不会产生任何作用。登记之前，项目保持原样。

setup 正常完成后，在同一个安装会话中告诉智能体：

```text
使用刚安装的引擎，在 /absolute/path/to/my-project 初始化 llmwiki。验证项目wiki，并告诉我这个编码智能体的会话收尾命令。
```

也可以自己运行：

```bash
llmwiki init /absolute/path/to/my-project     # 每个项目一次
```

- `init` 会创建 `docs/wiki/`，并在该 worktree 的 `.git/` 下写入登记标记。
- 运行 `init` 之前，项目不会得到任何上下文、注入或捕获——即使已经有 `docs/wiki/` 也一样。克隆别人的仓库，并不等于决定在其中运行 llmwiki。
- `init` 之后不会再弹出确认。
- **仅 OpenCode — 安装后重启一次**（重新指向克隆后也一样）。OpenCode 在进程启动时加载插件。Claude Code 和 Codex 从下一个会话开始生效。
- 登记仅用于 Git，并按 worktree 进行。链接的 worktree（`git worktree add`）继承主 worktree 的登记，可用 `llmwiki disable <worktree>` 单独关闭。
- 移动仓库后需要重新运行 `init`（标记记录了路径）。

### 3. 日常使用

在该项目中打开编码智能体，照常工作。请从项目目录启动智能体：会话会读取并记录其 cwd 处的 wiki。

| 何时 | Claude Code / OpenCode | Codex |
|---|---|---|
| 一次有意义的会话结束时 | `/wiki-save` | `$wiki-save` |
| 不定期（积压、深度整理） | `/wiki-deep` | `$wiki-deep` |
| 向 wiki 提问 | `/wiki-ask` | `$wiki-ask` |
| wiki 看起来有问题 | `/wiki-doctor` | `$wiki-doctor` |
| 做测验 | `/wiki-quiz` | `$wiki-quiz` |

要检查 wiki，请在该项目的智能体会话中粘贴：

```text
请为这个项目运行 /wiki-doctor。修复安全的生成状态和有证据支撑的页面问题，然后总结修复了什么、还有什么需要关注。在 Codex 中运行 $wiki-doctor。
```

常用命令：

- `llmwiki status <repo>` — 是否启用；未启用时说明原因
- `llmwiki verify <repo> --harness <harness>` — 一次检查接线、登记、索引和会话开始时的内容
- `llmwiki disable <repo>` — 关闭（wiki 文件保留）
- `llmwiki --help` — 首次使用流程和命令分组；`llmwiki <command> --help` 只显示用法而不执行；`llmwiki --version` 显示引擎版本

## 其他安装方式

### 插件安装（无需克隆）

本仓库同时也是 Claude Code / Codex 的插件市场。

```bash
# Claude Code
claude plugin marketplace add suwonleee/llmwiki
claude plugin install llmwiki@llmwiki

# Codex（之后在 /hooks 中批准两个钩子一次）
codex plugin marketplace add https://github.com/suwonleee/llmwiki
codex plugin add llmwiki@llmwiki
```

- 插件包含读取循环和 `/wiki-*` 技能。
- 后台捕获守护进程**只随克隆安装提供**。每台机器只选一种方式；钩子检测到克隆安装时会让位给它。
- 每个仓库都要登记：在该仓库的会话中运行 `/wiki-doctor`，或运行 `bun <plugin-root>/src/cli.ts init <repo>`。未登记的仓库不会被注入任何内容。
- 仍然需要 Bun。没有 Bun 时，插件会在会话开始时提示一次，之后保持安静。
- 成本：每个会话约 330 个常驻技能元数据 token。
- 安装前请阅读 [插件披露](../PLUGIN.md)、[隐私政策](../PRIVACY.md)、[条款](../TERMS.md) 和 [支持说明](../SUPPORT.md)。

### 手动安装备选

仅在不使用智能体、直接安装时使用。选择一个 harness。`auto` 会接入所有检测到的 harness。

```bash
./setup.sh --harness claude
# 或: ./setup.sh --harness codex
# 或: ./setup.sh --harness opencode
```

- 原样使用setup输出的下一条命令
    - macOS、Linux 或 WSL2上的所有harness: 用户级 `llmwiki …`
    - 原生 Windows 的所有harness: 显式使用 `bun <clone>/src/cli.ts …`；可选的 `llmwiki` 启动器仅适用于Git Bash，而Codex/OpenCode使用PowerShell
- 完成输出中的手动操作
    - 仅Codex: 在 `/hooks` 中检查并信任两个当前llmwiki钩子
    - OpenCode: 初次setup或clone重新指向后重启
- 完整分支与恢复规则: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)
- `./setup.sh --dry-run` 只打印计划，不改动文件或服务。
- 克隆可以放在任何位置、使用任何名字。所有钩子、命令和服务都由克隆位置决定。
- 移动或更新克隆后，请重新运行 setup。重复运行是安全的。
- 单独步骤：`bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` · `bun <clone>/src/daemon/wire.ts`（Claude） · `wire-codex.ts` / `wire-opencode.ts`。每个 wire 脚本都可以用 `--revert` 撤销自己的改动。

## 工作原理

循环分为六个阶段。两个自动运行，其余各需一条命令。

1. **捕获**（自动） — 后台守护进程把每个会话的 transcript 放入队列，与文件夹和终端无关。
2. **更新**（`/wiki-save`） — 把队列中的新内容追加到项目的日志层：`2_milestone`、`3_decision`、`4_insight`。
3. **整合**（`/wiki-save`、`/wiki-deep`） — 把日志合并为按概念划分的页面（`5_topic/`）。
4. **读取**（自动） — 会话开始时给出 L0 和页面指针；每次提问最多给出三个相关指针或摘录；修改受约束的文件之前先给出规则（Claude Code）。
5. **测验**（`/wiki-quiz`） — 从 wiki 的决定中出间隔重复题，这一步是为人准备的。
6. **自愈**（`/wiki-save`、`/wiki-deep`） — `lint` 检查结构，`review` 检查含义，`gaps` 跟踪缺失的内容。

分工：

- **事实** — 由 AI 无人值守地写。
- **判断**（方向、决定、矛盾） — 始终由人负责。
- **你对自己决定的记忆** — 由 `/wiki-quiz` 保持。
- 页面只从原始 transcript 生成，不从其他 wiki 页面再生成。

transcript 属于智能体，而不属于 llmwiki：

- 它们按各智能体自己的周期轮换（Claude Code 约 30 天；Codex 会把结束的会话压缩为 `.zst`）。llmwiki 不复制它们。
- 值得保留的会话，请在过期前用 `/wiki-save` 收尾。transcript 已消失的队列行由深度整理清除（`capture-prune`，30 天保护）。

"由 LLM 维护、由人掌舵的项目 wiki"这一想法来自 [Andrej Karpathy 的 LLM-wiki 笔记](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。这是唯一参考的外部资料；设计和代码均为原创。

### 测验（`/wiki-quiz`）

其他阶段让**模型**有据可依；这一阶段让**人**保持清醒。判断力会随着对过去决定的记忆一起淡化。

- **排期** — 由引擎确定性地完成，不用 LLM。
    - 以天为单位的遗忘曲线：1、3、7、16、35、60 天的盒子。
    - 答错或跳过 → 回到 1 天。同一项一天内不会问两次。
    - 优先级：方向 > 决定 > 洞见和主题 > 里程碑，同级时新的优先。
- **一次测验**
    - 引擎挑出到期的项目，智能体读取这些页面并预先写好所有题目，下一题无需等待即可出现。
    - 按要点评分，以页面为依据。答错的题第二天最先出现。
    - 题数：`llmwiki.config.toml` 中的 `[quiz] questions`。默认 **3**，每次可增加（`/wiki-quiz 5`），上限 **7**。
    - 题目出现的位置：Claude Code `AskUserQuestion`（每次 4 题） · OpenCode `question` · Codex `request_user_input`（每次 3 题；在 Plan 模式之外，需先运行 `codex features enable default_mode_request_user_input`）。其他环境中，所有题目以一个编号块给出。
- **记录** — `docs/wiki/6_quiz/`（台账和每日笔记）。这是只给人看的文件夹，不被索引、搜索或注入。

### 证据随页面一起移动（页面格式 v3）

像 `[^s1]: <session>.jsonl` 这样的引用，指向**只存在于一台机器上**的 transcript。队友能读到结论，却看不到依据。v3 把一到两行证据直接放在脚注下面：

```markdown
- 我们保留日志层，并在其上叠加主题层 [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "日志保持原样，在上面叠一层——替换才是有风险的部分"
```

- **格式**
    - 脚注行本身不变；有四个解析器读取这一行。
    - 摘录只由 `llmwiki excerpt` 生成：原文照录、限制长度、筛除机密信息。
    - 判断类主张引用人的原话；事实类主张引用工具执行记录。
- **页面正文**
    - 按阅读顺序编号的小节（`## 1. <标题>`、`### 1-1. <标题>`）。短页面用一个项目符号列表即可。
    - 每个 `-` 行一个要点，补充用 `    -`，更深的细节用 `        -`（没有第四级）。
    - 超过三项的列举，改为一行父项加每项一个子项（lint：`dense-bullet`）。
    - 自然时使用简短的名词性结尾。不重复父项或标题（没有小节的长页面，lint：`flat-body`）。
- **lint** 只在能读到 transcript 的地方核对引用。在其他克隆上保持安静："无法检查"不能被理解成"错误"。
- **搜索** 忽略摘录，因此附上证据不会降低检索质量，也不占页面预算。

### Open Knowledge Format (OKF v0.2)

`docs/wiki/` 是一个 [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) 包。任何 OKF 阅读器都能直接打开，llmwiki 也能读取任何 OKF 包。

- 每个页面都有 `type`（`Decision` · `Topic` · `Current State` …）、`status`（`stable` · `draft` · `deprecated`）、`generated: { by, at }`，以及每个脚注对应的一个 `sources` 条目。
- 链接是相对 Markdown 链接，而不是 `[[wikilink]]`。
- 每个文件夹都有生成的 `index.md`。`log.md` 按日期分组，最新在前（`llmwiki log-append`）。
- 现有 wiki 只转换一次，由你决定：`llmwiki okf <repo>`（dry-run） → `--commit`。用 `llmwiki okf --bundle docs/wiki` 检查一致性。
- 也用外部阅读器验证过：Google 的参考解析器和查看器、`W4G1/okf`、`okf-rs` 和 `okf-studio` 打开这些包时 0 错误（包括韩文文件名）。
- llmwiki 自己的字段集中在一个扩展键 `x-llmwiki` 中。其他阅读器会忽略它，`llmwiki okf` 会保留它。

### 自愈

wiki 自己报告缺了什么，人只需补上判断。

- 在 `/wiki-save`、`/wiki-deep` 时：
    1. `lint`（确定性） — 结构：孤立、过时和悬空的页面。
    2. `review`（生成式） — 含义：矛盾、过时的说法、缺失的概念。收尾时只在到期时运行（`--if-due`，默认 7 天，`LLMWIKI_REVIEW_INTERVAL_DAYS`），且只看最近和相关的页面。深度整理总会运行它。
    3. `gaps` — 把缺失的概念和后续问题收集到 `0_review/gap-queue.md`。
- 当有人处理了该主题、深度整理补上了它，或者 `review` 连续两次没有再报告它时，缺口就会关闭。
- 不会依据薄弱的证据凭空生成页面。

## 有用吗？

### 智能体会遵守先前的决定吗 — 对照实验

写 wiki 很容易，让编码智能体照着做却很难。我们在两个真实工作仓库上用真实的 Claude Code 会话做了测量（2026-10-13/14）：

1. 一个会话在对话中定下项目规则并收尾。
2. 之后一个新会话接到受该规则约束的另一项任务。
3. 由盲评模型判断改动是否遵守了规则。

| 智能体拥有的 | 遵守先前决定的比例 |
| --- | --- |
| 没有 wiki | — （问答：准确率 0.57，幻觉 23%） |
| 有 wiki（问答题） | 准确率 0.73–0.78，幻觉 4–8%（480 次） |
| 决定只写在 wiki 页面里（编码任务） | **0/8** — 32 次编码中智能体从未打开 wiki 页面，也没有搜索 |
| 决定作为 L0「有效规则」中的一行 | **8/8** |
| 决定只在页面里，通过编辑时 + 每轮摘录送达 | **8/8**（仅摘录 4/8，仅编辑时 gate 7/8） |

因此 v0.14.0 做了这些改变：

- 人定下的规则以具体的一行保留在 L0，并标注它所约束的路径（`x-llmwiki: { applies_to, rule, recall }`）。
- 每轮注入的内容包含规则正文，而不只是标题。
- 当智能体要修改受约束的文件时（无论用 Edit 工具还是 Bash 写入），规则会在编辑之前摆到它面前（Claude Code）。

解读这些数字时请注意：

- 样本很小：2 个仓库、4 个场景、每组 8 次、一个评分模型。
- 任务刻意设计成"直觉上的改法会违反规则"。这说明送达机制有效，并不说明你的规则有多常起作用。
- 仅转换为 OKF 并没有改变答题准确率（+0.03，在误差范围内）。收益来自真正送到智能体面前的内容。
- 以新用户方式，在隔离的 HOME 中全新克隆并运行（`./setup.sh` → `llmwiki init` → 会话 → `/wiki-save` → 新会话），2/2 个场景都遵守了规则：一次靠编辑时 gate，一次是智能体看到每轮摘录后自己打开了决定页面。

### 每天使用 11 周之后

一名开发者、一台机器、19 个仓库、997 个页面 — 2026-08-21 实测，并非推算。这些是引擎对自身报告的数值，可用 `llmwiki doctor`、`llmwiki bench`、`llmwiki downstream-read` 在你自己的 wiki 上复核。

| 观察到的 | 实测 | 为何重要 |
| --- | --- | --- |
| 会话开销不随 wiki 增长 | 最大仓库（236 页）会话开始注入 6.7KB | 指针数量有上限，不按比例增长 |
| 检索保持快速 | 同一仓库检索 0.11 秒 · 每轮钩子 0.16 秒 | 这个循环每次提问都会运行 |
| 派生数据重建成本低 | 全量重建索引 6.9 秒 | wiki 是 git 中的 Markdown，索引只是可丢弃的副本 |
| 本地状态有界 | 19 个 wiki 合计 167MB | 采集会随 harness 自身的保留周期一起过期 |
| 一个 wiki，多个智能体 | 同一仓库上记录到来自 Codex 与 Claude Code 的打开 | 更换智能体不会让知识从头开始 |
| 效果不理想时也照样度量 | 指针打开率 2.1% | 如实报告而非假定。同一套仪表还发现了自身的抽样缺陷：只读了 54 个会话中的 5 个就得出的 "0%" |

这是一位开发者在一台机器上、用他自己书写的语言的 wiki 得到的数字。它说明引擎在这个规模下保持轻量与诚实，但不构成对团队协作、其他语料或回答质量的断言。

### 发布检查覆盖的范围

- 每个候选版本都从全新、固定版本的克隆进行验证：Claude 钩子、Codex 钩子、OpenCode 插件回调、登记、捕获、收尾、重启和下一会话的检索。
- 检索测试数据在 10、100 和 1,000 个生成页面上检查正确性。
- 检查覆盖文档中的 macOS、Linux、原生 Windows 和 WSL2 分支、仅本地的数据边界，以及公开包中允许的确切文件。
- 不作的承诺：真实模型总能写出好页面；新用户无需帮助就能理解流程。可用性研究已预注册，尚无参与者结果。
- 确切边界见：[发布门槛](../reference/RELEASE_GATES.md)、[支持契约](../reference/support-contract.json)、[可用性研究方案](../reference/USABILITY_STUDY.md)。

## 配置

### 配置文件（`llmwiki.config.toml`）

以下内容都在一个文件中修改，引擎代码保持不变。

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # 英文，注释详尽
```

| 设置 | 改变什么 |
|---|---|
| `[wiki] lang` | **引擎**书写使用的语言。未设置时跟随会话（已有页面 → 你输入的内容）。可用 `en` · `ko` · `ja` · `zh` 固定。页面语言始终跟随对话 |
| `[[category]]` | wiki 的文件夹构成，以及每个文件夹的内容 |
| `[quiz] questions` | 每次测验的题数。`5_topic` · `0_review` · `6_quiz` 文件夹是固定的 |
| `[private] dirs` | 为你索引、但不提交的文件夹 |
| `[models]` | 起草模型（`light`）和验证模型（`heavy`） |
| `legacy_dirs` | 改名后仍继续扫描的旧文件夹。核心文件（`current-state` · `overview` · `log`）是固定的 |
| `[lint.banned_terms]` | 需要警告的措辞（仅建议，不阻止） |

- 最简单的方法：把需求告诉智能体，让它只修改 `llmwiki.config.toml`。用 `llmwiki config <project-path>` 检查结果。
- 未经你明确批准，不会迁移已有页面。

### 环境变量

生成式处理（`autoupdate`、`review`）**在你启用之前是关闭的**。

- 没有任何配置时，llmwiki 不启动子进程，也不向任何提供方发送内容。
- 在机器环境中设置 `LLMWIKI_LLM_CMD` 是一次性的主动启用。仓库配置、Markdown 页面、被跟踪的文件或自动加载的 `.env` 都无法设置它。
- 启用后，来自 transcript 或页面的每个片段在进入提示词之前都会经过机密信息筛查。筛查后什么都不剩时，会取消这次调用。

| env | 默认值 | 用途 |
|---|---|---|
| `LLMWIKI_LLM_CMD` | **未设置 — 无子进程、无网络** | LLM 调用的命令模板。`{prompt}`、`{model}` 按 token 替换（不经 shell 解析）。没有 `{prompt}` 时，提示词通过 stdin 传入。需要引号的多词值请用 JSON 数组（`["my-llm","--q","{prompt}"]`）。任何 CLI 都可以（Codex、`llm`、ollama…） |
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | 推理层 — VERIFY 和 `review` |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | 起草层 — WRITE（页面生成） |
| `CLAUDE_CONFIG_DIR` | （Claude Code 标准） | 接线、捕获和 doctor 都会把这个目录视为 Claude 配置 |
| `LLMWIKI_STATE_DIR` | `$XDG_DATA_HOME/llmwiki`（或已有的 `<clone>/.state`） | 本机状态的位置。仓库的 `.env` 无法更改它。自定义路径必须是新的、空的，或已归 llmwiki 所有 |
| `LLMWIKI_LANG` | `en` | 会话开始规则和标题的语言（`ko` 为韩文）。wiki 正文不变 |
| `LLMWIKI_SEARCH_RELAX` | （开） | 设为 `off` 会关闭"零命中时用 OR 连接各词重试一次"的回退。用于 A/B 测量 |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144`（256KB） | 每个源文件的大小上限。更大的文件只能按名称找到。wiki 页面不受限 |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | 单次 `review` 的输入上限。更大的 wiki 只审查最近和标签相关的页面 |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` 只在距上次 review 满这么多天后运行；在此之前约 0.03 秒即跳过 |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` 页面的字符预算（`topic-oversize`，仅建议）。超出时，深度整理会根据来源重写该页面，并用 `distill-verify` 把关（引用不得减少） |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview` 发出警告的字符预算（`--check` 只预览不写入） |
| `LLMWIKI_L0_BUDGET` | `1600` | L0（`current-state`）的字符**参考值**。注入时不截断：较长的页面也会完整注入，并附加一行提示。`oversized-l0` lint 从 1.25 倍开始警告 |

- 每一层都可以换成最新的顶级模型，或换成非 Anthropic 的模型或端点。

读取在任何 harness 中都可用：

- `bun <clone>/src/cli.ts context <repo>` 输出会话开始时的上下文。`… turn-context <repo>`（钩子 stdin JSON 或 `--prompt`）最多输出三个相关指针，没有把握时保持安静。
- Claude Code 会自动接好两个钩子。较新的 Codex 原生运行同样的钩子脚本（`adapters/codex/`）。OpenCode 通过单文件插件注入（`adapters/opencode/`）。
- 其他 harness 可以在 AGENTS.md 或启动提示中调用同样的命令。
- 每轮注入是附加功能。会话开始的上下文和 `search` 在任何地方都一样。
- 读取循环会学习哪些指针真正被打开，并且**只用于调整顺序**，从不增加文字。
    - 守护进程每天一次，把发出记录和各 harness 的阅读记录汇总到每个项目的小文件 `affinity.json`。
    - 在 2 天以上、8 个以上会话中被指向却从未打开的页面，可能让出位置；在 2 天以上、2 个以上会话中被打开的页面，可能往前移。
    - 会话开始时的限制：最新的两个页面不动；最近的六个位置中最多变动两个，外加一个 spine 位置。每轮：只做小幅调整，不会推翻两分的相关度差距。
    - 被指向之后又被修改的页面会重新计数（按 mtime，所以 `git checkout`/`pull` 也会重置）。
    - 没有这个文件时，保持原来的排序。按需刷新：`llmwiki downstream-read <repo> --refresh-affinity`。

### 索引维护

- `/wiki-save` 只调用 `llmwiki db-health <repo> --notice`。它记录带冷却期的健康信号，可能建议运行 `/wiki-deep`，但从不压缩 SQLite，也不清理页面。
- `/wiki-deep` 先刷新索引和 lint，只有在 `db-health` 标记为符合条件时才压缩，然后再次检查。
- 只有当**压缩之后**实际索引数据仍超过 30 MiB 时，才建议运行手动、dry-run 的 `llmwiki wiki-clean <repo>`。
- 固定默认值（暂无环境变量覆盖）：
    - 压缩需要同时满足三项：数据库 **30 MiB**、空闲页比例 **10%**、空闲至少 **1 MiB**。
    - 提示的冷却期为 **7 天**；条件变化或索引增长 10% 时解除。
    - 清理分类器只考虑超过 **180 天** 的页面。缺口报告保留最近 **20** 条已解决记录。
- `wiki-clean --date YYYY-MM-DD` 只固定审查日期。`wiki-clean --commit` 和 `wiki-clean-apply` 都不属于 save/deep 的自动流程。

## 团队使用

### 共享一个项目的 wiki

一个人使用时不需要这些。以下内容都是附加的，单人使用时不会有任何动作。

每个人运行自己的引擎（自己的守护进程和队列），只把**自己的会话**记录到共享的 `docs/wiki/`。共享就是普通的 git。

- **安全的脚手架**
    - `.gitignore` 列出 `.llmwiki/`，旧版引擎写下的索引不会被提交。
    - `.gitattributes` 为 `docs/wiki/log.md` 和 `docs/wiki/**/index.md` 设置 `merge=union`，并发追加会顺利合并。
- **作者**
    - 作者信息不写入frontmatter的 `author:`，而是从考虑 `.mailmap` 的git历史中计算。
    - `0_review` 问题带有 `owner: <GitHub login>`。会话开始时显示为 `[→ login]`，其他人可以跳过。
- **队友的引用**
    - 重建索引时，每个格式正确的 `.jsonl` 引用都会登记为虚拟来源。
    - 队友的引用不会让你的 `lint` 失败。格式错误的引用仍然会报错。
- **保持最新** — 克隆落后于 origin 时，会话开始会提示一行。开始前请先 pull。
- **评审** — wiki 提交与代码走同一个分支和 PR。PR 评审就是人对 AI 所写页面的把关。
- **合并冲突**
    - `gap-queue.md` / `overview.md`：任取一边，然后重新运行 `llmwiki gaps` / `llmwiki overview`。不要手动合并。
    - `current-state.md`（L0）：取哪一边都安全，下一次 `/wiki-save` 会重新生成。保留双方 **Next** 项的并集。
    - 同一个 `5_topic` 页面：**保留双方的所有条目**。主题页面只增不减，所以并集总是正确的。

### 团队约定（`llmwiki.config.toml`，可选）

内置的文件夹是 `0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`。**没有配置文件时，一切保持不变**——测试逐字节固定了生成的提示词和规则。

要使用不同的团队格式，把 `llmwiki.config.example.toml` 复制到克隆根目录下的 `llmwiki.config.toml`，并声明你的分类：

```toml
[[category]]
dir = "1_goal"     # docs/wiki 下的文件夹名
domain = "goal"    # 分类 slug — 这里的页面为 `type: Goal`
review = "human"   # human → 0_review 队列 · model → 强模型裁定
guide = "季度目标；变更需要人确认。"
```

- **单一来源** — WRITE 提示词、会话开始规则和 `llmwiki conventions <repo>`（`/wiki-*` 技能使用）都从这个文件生成。
- **按仓库配置**（可选）
    - 在 `<clone>/configs/` 下放多个 `*.toml`。带有 `applies_to = ["<folder>", …]` 的文件作用于这些文件夹及其下所有内容（最具体的路径优先，`~` 会展开）。
    - 没有 `applies_to` 的文件是所有仓库的默认值（`configs/default.toml`，以 `configs/default.toml.example` 提供）。
    - 优先级：名称匹配 → `configs/` 默认 → 根目录 `llmwiki.config.toml` → 内置默认值。匹配依据会话钩子传入的路径（`CLAUDE_PROJECT_DIR`/cwd）。
- **检查** — `llmwiki config [workspace]` 显示选中了哪个文件以及原因。无效文件会带警告安全回退。
- **重构现有 wiki** — `llmwiki migrate <repo>`（dry-run） → `--commit`。
    - 重命名文件夹、改写链接、更新 `domain:`、写入 `.schema-version`。
    - 从不自动运行。任一方向的偏差都会在会话开始、`llmwiki doctor`、`/wiki-deep` · `/wiki-doctor` 的预检中提示。应用时总是需要明确的 `--commit`。
- **分发** — 把配置提交到团队的引擎分支 → 成员 `git pull` → 一个人运行 `migrate` → 结果像其他改动一样通过 PR 合并。`configs/*.toml` 默认被 gitignore，团队配置请用 `git add -f configs/<team>.toml` 跟踪。根目录的 `llmwiki.config.toml` 正常提交。
- **兼容性** — 配置键只在经过弃用期、lint 警告和 `migrate` 步骤之后才会移除。

## 更新引擎

更新是手动的。引擎从不自行更新。

- 守护进程每天检查一次 origin。有新版本时，下一个会话开始会显示一行提示和确切的命令。
- 这条提示**你**能看到，而不只是智能体：Claude Code 和 Codex 以钩子系统消息显示，OpenCode 弹出提示框，每个 `llmwiki` 命令会在 stderr 打印一次。
- 版本号相同但 origin 上有更新代码的情况也会提示。

```bash
cd ~/llmwiki
git pull && ./setup.sh          # 只 pull 不够 — 见下文
```

`git pull` 只改变克隆本身。守护进程继续运行启动时的代码，OpenCode 插件是配置目录中的副本。重新运行 `setup.sh` 会让它们对齐到新代码，并重启守护进程。重复运行是安全的。

`llmwiki doctor` 会报告落后的部分：

- `[update] ⚠️ v… → v… available` — 克隆落后于 `origin`。
- `[update] ⚠️ N commit(s) behind origin at the same version` — 版本号相同，但 origin 上有更新的代码。
- `[update] ⚠️ clone files changed after the last successful install` — 已经 `git pull`，但 setup 还没有刷新已安装的组件和守护进程。setup 成功后消失。
- `[daemon] ⚠️ running code older than this clone` — 守护进程运行的是 pull 之前的代码。`llmwiki daemon-sync` 只在确实落后时重启它，`llmwiki doctor --fix` 在完整检查中也做同样的事。你很少需要手动调用：`/wiki-save` 和 `/wiki-deep` 会在最后一步运行 `daemon-sync`。
- `[opencode] ⚠️ plugin stale` — 已安装的插件副本比克隆中的适配器旧。

## 卸载

```bash
cd ~/llmwiki
./setup.sh --uninstall                 # 移除 llmwiki 安装的所有钩子、插件、命令、启动器与服务
./setup.sh --uninstall --purge-data    # …并删除 llmwiki 的本地运行状态
```

- 请在移动或删除克隆**之前**，从已安装的克隆中运行。
- 按归属移除，而不是恢复备份。只删除 llmwiki 安装的条目；harness 配置中的其他内容（包括你在两次安装之间自己加的钩子）保持不变。
- 不会动你的 wiki。`docs/wiki/` 是你仓库中的普通 Markdown。
- 不加 `--purge-data` 时，保留本地状态并报告其位置。`--purge-data` 只删除 llmwiki 创建的内容。
- 每个仓库 `.git/llmwiki/` 中的登记标记，没有引擎时不起作用。用 `llmwiki disable <repo>` 单独移除。

## 本机保留的数据

| 什么 | 位置 | 保留 |
|---|---|---|
| 捕获队列（在哪些仓库、何时工作过 — 仅元数据） | `<state>/capture.db` | 直到 `--purge-data` |
| 守护进程日志（仅计数；从不记录未登记项目的路径） | `<state>/daemon.log` | 直到 `--purge-data` |
| OpenCode transcript 导出（对话正文 — llmwiki 保存的唯一正文） | `<state>/opencode-export/` | **30 天后自动删除** |
| 各项目的索引和缓存（可重建） | `<state>/projects/<id>/` | 会压缩；闲置 60 天后删除 |

- `<state>` 默认为 `$XDG_DATA_HOME/llmwiki`。旧安装留下的 `<clone>/.state` 会继续使用，可用 `llmwiki migrate-state` 迁移。
- 状态目录及其中的文件以私有权限（`0700` / `0600`）创建。
- Claude 和 Codex 的 transcript 直接从 harness 的存储中读取，llmwiki 不做副本。
- 三处存储，各有一个主人：
    - 捕获队列 — 集中存放在 `<state>` 下
    - 内容 — 每个仓库自己的 `docs/wiki/`（Markdown 是唯一来源）
    - 索引 — `<state>` 下每个项目一个目录（`llmwiki state-path <repo>`），随时可重建；仓库中只保留 `docs/wiki/`

## 前置条件

机器可读的平台、运行时、CI 和隐私契约见 [`reference/support-contract.json`](../reference/support-contract.json)。

| | 是否必需 | 说明 |
|---|---|---|
| **Bun ≥ 1.1**（推荐 1.2+） | ✔ 必需 | 单一二进制。POSIX：`curl -fsSL https://bun.sh/install \| bash`。原生 Windows 在 PowerShell 中运行 `irm bun.sh/install.ps1 \| iex`。直接运行 `.ts`，`bun:sqlite` 自带 FTS5 — 无需构建，无需 `node_modules`。只有 `bun run typecheck` 需要运行一次 `bun install`（仅开发用）。低于 1.2 时，读取 Codex 的压缩 rollout（`*.jsonl.zst`）需要 `PATH` 上有 `zstd`，`llmwiki doctor` 会显示使用了哪种方式。 |
| **git** | ✔ 必需 | 捕获会向 git 询问目录是否为 worktree。setup 也会在 `PATH` 之外查找（Homebrew、MacPorts、Nix、`~/.local/bin`），找不到时在做任何改动之前停止。`llmwiki doctor` 在 `[deps]` 下报告路径。 |
| **Codex · OpenCode CLI** | 仅用于对应的 harness | `codex` / `opencode` 需在 `PATH` 上。Codex 还需要支持 lifecycle hook，并启用稳定版 `hooks` 功能。setup 在修改钩子、技能或服务之前会先检查。 |
| **LLM CLI** | 可选，需主动启用 | 捕获、读取注入、`/wiki-*` 和 `ingest`（仅捕获）不需要它，并且**默认不发送任何内容**。只有在 shell 中设置 `LLMWIKI_LLM_CMD` 后，`autoupdate`、`review` 和 `ingest` 的整合步骤才会启动子进程（例如 `export LLMWIKI_LLM_CMD='claude -p {prompt} --model {model} --tools= --permission-mode dontAsk --strict-mcp-config --safe-mode --no-session-persistence'`）。未设置时，这些步骤报告 "unavailable" 并跳过。 |
| **操作系统** | macOS / Linux / Windows | 守护进程和无人值守更新：macOS = launchd；Linux = systemd（`--user`），没有则退回 cron+nohup；Windows = 用户级启动文件夹。macOS 和 Linux 在 CI 中运行完整测试；Windows 运行平台契约任务，其余靠人工验证。详情：[`daemon/README.md`](../daemon/README.md) |

### Harness 与操作系统说明

- **Claude Code** — `./setup.sh --harness claude`。捕获、读取注入和 `/wiki-*` 命令都会自动接好。
- **Codex** — `./setup.sh --harness codex`
    - 安装用户 CLI 和五个 `$wiki-*` 技能，并把 `SessionStart`/`UserPromptSubmit` 钩子合并到 `$CODEX_HOME/hooks.json`。
    - 仅一次：启动 Codex，在 `/hooks` 中检查确切的命令。新的或改动过的钩子在信任之前不会运行。
    - 捕获监视 `$CODEX_HOME/sessions/**/*.jsonl[.zst]`。
    - Codex Desktop 自己的 home（运行时和各账号）也会一并采集。同一个 rollout 即使被硬链接到多个 home，在队列中也只占**一行**，不会被记录两次。
    - 技能由 Codex 自身运行。无人值守的 `autoupdate`/`review` 只在设置了 `LLMWIKI_LLM_CMD` 时运行。
- **OpenCode** — `./setup.sh --harness opencode`
    - 安装全局 `/wiki-*` 命令、固定指向该克隆的读取注入插件，以及用户 CLI。
    - 捕获读取 OpenCode 的 SQLite 会话存储。`XDG_DATA_HOME`/`OPENCODE_DB` 会保留在守护进程环境中。
- **Windows** — 原生和 WSL2 都支持。
    - 在 WSL2 中一切无需修改即可运行。这也是 Claude Code 和 Codex 的官方推荐。
    - Bun 和 `bun:sqlite` 原生运行（包括 FTS5 trigram）。路径匹配会规范化反斜杠。
    - 原生：安装 Bun 和 Git，然后在 Git Bash 中运行 `./setup.sh --harness claude`（或 `all`）。即使 Windows `PATH` 上没有 `bash`，Claude Code 也会自己运行钩子脚本。
    - Codex 和 OpenCode 把 shell 命令交给 PowerShell，而 `bash` 不在 Windows `PATH` 上。因此在 Windows 上，这两个 harness 的钩子和技能直接调用 `bun <clone>/src/cli.ts` — 不需要解释器，也不需要 `PATH` 条目。
    - `~/.local/bin` 中的 `llmwiki` 启动器是 `#!/bin/sh` 脚本。只能在 Git Bash 中使用（需自行把该目录加入 `PATH`），不能在 PowerShell 或 `cmd` 中使用。harness 安装的内容都不依赖它。
    - 捕获守护进程注册在用户级**启动文件夹**中，隐藏运行。不需要管理员权限（Task Scheduler 登录项则需要）。
    - 它在登录时启动，崩溃后**不会**自动重启，与 Linux 的 `cron @reboot` 回退相同。`llmwiki doctor` 会分别报告"登录时启动"和"正在运行"。

## 故障排查

有两个 doctor，各管一件事：

- `llmwiki doctor` — 检查安装：引擎文件、守护进程、钩子、已安装的技能和用户 CLI。`--fix` 修复接线。
- `llmwiki wiki-doctor <repo>` — 检查一个项目的 `docs/wiki/`，默认只读：结构、索引新鲜度、SQLite 状态、lint、捕获连续性、缺口队列和 review 周期。`--fix` 只重建安全的派生状态。
- `/wiki-doctor`（Codex：`$wiki-doctor`） — 完整修复。引擎修复之后，智能体依据 lint 和 review 的证据修改页面内容，不删除来源，也不编造项目方向。

智能体数据不在预期位置时：

- 默认位置为空时，引擎也会查找常见的替代位置：WSL 中挂载在 `/mnt/c/Users/*` 下的 Windows 配置、XDG 变体、`~/.opencode`，以及 Codex Desktop 的各账号 home。
- 每个候选都用其数据结构验证。**在你的 home 内**只有一个通过验证的候选时，会直接连接。
- home 之外的位置从不自动连接（挂载的 Windows 配置常常属于别人）。你会得到确切的 `llmwiki connect` 命令。
- 显式设置的 `CODEX_HOME` 是唯一来源，除非它是 Codex Desktop 自己的 home（应用会把它导出到自己的终端中）。
- `llmwiki locate <harness>` 显示找到了什么。无法继续时，它会列出尝试过什么、被什么阻挡，以及可选的做法。
- `llmwiki connect <harness> <path>` 只记录通过验证的路径。

其他信号：

- 收尾抽取头部的 `# ⚠ route:` — 表示该会话的编辑落在另一个已登记的仓库，记录会被送到那个 wiki。
- shell 中还没有 `llmwiki` 启动器路径时，setup 会打印一次 `PATH` 命令。

## 结构

```
setup.sh       一键上手（与路径无关：doctor→守护进程→钩子·命令→索引）
src/           TypeScript 引擎（Bun 运行时，内置 bun:sqlite — 无 node_modules·无构建）
  cli.ts       CLI 分发器 — 40 余个子命令：init·status·disable·index·search·lint·doctor·wiki-doctor·db-health·daemon-sync·wiki-clean·locate·connect·save-current·update-*·quiz-*·autoupdate·consolidate·review·gaps·overview·ingest·bench·…（完整列表：本文件底部的 HANDLERS）
  engine/
    schema.sql   每个仓库的索引结构（documents·chunks·FTS5·references）
    db.ts        WikiIndex：索引（content_hash 增量）·检索·图·过时检测
    chunker.ts   FTS 分块（~512 token）         refs.ts    引用·链接 → 图的边
    lint.ts      结构检查（确定性）            review.ts  语义 lint（生成式·限定范围·缓存）
    gaps.ts      review 缺口 → 自动关闭的队列 0_review/gap-queue.md（无 LLM）
    quiz.ts      测验排期 + 6_quiz/quiz-ledger.md（无 LLM；出题·评分由 /wiki-quiz 完成）
    overview.ts  overview 入口规范化（无 LLM·幂等）
    synthesis.ts 确定性的主题视图（标签聚类·整合缺口）— 无 LLM·可重建
    extract.ts   transcript 增量抽取（watermark）   update.ts  日志层编排
    autoupdate.ts  无人值守的事实更新（write→二次检查→lint 门槛）
    consolidate.ts 日志→主题页面（5_topic）整合（write→独立 VERIFY→grounding→lint）
    source.ts    transcript 来源抽象（与 harness 无关）
    sources/     claude.ts · codex.ts（含 .zst） · opencode.ts（SQLite→export） · plain.ts（任意文件）
    ingest.ts    无需守护进程处理单个文件（`llmwiki ingest`）
    capture.ts   集中的捕获队列（source_kind）   doctor.ts   接线检查
    config.ts    团队约定 — llmwiki.config.toml + configs/*.toml 解析器
    migrate.ts   把 wiki 重构为配置的结构（默认 dry-run·改写链接·检测偏差）
  daemon/
    watch.ts     捕获守护进程（扫描所有来源）
    wire.ts      Claude 钩子·命令接线（~/.claude* + $CLAUDE_CONFIG_DIR）
    wire-codex.ts Codex 钩子合并 + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCode 全局插件 + /wiki-* + 共享 CLI
    list-pending-repos.ts  从队列中输出待处理的仓库（供调度器使用）
daemon/        install.sh（自动识别 launchd/systemd/cron） + autoupdate-*.sh（无人值守的事实处理）
hooks/         sessionstart-inject.sh（会话开始） · userpromptsubmit-inject.sh（每轮） · pretooluse-inject.sh（编辑时规则）
adapters/      codex/（hooks.json 模板） · opencode/（单文件插件）
skill/         wiki-save · wiki-deep · wiki-doctor · wiki-ask · wiki-quiz（/命令）
examples/      sample-wiki/ — 一个完成态的 wiki 示例。不会被索引。请勿复制 — 真实的 wiki 会在各项目的 docs/wiki 下生成。见 examples/README.md
tests/         bun:test 测试套件 — `bun test`
package.json·tsconfig.json   Bun 元数据（用于 typecheck；运行时直接执行 .ts）
```

## 回归测量工具（用于引擎开发）

这些从不进入日常循环。

- **`llmwiki bench <repo>`** — 确定性的检索基准测试（无 LLM，毫秒级）。
    - 黄金查询集：`<repo>/docs/wiki/.bench/golden.toml`（每个仓库 ≤20 条，任何语言）。
    - 评估 search any-hit `r@k` 和每轮指针命中。拒答查询在每轮钩子保持安静时判为正确。
    - 固定种子的 tune/sealed 拆分：`--tune-only` 用于反复调整，`--sealed` 仅用于最终检查（每看一次都会削弱它）。
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 冻结语料上的 A/B。
    - 用同一批 transcript，为每种配置构建隔离的临时 wiki。只有构建步骤使用 LLM。
    - 判定前先校验两份报告。格式错误或不兼容时结果为 `keep`。
    - 按顺序的门槛判定：先拦截回归，再判 keep / adopt / undecided。无 LLM。
    - 只在提示词或模型变化时运行。
- **`llmwiki bench-scale --repeats 2`** — 生成语料的规模报告。
    - 运行 10/100/1000 页三档，检查检索和上下文的正确性。
    - 时间和磁盘数值只是观测，从不作为发布门槛。
- **`llmwiki bench-capture --repeats 2 [--sessions 100,1000,10000]`** — 历史会话的规模报告。
    - 比较 Claude、Codex 和 OpenCode 的发现过程以及有上限的样本生成。
    - 测量轻量的钩子入口（会话开始、空提问、登记探测），完整 CLI 启动单独报告。
    - 计数是确定的；时间仍是观测值。

完整的可复现命令以及每个结果允许的结论：[`reference/RELEASE_GATES.md`](../reference/RELEASE_GATES.md)。

## 参与贡献

- 从 [CONTRIBUTING.md](../CONTRIBUTING.md) 开始：干净克隆下的工作流程和检查。
- 在 [ARCHITECTURE.md](../ARCHITECTURE.md) 中找到负责某项改动的模块及其安全边界。
- 迭代时运行 `bun run check:quick`；评审前运行 `bun run check`。

## 原则

- transcript 是原始且不可变的。页面只引用它，不从其他页面再生成。更新只处理 watermark 之后的部分。
- 事实由 AI 写。判断（决定的原因、内容和备选方案，以及方向）属于人。AI 的提议在人确认之前保持 `status: draft`。
- git 中的 Markdown 是唯一来源。提交使用同一个作者身份（仓库所有者）。
- 不过度设计。少于 10 万 token 时，不需要向量数据库或 RAG，`index.md` 导航就够了。
- 上下文成本不能随使用而增长。注入预算有上限。`/wiki-*` 技能只常驻加载流程（`/wiki-save` ≤ 15KB），细节在需要的步骤再取（`llmwiki conventions <repo> --section <name>`）。读取循环根据使用情况调整顺序，而不是增加文字。

## 许可证

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
