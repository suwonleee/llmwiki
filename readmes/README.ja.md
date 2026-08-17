<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki — ローカルで軽快に動く、複利で効くプロジェクトwiki。クイズを添えて

*別名: quiz wiki · llmwiki quiz · Quiz_wiki — 自分が下した決定を問い直す間隔反復（spaced repetition）レイヤー。*

[English](../README.md) · [한국어](README.ko.md) · **日本語** · [中文](README.zh.md)

どのプロジェクトでも、どのターミナル（標準/tmux/iTerm2）・コーディングエージェント（Claude Code · Codex · OpenCode）でも、そのプロジェクト固有のLLM知識が消えずに**複利で積み上がります**。

## やることは、これだけ

Git、[Bun](https://bun.sh)、いずれかのコーディングエージェントが入っていれば、あとは一度のcloneと一つのプロンプトだけです。

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

上のコマンドは現在の公開版をインストールします。再現可能な導入が必要なら、setup の前に
[Releases ページ](https://github.com/suwonleee/llmwiki/releases)でリリースタグを選んでください。
更新は常に手動です — ただしリリースを追いかける必要はありません: デーモンが1日1回originを確認し、
新しいバージョンがあれば次のセッション開始時に1行の通知と適用コマンドが表示されます。実行するのは
常にユーザー自身で、エンジンが自分を更新することはありません。このディレクトリを移動または削除する
前に、まずアンインストールしてください（下記参照）。インストール済みのフックはこのパスを参照します。

このフォルダからエージェントを**一つだけ**起動します。

```bash
claude
# または: codex
# または: opencode
```

エージェントの入力欄に、そのまま貼り付けます。

```text
setup_text.mdを読み、現在使っているコーディングエージェントとこのマシン向けにllmwikiをインストールしてください。ファイルの指示どおりに進め、ヘルスチェックまで実行し、私が手動で行う手順が残っていれば教えてください。
```

これが推奨インストール経路です。READMEは人向けの入口に留め、ハーネス分岐・ヘルスチェック・`PATH`・フック信頼・OS・復旧規則は、エージェント契約 [`setup_text.md`](../setup_text.md) と [インストールフロー参照](../reference/INSTALLATION_FLOW.md) に置きます。

### 次に、プロジェクトごとに一度だけ有効化

インストールはマシン単位ですが、**リポジトリを登録するまではどこでも何もしません**。

```bash
llmwiki init /absolute/path/to/my-project
```

`init` はwikiの雛形を作り、そのワークツリー固有の `.git/` 配下に登録マーカーを置きます。
実行前は、完成済みの `docs/wiki/` があっても、コールドスタート注入・ターンごとの注入・
セッションキャプチャはすべて無効です。cloneは信頼の決定ではないためです。以後、追加の確認は
不要です。

- `llmwiki status <repo>` — 有効か、無効なら理由を表示
- `llmwiki verify <repo> --harness <harness>` — 導入・登録・索引・cold-start作業記憶を一括確認
- `llmwiki disable <repo>` — wikiを残したまま無効化
- CLIで探す: `llmwiki --help` は初回の流れとコマンド群を表示し、
  `llmwiki <command> --help` は実行せずに個別の使い方を表示し、`llmwiki --version` は
  エンジンのバージョンを表示します。
- 自動連携はGit専用・ワークツリー単位。リポジトリを移動した場合は `init` を再実行
- すべてのハーネス構成が同じユーザー用 `llmwiki` ランチャーを導入します。必要な場合は
  setupが表示する `PATH` コマンドを一度適用します
- **エージェントは作業するプロジェクトのディレクトリから起動**: セッションは自分のcwdのwikiを読み、
  そこにキャプチャされ、そこに記録されます。編集が実際には別の登録済みリポジトリに向かったセッションは、
  クローズアウト時に抽出ヘッダーの `# ⚠ route:` 行で示され、正しいwikiに記録されるよう誘導されます

セットアップが正常終了したら、同じセットアップセッションでエージェントに依頼します。

```text
今インストールしたエンジンで /absolute/path/to/my-project に llmwiki を初期化してください。プロジェクトwikiを検証し、このコーディングエージェントのセッション終了コマンドも教えてください。
```

そのプロジェクトでコーディングエージェントを開き、普段どおり作業します。意味のあるセッションの最後に、Claude Code・OpenCodeでは `/wiki-save`、Codexでは `$wiki-save` を実行します。バックログと深いメンテナンスには、定期的に `/wiki-deep`（Codex: `$wiki-deep`）を使います。プロジェクトwikiに問題がありそうなら `/wiki-doctor`（Codex: `$wiki-doctor`）を実行します。

wikiが正しく積み上がっているか確認するときは、そのプロジェクトのエージェントに貼り付けます。

```text
このプロジェクトで /wiki-doctor を実行してください。安全な生成状態と根拠のあるページ問題を修復し、修正した内容とまだ注意が必要な点を要約してください。Codexでは $wiki-doctor を実行してください。
```

### 自分好みにするなら — ファイル一つ

エンジンコードはそのまま。以下はすべて設定ファイル一つで変えられます。

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # 英語・コメント付き
```

| 設定 | 何が変わるか |
|---|---|
| `[wiki] lang` | **エンジン**が書く言語。未設定ならセッションの言語に従います（ウィキの既存ページ → 無ければエージェントに打った言葉）。固定するなら `en` · `ko` · `ja` · `zh`。ページの言語はどちらの場合も常に会話の言語です |
| `[[category]]` | wikiのフォルダ構成と、それぞれに置く内容 |
| `[quiz] questions` | クイズ一回の問題数 — `5_topic` · `0_review` · `6_quiz` フォルダは固定構造 |
| `[private] dirs` | 自分には索引されるが、コミットされないフォルダ |
| `[models]` | 下書きを書くモデル（`light`）と検証するモデル（`heavy`） |
| `legacy_dirs` | 改名後も走査を続ける旧フォルダ — コアファイル三つ（`current-state` · `overview` · `log`）は固定構造 |
| `[lint.banned_terms]` | 警告したい表現（推奨のみ・阻止しない） |

一番簡単な方法: 望むことをエージェントに伝えて `llmwiki.config.toml` だけを編集させ、`llmwiki config <プロジェクトのパス>` で結果を確認します。既存ページの移行は、ユーザーが明示的に承認するまで実行されません。

MCPサーバー、Docker、外部データベース、ベクトルDB、クラウドサービスは不要です。llmwikiはローカルのBun・フック・キャプチャデーモン・SQLiteとgit markdownを使います。エージェント向けのインストール契約は [`setup_text.md`](../setup_text.md) にあります。

- **これは何か**
    - エージェント環境のためのLLM維持型プロジェクトwiki — ソースは作業トランスクリプト、保存は素のgit markdown
    - エンジン = ローカルライブラリ: SQLiteインデックス · 決定的lint · 引用/相互参照グラフ · content-hash差分
    - その上に自動キャプチャデーモン + トランスクリプト複利 — **MCP登録は不要**
- **分業**
    - 事実 — AIが無人で記述
    - 判断（方向性 · 決定 · 矛盾）— 常に人間同席
    - 人間の記憶 — 日次の忘却曲線クイズ（`/wiki-quiz`）で、モデルのコンテキストと同じくらい自分の決定への記憶も維持
- **2層構造、単一ソース**
    - セッション別 *ログブック* — 時間軸: `2_milestone` · `3_decision` · `4_insight`
    - 概念別 *トピック百科* — `5_topic`、トピック軸 · in-place統合
    - どちらもrawトランスクリプトからのみ再導出 — wiki→wikiの再導出は禁止

核となるアイデア — LLMが維持し、人間は方向だけを決めるプロジェクトwiki — は [Andrej KarpathyのLLM-wikiノート](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)に由来します。参照した外部資料はそのノートただ一つで、設計とコードは独自実装です。

## 手動インストールの代替

エージェントを使わず意図的に直接インストールする場合だけ使用します。ハーネスを一つ選び、検出済みの全ハーネスを配線する意図がなければ `auto` は使いません。

```bash
./setup.sh --harness claude
# または: ./setup.sh --harness codex
# または: ./setup.sh --harness opencode
```

- setupが表示した次のコマンドをそのまま使用
    - macOS・Linux・WSL2の全ハーネス: ユーザー用 `llmwiki …`
    - ネイティブWindowsの全ハーネス: 明示的な `bun <clone>/src/cli.ts …`; 任意の
      `llmwiki` ランチャーはGit Bash専用で、Codex/OpenCodeはPowerShellを使用
- 表示された手動アクションを完了
    - Codexのみ: `/hooks` で現在のllmwikiフック2つを確認・信頼
    - OpenCode: 初回セットアップまたはclone再指定後に再起動
- 全分岐・復旧基準: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)

## 複利のループ

六つの輪 — 二つは完全無人、残りは各1コマンドです。

| 輪 | 内容 | 自動? | 実装 |
|------|------|:---:|------|
| **キャプチャ** | 全セッショントランスクリプト → 中央キュー | ✔ | `src/daemon/watch.ts`（ターミナル/プロファイル非依存） |
| **凝縮（update）** | キュー → そのリポジトリの `docs/wiki/` **ログ層**（増分append） | 1コマンド | Codex: `$wiki-save` / `$wiki-deep` · Claude/OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/update.ts` |
| **統合（consolidate）** | ログ → 概念別**トピック百科** `5_topic/`（in-placeマージ·raw再グラウンディング） | 1コマンド | Codex: `$wiki-save` / `$wiki-deep` · Claude/OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/consolidate.ts` |
| **読み込み** | コールドスタート注入 + ターン毎の関連ページポインタ | ✔ | `hooks/sessionstart-inject.sh` · `hooks/userpromptsubmit-inject.sh`（Claude Code; Codex/OpenCodeは `adapters/`） |
| **クイズ（人間の記憶）** | wikiの判断層 → **人間のための**日次・忘却曲線の間隔反復クイズ（`6_quiz/` 記録 — インデックス/検索から除外; コールドスタートにdue件数1行） | 1コマンド | Codex: `$wiki-quiz` · Claude/OpenCode: `/wiki-quiz` + `src/engine/quiz.ts`（`quiz-status`·`quiz-next`·`quiz-record`） |
| **自己治癒** | 構造（orphan·stale·dangling）= 決定的 `lint` / 意味（矛盾·古い主張·概念欠落）= 生成的 `review`（sync時自動 — エンジン管理の周期 `--if-due` 既定7日·範囲限定+キャッシュ）→ ギャップは `gaps` の自己終了キュー（`0_review/gap-queue.md`） | 1コマンド → 自動 | `lint`·`review`·`gaps`（`src/engine/{lint,review,gaps}.ts`） |

- **transcriptの保存** — transcriptはllmwikiではなくエージェントのファイル
    - 各エージェントの保存ポリシーでローテーション（Claude Codeは既定~30日 · Codexは終了セッションを`.zst`圧縮）— llmwikiはコピーを持たない
    - 残したいセッションはローテーション前に`/wiki-save`で締める · transcriptが既に消えたキュー行はdeepパスが整理（`capture-prune`、30日ガード）

### 人間の記憶ループ（`/wiki-quiz`）

他の輪はすべて**モデル**をグラウンディングし、この輪だけが**人間**を研ぎます。

- **なぜ存在するか**
    - 分業が人間に残す委譲不能な唯一の仕事 = 方向性 + 矛盾の判断
    - その判断力は、自分の過去の決定への記憶とともに鈍る
- **スケジュール方式** — エンジン側で決定的、LLMゼロ
    - 日単位の忘却曲線: ボックス 1·3·7·16·35·60日
    - 不正解・スキップ → 1日にリセット · 同じ項目を同日に二度出題しない
    - 範囲: wikiの判断層 — 方向性 > 決定 > 洞察·トピック > マイルストーン、同格なら新しい順
- **セッションの進み方** — 一括で事前作問
    - エンジンがdue項目を選ぶと、セッションが該当ページをまとめて読んで全問を先に作成 — 1問答えると次問が待ちなしで表示
    - 採点はページに基づく要旨（gist）採点 · 間違えた問題は翌日最初に再出題
    - 問題数: `llmwiki.config.toml` の `[quiz] questions` — 既定 **3**、`/wiki-quiz 5` のように引数で増加、エンジン上限 **7**（人がスキップするクイズは何も強化しない）
- **記録の場所**
    - `docs/wiki/6_quiz/` — 台帳 + 日別セッションノート
    - インデックス/検索/コールドスタートから除外される人間専用レイヤー — LLMが自らのクイズ出力を餌にしない: wiki → 人間の厳密な一方向

### 根拠がページと一緒に移動する（ページフォーマット v3）

`[^s1]: <セッション>.jsonl` のような引用は**一台のマシンにしかない**トランスクリプトを指します — チームメイトは結論を読めても、その根拠は開けません。v3は根拠そのものを1〜2行、脚注の直下のインデント行に置きます。

```markdown
- ログ層は残し、その上にトピック層を重ねることにした [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "ログはそのまま、上に重ねよう — 置き換えの方がリスクだ"
```

- **フォーマット契約**
    - 脚注定義行は従来とバイト単位で同一 — この行を読むパーサは四つあり、その一つがチームメイトの引用のエラーを防ぐ
    - 抜粋は `llmwiki excerpt` のみが生成 — 原文どおり · 長さ上限 · 機密スクリーニング（生トランスクリプトには実際に資格情報が混ざるため）
    - 判断の主張は人間の発言を、事実の主張はツール実行記録を引用
- **人が走り読みできる本文構造**
    - 読む順の番号セクション — `## 1. <ラベル>`、セクションが本当に分かれるときだけ `### 1-1. <ラベル>`；要点が一群だけの短いページは箇条書きのみ
    - セクション内：`-` 一行につき具体的な事実・決定・結果・行動を一つ · 補足は `    -` · さらに深い詳細は `        -`（第四階層はなし）
    - 一行に列挙を詰めない：項目が三つを超えたら親行 + 項目ごとの子箇条書きへ（`·` 連結は禁止 — lint `dense-bullet`）
    - 語尾はそのページの言語で自然な名詞句・体言止め · 行為者・条件・結果が不明瞭になる場合のみ動詞を残す
    - 抽象的な前置き · 見出し/TL;DR の反復 · 親を言い換えただけの子箇条書きは禁止（長いページにセクションがなければ lint `flat-body`）
- **lintの立場**
    - 引用の検証はそのトランスクリプトを**読めるマシン上でのみ**実施 — 読めないクローンでは沈黙（「検証できない」を「誤り」と読ませない）
- **検索コストゼロ**
    - 抜粋は検索インデックスとトピックページ予算から除外 — 根拠を付けても検索品質も本文の分量も損なわない

### 自己治癒フロー（人間は埋めるだけ）

wikiが何が欠けているかを自分で報告し、人間は埋める判断だけを行います。

- **締め（`/wiki-save`）· deepパス（`/wiki-deep`）の際**
    - ① 決定的 `lint` — 構造（orphan · stale · dangling）
    - ② 生成的 `review` — 意味（矛盾 · 古い主張 · 概念欠落）; `--if-due` で自動実行しつつエンジンが周期を強制（既定7日、`LLMWIKI_REVIEW_INTERVAL_DAYS`）· 入力は直近+タグ隣接ページに限定 · 無変更ならスキップ · deepパスは無条件実行
    - ③ `gaps` — `review` が見つけた*概念欠落 · 次の問い*を追跡キュー（`0_review/gap-queue.md`）へ積載
- **ギャップの閉じ方**
    - そのトピックで一度作業するか、deepパスが埋めれば充足
    - `review` が2回連続で挙げなければ自動close
- **ギャップの自動生成は意図的に無し** — 薄い根拠からページをでっち上げないため

## 構成

```
setup.sh       ワンクリック導入（パス非依存: doctor→デーモン→フック·コマンド→インデックス）
src/           TypeScriptエンジン（Bunランタイム、bun:sqlite内蔵 — node_modules·ビルド 0）
  cli.ts       CLIディスパッチャ — 40超のサブコマンド: init·status·disable·index·search·lint·doctor·wiki-doctor·db-health·wiki-clean·locate·connect·save-current·update-*·quiz-*·autoupdate·consolidate·review·gaps·overview·ingest·bench·…（全リスト: このファイル末尾のHANDLERS）
  engine/
    schema.sql   リポジトリ毎のインデックススキーマ（documents·chunks·FTS5·references）
    db.ts        WikiIndex: インデックス（content_hash増分）·検索·グラフ·staleness
    chunker.ts   FTSチャンキング（~512トークン）      refs.ts    引用·リンク → グラフエッジ
    lint.ts      構造の衛生検査（決定的）      review.ts  意味lint（生成的·sync時自動·範囲限定+無変更スキップのキャッシュ）
    gaps.ts      reviewのギャップ（概念欠落·次の問い）→ 自己終了キュー 0_review/gap-queue.md（LLM 0; 2回不在でclose）
    quiz.ts      人間の記憶ループ — 忘却曲線（日単位）スケジューリング + 優先度選別 + 6_quiz/quiz-ledger.md（LLM 0; 出題·採点は /wiki-quiz がウォームで）
    overview.ts  overviewエントリポイント正規化（Recent Updates→logポインタ·予算警告、LLM 0·冪等）
    synthesis.ts 決定的な関係統合 + トピックビュー（タグクラスタ·統合ギャップ、`topics`）— LLM 0·再生成可（`digest`/`topics`+コールドスタートspine）
    extract.ts   トランスクリプト増分抽出（watermark）   update.ts  ログ層オーケストレーション
    autoupdate.ts  無人の事実update（write→二次検証→lintゲート）
    consolidate.ts ログ→トピック百科（5_topic）統合（write→独立VERIFY（追加claim）→グラウンディング→lint、独立watermark）
    source.ts    トランスクリプトソース抽象化（discover/probe/parseアダプタ — ハーネス非依存）
    sources/     claude.ts（claude-jsonl）· codex.ts（Codex rollout、.zst含む）· opencode.ts（OpenCode SQLite→export）· plain.ts（任意ファイルdrop）
    ingest.ts    デーモン無しで1ファイル凝縮（`llmwiki ingest` — ソースをdrop）
    capture.ts   中央キャプチャキュー（.state/capture.db、source_kind）   doctor.ts   配線点検
    config.ts    チーム規約 — llmwiki.config.toml + configs/*.toml のリポジトリ別resolver（applies_to prefix; 設定無し=標準構造; プロンプト/規則がここからレンダリングされる単一ソース）
    migrate.ts   wikiをconfig構造へ移行（dry-run既定·リンク書き換え·.schema-version·ドリフト検知）
  daemon/
    watch.ts     キャプチャデーモン（sources() スイープ — 既定はClaudeプロファイルのトランスクリプト）
    wire.ts      Claudeフック·コマンド配線（~/.claude* + $CLAUDE_CONFIG_DIR）
    wire-codex.ts Codexフックマージ + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCodeグローバルプラグイン + /wiki-* + 共有CLI
    list-pending-repos.ts  キューからpendingリポジトリのみ出力（スケジューラ用）
daemon/        install.sh（launchd/systemd/cron自動検出）+ autoupdate-*.sh（無人の事実パス）
hooks/         sessionstart-inject.sh（コールドスタート注入）· userpromptsubmit-inject.sh（ターン毎ポインタ注入）
adapters/      codex/（ネイティブフック hooks.json テンプレート）· opencode/（プラグイン1ファイル）
skill/         wiki-save（セッション締め）·wiki-deep（deep定期パス）·wiki-doctor（診断・修復）·wiki-ask·wiki-quiz（人間の記憶）（/コマンド）
examples/      sample-wiki/ — 完成wikiの例（読み取り専用）。エンジンは非インデックス（IGNORE_DIRS）。**コピー禁止** — 実wikiは各プロジェクトの docs/wiki に自動生成。examples/README.md 参照
tests/         bun:testスイート（chunker·refs·lint·extract·capture·db·source·review-scope·overview·gaps·quiz·マイグレーション）— `bun test`
package.json·tsconfig.json   Bunメタデータ（typecheck用; ランタイムは .ts を直接実行）
```

保存の原則 — 三つの置き場、それぞれ持ち主は一つです。

- キャプチャキュー — 中央: `<clone>/.state/capture.db`
- コンテンツ — 各リポジトリの `docs/wiki/`（コロケーション; markdown = 真実源）
- インデックス — `<repo>/.llmwiki/index.db`（いつでも再生成可能）

## アンインストール

```bash
cd ~/llmwiki
./setup.sh --uninstall
./setup.sh --uninstall --purge-data    # ローカル実行状態も削除
```

削除は所有権マーカーに基づき、llmwikiが設置したフック・プラグイン・コマンド・サービスだけを
取り除きます。他の設定と各プロジェクトの `docs/wiki/` は変更しません。インストール元のcloneを
移動・削除する前に、そのcloneから実行してください。`--purge-data` を付けない場合、ローカル状態は
保持され、場所だけが表示されます。

- `--purge-data` はllmwikiが作成した生成物だけを削除 — llmwikiが作っていないディレクトリやファイルには決して触れません
- プロジェクト毎の登録マーカーは各リポジトリの `.git/llmwiki/` に残り、エンジンなしでは不活性。`llmwiki disable <repo>` で明示的に除去

## このマシンに保持されるデータ

| 内容 | 場所 | 保持期間 |
|---|---|---|
| キャプチャキュー（リポジトリと時刻のメタデータ） | `<clone>/.state/capture.db` | `--purge-data` まで |
| デーモンログ（集計のみ） | `<clone>/.state/daemon.log` | `--purge-data` まで |
| OpenCode transcript export（会話本文） | `<clone>/.state/opencode-export/` | **30日後に自動削除** |

状態ディレクトリは `0700`、ファイルは `0600` で作成されます。ClaudeとCodexのtranscriptは
各ハーネスの保存場所から読み、llmwiki側には複製しません。

## 前提条件

| | 必要 | 備考 |
|---|---|---|
| **Bun ≥ 1.1** | ✔ 必須 | 単一バイナリ — POSIX: `curl -fsSL https://bun.sh/install \| bash`; ネイティブWindows: PowerShellで `irm bun.sh/install.ps1 \| iex`（POSIXインストーラーはWindowsでは動作しません）。`.ts` を直接実行、`bun:sqlite` がFTS5まで同梱 — ビルド·`node_modules` 0。エンジン実行·`bun test` はインストール不要; `bun run typecheck`（tsc）のみ一度 `bun install` が必要（dev専用）。 |
| **Codex · OpenCode CLI** | 各クイックスタートのみ | `codex` / `opencode` が `PATH` にあること。Codexは加えてlifecycle hook対応 + stable `hooks` 機能の有効化が必要。setupはフック·スキル·サービスを変更する前に、対応状況と既存の機能設定を確認。 |
| **LLM CLI** | 任意・オプトイン | キャプチャ·読み込み注入·`/wiki-*`·`ingest`（capture-only、保留updateをキュー）は無くても動作し、**既定では何もどこにも送りません**。`autoupdate·review` と `ingest` の統合は、シェル環境で `LLMWIKI_LLM_CMD` を設定したときだけ生成サブプロセスを起動します（例: `export LLMWIKI_LLM_CMD='claude -p {prompt} --model {model} --disallowedTools Write Edit NotebookEdit Bash'`）。未設定ならそれらのパスは「利用不可」として skip し、決定的な処理はすべて動き続けます。 |
| **OS** | macOS / Linux / Windows | 正式なサポート契約: [`reference/support-contract.json`](../reference/support-contract.json)。macOS=launchd、Linux=systemd（`--user`）、systemdが無ければcron+nohupへフォールバック、Windows=ユーザー別スタートアップフォルダー。デーモン詳細は [`daemon/README.md`](../daemon/README.md) |

### ハーネス · OSノート（Claude Code / Codex / OpenCode / Windows）

- **Claude Code** — `git clone … && ./setup.sh --harness claude`、以上
    - キャプチャ · 読み込み注入 · `/wiki-*` コマンドすべて自動配線
- **Codex (OpenAI)** — `./setup.sh --harness codex`
    - ユーザーCLI + `$wiki-*` スキル5つを導入し、`$CODEX_HOME/hooks.json` にnative `SessionStart`/`UserPromptSubmit` フックをマージ
    - 初回のみ: Codexを起動し `/hooks` で正確なコマンドをレビュー — 新規·変更フックは信頼されるまで実行されない
    - キャプチャは `$CODEX_HOME/sessions/**/*.jsonl[.zst]` を監視
    - ウォームスキルはCodex自体で動作 · 無人の `autoupdate`/`review` は `LLMWIKI_LLM_CMD` を設定したときのみ動作
- **OpenCode** — `./setup.sh --harness opencode`
    - グローバル `/wiki-*` カスタムコマンド、クローン固定の読み込み注入プラグイン、ユーザーCLIを導入
    - キャプチャはSQLiteセッションストアを読む · `XDG_DATA_HOME`/`OPENCODE_DB` もデーモン環境に保存
- **Windows** — ネイティブ・WSL2ともにサポート
    - Bun·`bun:sqlite` はネイティブ動作 · パスマッチングはバックスラッシュを正規化
    - ネイティブWindowsはGit Bashで `.sh` セットアップを実行。デーモンは権限昇格なしでユーザー別スタートアップフォルダーへ自動登録
    - WSL2ならすべて無修正で動作（launchd→systemd · bash · パス）— Claude Code·Codexの公式推奨とも一致

## インストール / 使い方

**このリポジトリをどこにでも、任意の名前でcloneして `./setup.sh` を実行**すると、そのマシンのエンジンになります。

- 全配線（デーモン · フック · CLI · `/wiki-*` コマンド）はcloneの場所自体から導出 — `~/llmwiki` のような固定パス不要、フォルダ名は自由
- Bunさえあれば `.ts` がそのまま実行 — バンドル·ビルド工程なし
- cloneの移動·更新後はsetupを再実行 — 生成スキルと配線を冪等に更新

```bash
# 0) エンジンをclone（マシン毎に1回）— 場所·名前は不問
git clone https://github.com/suwonleee/llmwiki.git
cd llmwiki

# 1) ワンショット導入 — doctor → キャプチャデーモン（OS自動検出）→ ハーネス配線 → doctor
./setup.sh --harness claude              # または: codex · opencode · auto（autoは検出された全ハーネスを配線）

# 2) あとは働くだけ — どのフォルダ·ターミナルでもセッションが自動キャプチャ
#    リポジトリ毎の手動コマンド: bun <clone>/src/cli.ts init|index|search|lint <repo>

# 3) エージェントのプロンプトでセッションを締める
/wiki-save                               # セッションの締め（Codex: $wiki-save）
/wiki-ask                                # このプロジェクトのwikiに質問（Codex: $wiki-ask）
/wiki-deep                               # deep定期パス（Codex: $wiki-deep）
/wiki-doctor                             # このwikiを診断・修復（Codex: $wiki-doctor）
/wiki-quiz                               # 人間の記憶ループ（Codex: $wiki-quiz）
```

> 個別ステップ: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` ·
> `bun <clone>/src/daemon/wire.ts`（Claude）· `wire-codex.ts` / `wire-opencode.ts`（Codex/OpenCode）—
> 各wireスクリプトは `--revert` で自分の変更だけを巻き戻し。

### インストールdoctorとプロジェクトwiki doctor

- `llmwiki doctor` — llmwikiインストール自体の点検: エンジンファイル·デーモン·フック·導入済みスキル·ユーザーCLI。`--fix` は配線を修復
- `llmwiki wiki-doctor <repo>` — 1プロジェクトの `docs/wiki/` を既定で読み取り専用のまま診断: 構造·インデックス鮮度·SQLite整合性/容量·lint·キャプチャ連続性·gapキュー·セマンティックレビュー周期。`--fix` は安全な派生/生成状態のみ再構築
- `/wiki-doctor`（Codex: `$wiki-doctor`）— 修復ワークフロー全体を実行。決定的なエンジン修復の後、エージェントが残りのlint/レビュー根拠を読み、出典を消さず·プロジェクトの方向を創作しない範囲でページ内容を修正

## 設定（環境変数）— プロバイダ · モデル · CLI 非依存

生成パス（autoupdate/review）は**明示的に有効化するまで停止**しています。無設定では
サブプロセスを起動せず、どのproviderにも何も送りません。マシン環境で `LLMWIKI_LLM_CMD` を
設定した場合だけ有効になり、リポジトリ設定・Markdown・追跡ファイル・自動読込される `.env`
からは有効化できません。送信前には必ずsecret screeningを行います。

| env | 既定値 | 用途 |
|---|---|---|
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | 推論級tier — VERIFY（敵対的ゲート）·review（意味検査） |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | 下書き級tier — WRITE（ページ生成） |
| `CLAUDE_CONFIG_DIR` | （Claude Code標準） | 設定するとそのディレクトリもClaudeプロファイルとして認識 — フック配線（wire）·キャプチャ（claude source）·doctorが揃って尊重。 |
| `LLMWIKI_LLM_CMD` | **未設定 — サブプロセスもネットワークも無し** | LLM呼び出しのargvテンプレート。`{prompt}`·`{model}` をトークン単位で置換（シェルパース無し）。`{prompt}` が無ければpromptはstdinへ。引用符が要るmulti-word値はJSON配列（`["my-llm","--q","{prompt}"]`）で。Codex·`llm`·ollamaなど任意のCLIが可。 |
| `LLMWIKI_STATE_DIR` | `<clone>/.state` | 任意のマシンローカル状態パス。リポジトリの `.env` では変更不可。新規・空・既にllmwiki所有のパスだけを許可し、他者の非空ディレクトリは拒否。 |
| `LLMWIKI_LANG` | `en` | コールドスタートの運用規則/ヘッダの言語。`ko` で韓国語。（wiki本文は書かれたまま — UI文言のみ切替。） |
| `LLMWIKI_SEARCH_RELAX` | （on） | `off` で緩和フォールバック無効 — 自然文クエリがstrict ANDで0件のとき、同じ語をORで1回だけ再試行（trigram安全·Unicode/CJK対応·stopwordリスト無し）。A/B測定用キルスイッチ。 |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144`（256KB） | ソースファイル毎のコンテンツ上限。超過ファイル（数MBのyaml/jsonフィクスチャ等）はメタデータのみ登録 — 名前·パスでは見つかるが全文インデックスは除外。wikiページは対象外。フィクスチャの多いリポジトリでもインデックスを小さく、検索を速く — 検索/turn-context品質は不変。 |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | `review` 1パスの入力上限。wikiがこれを超えると直近+タグ隣接ページのみレビュー（プロンプト溢れ防止）。 |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` の周期ゲート — 最後にコミットされたreviewからこの日数が経って初めて実行（それまでは約0.03秒で決定的にskip）。セッション締めのreviewコストを既定でゼロに。 |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` ページ肥大警告（`topic-oversize`、advisory）の文字予算 — 超過時はdeepパスが引用トランスクリプトから書き直し、`distill-verify`（引用セット縮小禁止）でゲート。 |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview` が警告を出す overview.md の文字予算（エントリポイント肥大の監視; `--check` は書き込みなしのプレビュー）。 |
| `LLMWIKI_L0_BUDGET` | `1600` | コールドスタートL0（current-state）の文字**基準**。注入は**切らない** — 基準超過ページも全量注入し超過通知1行を付加（次の締めにトリムを促す）; `oversized-l0` lintは1.25×から警告。 |

- 各tierを「その時点の最上位モデル」へ上げるか、非Anthropicのモデル/エンドポイントへ差し替え可能
- **ハーネス非依存の読み込み**
    - `bun <clone>/src/cli.ts context <repo>` — コールドスタートのコンテキスト · `… turn-context <repo>`（フックstdin JSONまたは `--prompt`）— ターン毎の関連ページポインタ（≤3行、確信が無ければ沈黙）
    - Claude Codeは両フックを自動配線 · 最近のCodexは同じフックスクリプトをネイティブ実行（`adapters/codex/`）· OpenCodeは1ファイルプラグインが注入（`adapters/opencode/`）
    - その他のハーネスはAGENTS.mdや起動プロンプトから同じコマンドを呼ぶだけ
    - ターン毎注入はprogressive enhancement — コールドスタート + `search` のベースラインはどこでも同一

### インデックス保守のエスカレーション（上限つき · オプトイン）

`/wiki-save` は `llmwiki db-health <repo> --notice` を呼ぶだけです: クールダウン付きの健全性シグナルを記録し `/wiki-deep` を勧めることはあっても、SQLiteのcompactやセマンティック整理は決して実行しません。`/wiki-deep` はまずインデックスとlintを更新し、healthコマンドが適格と示した場合のみcompactして再確認します。**compact後も**ライブインデックスが30 MiBを超えるときだけ、手動·既定dry-runの `llmwiki wiki-clean <repo>` を勧めます。compactで解消するfree-ratio単独の圧力は「整理アクションなし」と報告されます。

既定値は意図的に保守的で、現在環境変数での上書きはありません: compactは**DB 30 MiB**·**free-page比率10%**·**free-page 1 MiBの下限**の三条件すべてを要求します。notice状態のクールダウンは**7日**（適格性の変化またはインデックス10%成長で解除）。可逆クリーンアップの分類器は**180日**を過ぎた古いページのみ候補とし、gapレポートは直近の解消**20件**を保持。`wiki-clean --date YYYY-MM-DD` は決定的なレビュー日付を与えるだけで — `wiki-clean --commit` も `wiki-clean-apply` もsave/deep自動化には含まれません。

## チーム利用（1プロジェクトのwiki共有）

一人で使う場合、以下は一切不要です — すべて追加的（additive）で、単独利用では沈黙します。複数人が一つのプロジェクトで働くときは、各自が自分のローカルエンジン（自分のキャプチャデーモン·キュー）を回し、**自分のセッションだけ**を共有 `docs/wiki/` に凝縮します。共有は素のgitです。

- **スキャフォールドの安全装置**
    - `.gitignore` を自動シード — `.llmwiki/`（派生インデックス）はコミットされない
    - `.gitattributes` を自動シード — `docs/wiki/log.md merge=union`、同時appendが衝突せずマージ
- **帰属**
    - 著者情報はfrontmatterの `author:` に保存せず、`.mailmap` を反映したgit履歴から算出
    - `0_review` の質問には `owner: <GitHub login>` を記録 — コールドスタートが `[→ login]` と表示、自分宛でない質問はスキップ
- **チームメイトの引用は自己治癒**
    - 正しい形式の `.jsonl` 引用はインデックス再構築時に仮想ソースとして自動登録（トランスクリプトはどのみちローテーション）
    - チームメイトの引用が自分の `lint` ゲートを壊さない · 形式の壊れた引用は従来どおりerror
- **連続性**
    - クローンがoriginより遅れているとコールドスタートが1行で通知 — チームメイトがマージした文脈があり得るため、開始前にpull
- **レビューの流れ**
    - wikiコミットはコードと同じブランチ·同じPR — **PRレビューこそがAI作成ページの人間ゲート**
    - `gap-queue.md`/`overview.md` が衝突したら: どちらか一方を取り `llmwiki gaps` / `llmwiki overview` を再実行（収束する）— 生成された本文の手動マージは禁止
- **安全と確認済みの衝突2種**
    - `current-state.md`（L0）: どちらを取っても安全 — 次の `/wiki-save` がwiki状態からNow/Nextを再導出して収束 · ただし**Next**の箇条書きだけは両側の和集合を推奨（保留アクションを失わない）
    - 同じ `5_topic` ページへの同時追記: **両側の箇条書きを全部保持** — トピックページはフォーマット規則上追記専用（既存行は不変·マージは追加のみ）で、和集合が常に正しいマージ

## チーム規約 — `llmwiki.config.toml`（任意）

標準カテゴリ構造（`0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`）が組み込みの既定です — **configファイルが無ければ何も変わりません（バイト単位で同一**、レンダリングされたプロンプト/規則が既存テキストと一致することをテストが固定）。別のチームフォーマットを使うには `llmwiki.config.example.toml` をクローンのルートに `llmwiki.config.toml` としてコピーし、カテゴリを宣言します:

```toml
[[category]]
dir = "1_goal"     # docs/wiki 配下のフォルダ名
domain = "goal"    # このフォルダへルーティングされる frontmatter domain
review = "human"   # human → 0_review キュー · model → 強モデルによる確定
guide = "四半期目標。変更は人間が確定。"
```

- **単一の真実源**
    - WRITEプロンプト、コールドスタート運用規則、`llmwiki conventions <repo>`（`/wiki-*` スキルが委譲する出力）がすべてこのファイルからレンダリング — ドリフトする散文コピーが無い
- **リポジトリ別config**（任意）
    - `<clone>/configs/` 配下に複数の `*.toml` を配置 — `applies_to = ["<フォルダ>", …]` があればそのフォルダと配下全体に適用（segment-safe prefix · 最も具体的なパスが勝ち · `~` 展開）
    - `applies_to` が無ければ全リポジトリの既定（正準名: `configs/default.toml`）
    - 優先順位: named一致 → `configs/` default → ルート `llmwiki.config.toml` → 組み込み既定 · 一致はセッションフックが渡すパス（`CLAUDE_PROJECT_DIR`/cwd）基準
- **確認** — `llmwiki config [workspace]`
    - どのファイルがなぜ選ばれたかを表示（検証込み）· 不正/読めないファイルは警告と共に安全フォールバック — セッションを壊さない
- **既存wikiの再構成** — `llmwiki migrate <repo>`（dry-run）→ `--commit`
    - フォルダrename + 全wikilink/相対リンクの書き換え + frontmatter `domain:` 更新 + `.schema-version` スタンプ
    - 自動実行は無し — コールドスタートはドリフトを双方向（wikiがconfigより新しい / configがwikiより新しい）に検知·提案のみ
- **チーム配布**
    - configをチームのエンジンフォークにコミット → 各自 `git pull` → 1人が `migrate` を実行 → 結果は他の変更と同様PRでマージ
- **互換性の規律**
    - configキーの削除は、非推奨期間 + lint警告 + `migrate` ステップを経た後のみ — 静かな削除は禁止

## 回帰測定（エンジン開発ツール — 日常ループの外）

- **`llmwiki bench <repo>`** — 決定的な検索ベンチマーク（LLMゼロ、ms単位）
    - ゴールデンクエリセット: `<repo>/docs/wiki/.bench/golden.toml`（リポジトリ毎≤20、言語不問）
    - 採点: search any-hit `r@k` + turn-contextのポインタ的中/沈黙 — refusalクエリはturn-contextが沈黙すれば正解（構造判定なので言語中立）
    - シード固定のtune/sealed分割 — `--tune-only` は自由な反復用、`--sealed` は最終確認専用（sealed結果は見るたびに回帰ガードとしての価値が下がる）
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 凍結corpus A/B
    - 同じトランスクリプトcorpusから設定/リビジョン毎の隔離一時wikiをビルド — armビルドだけがLLMステップ
    - ラベル付き結果2つを逐次ゲートで判定: 回帰ブロック優先 → keep/adopt/undecided、LLMゼロ
    - プロンプト·モデル変更時のみ実行

## 原則

- トランスクリプト = raw不変 — 引用のみ、wiki→wiki再導出は禁止 · 増分 = watermark以降のみ処理
- 事実 = AI自動 / 判断（決定のWhy·What·Alt·方向性）= 人間 — `status: draft` フラグ
- git markdown = 単一の真実源 — コミットは単一作成者の名義（リポジトリ所有者）
- 過剰設計の禁止 — 100kトークン未満ならvector DB·RAG不要（index.mdナビゲーションで十分）

## ライセンス

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
