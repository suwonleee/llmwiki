<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki

コーディングエージェントが書いて読む、ローカルのプロジェクトwiki。自分が下した決定をクイズで問い直します。

[English](../README.md) · [한국어](README.ko.md) · **日本語** · [中文](README.zh.md)

コーディングエージェントは、セッションごとにゼロから始まります。llmwikiはプロジェクトの中（`docs/wiki/`）にwikiを置き、過去のエージェントセッションをもとに、gitの素のMarkdownとして記録します。セッション開始時とプロンプトごとに、必要な部分をエージェントに渡します。事実はAIが書き、決定と方向性は人が決めます。

## 主な特徴

- **セッションから作られるwiki** — セッションの最後に `/wiki-save` を実行すると、そのセッションがwikiページになります。gitで読み、直し、レビューできます。
- **自動で読み戻される** — セッション開始時に短い現状ページ（*L0*）、プロンプトごとに関連する抜粋、ルールが掛かったファイルを編集する直前にはそのルール（Claude Code）。
- **Claude Code・Codex・OpenCodeに対応** — これらのコーディングエージェント（以下 *ハーネス*）が、プロジェクトごとに一つのwikiを共有できます。
- **ただのファイル** — gitの中のMarkdown。形式は [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)（OKF v0.2）。
- **ローカルのみ** — 自分のマシン上のBunとSQLiteだけを使います。MCPサーバー・Docker・ベクトルDB・クラウドサービスは不要です。`LLMWIKI_LLM_CMD` を設定しない限り、何も外部へ送りません。
- **コストが増えない** — 注入するコンテキストには上限があり、wikiの大きさに比例しません。
- **有効にするまでオフ** — `llmwiki init` を実行するまで、プロジェクトには何もしません。
- **クイズ** — `/wiki-quiz` が、自分の過去の決定について間隔反復で短く質問します。

## クイックスタート

Git、[Bun](https://bun.sh) 1.1以上、コーディングエージェント一つが必要です。

### 1. インストール

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

- 現在の公開版をインストールします。再現可能なインストールが必要なら、先に [Releasesページ](https://github.com/suwonleee/llmwiki/releases) でタグを選びます。
- cloneはその場所に置いたままにします。インストールされたフックがこのパスを指します。移動・削除の前にアンインストールします。

このフォルダでエージェントを**一つだけ**起動します。

```bash
claude
# または: codex
# または: opencode
```

エージェントに次を貼り付けます。

```text
setup_text.md を読み、このマシンと現在使っているコーディングエージェントに llmwiki をインストールしてください。ファイルの指示に正確に従い、ヘルスチェックを実行し、手動で残っている手順があれば教えてください。
```

- これが推奨のインストール方法です。エージェントが [`setup_text.md`](../setup_text.md) に従い、ヘルスチェックまで実行します。
- ハーネスごとの分岐・`PATH`・フックの信頼・OSノート・復旧手順は [インストールフローのリファレンス](../reference/INSTALLATION_FLOW.md) にあります。
- エージェントを使わない場合は [手動インストールの代替](#手動インストールの代替) を参照してください。

### 2. プロジェクトで有効にする

インストールだけでは何も起きません。登録するまで、プロジェクトはそのままです。

セットアップが正常終了したら、同じセットアップセッションでエージェントに依頼します。

```text
今インストールしたエンジンで /absolute/path/to/my-project に llmwiki を初期化してください。プロジェクトwikiを検証し、このコーディングエージェントのセッション終了コマンドも教えてください。
```

自分で実行しても構いません。

```bash
llmwiki init /absolute/path/to/my-project     # プロジェクトごとに1回
```

- `init` は `docs/wiki/` を作り、そのワークツリーの `.git/` 配下に登録マーカーを置きます。
- `init` の前は、コンテキスト・注入・キャプチャは一切ありません。`docs/wiki/` がすでにあっても同じです。他人のリポジトリをcloneしたことは、そこでllmwikiを動かす決定ではないからです。
- `init` の後は、確認のプロンプトは出ません。
- **OpenCodeのみ — セットアップ後に一度再起動**（cloneを再指定した後も）。OpenCodeはプロセス起動時にプラグインを読み込みます。Claude CodeとCodexは次のセッションから反映されます。
- 登録はGit専用で、ワークツリー単位です。リンクされたワークツリー（`git worktree add`）はメインワークツリーの登録を引き継ぎ、`llmwiki disable <ワークツリー>` で個別に外せます。
- リポジトリを移動したら `init` を再実行します（マーカーがパスを記録しているため）。

### 3. 使う

そのプロジェクトでコーディングエージェントを開き、普段どおり作業します。エージェントはプロジェクトのディレクトリから起動します。セッションは自分のcwdのwikiを読み、そこに記録します。

| いつ | Claude Code / OpenCode | Codex |
|---|---|---|
| 意味のあるセッションの最後 | `/wiki-save` | `$wiki-save` |
| ときどき（バックログ・深い整理） | `/wiki-deep` | `$wiki-deep` |
| wikiに質問する | `/wiki-ask` | `$wiki-ask` |
| wikiがおかしいとき | `/wiki-doctor` | `$wiki-doctor` |
| クイズに答える | `/wiki-quiz` | `$wiki-quiz` |

wikiの状態を確認するには、そのプロジェクトのエージェントに貼り付けます。

```text
このプロジェクトで /wiki-doctor を実行してください。安全な生成状態と根拠のあるページ問題を修復し、修正した内容とまだ注意が必要な点を要約してください。Codexでは $wiki-doctor を実行してください。
```

よく使うコマンド:

- `llmwiki status <repo>` — 有効かどうか、無効ならその理由
- `llmwiki verify <repo> --harness <harness>` — 配線・登録・インデックス・セッション開始時の内容をまとめて確認
- `llmwiki disable <repo>` — 無効にする（wikiファイルは残る）
- `llmwiki --help` — 初回の流れとコマンド群。`llmwiki <command> --help` は実行せずに使い方だけを表示。`llmwiki --version` はエンジンのバージョンを表示

## その他のインストール方法

### プラグインでインストール（cloneなし）

このリポジトリはClaude Code / Codexのプラグインマーケットプレイスでもあります。

```bash
# Claude Code
claude plugin marketplace add suwonleee/llmwiki
claude plugin install llmwiki@llmwiki

# Codex（その後 /hooks で2つのフックを一度承認）
codex plugin marketplace add https://github.com/suwonleee/llmwiki
codex plugin add llmwiki@llmwiki
```

- プラグインには読み取りループと `/wiki-*` スキルが入っています。
- バックグラウンドのキャプチャデーモンは**cloneインストールにのみ**含まれます。マシンごとにどちらか一つを選びます。cloneインストールがあれば、フックがそれを検出して譲ります。
- リポジトリごとに登録します。そのリポジトリのセッションで `/wiki-doctor` を実行するか、`bun <plugin-root>/src/cli.ts init <repo>`。登録しないリポジトリには何も注入しません。
- Bunは引き続き必要です。ない場合は、セッション開始時に一度知らせて以後は黙ります。
- コスト: セッションごとに常時読み込まれるスキルのメタデータが約330トークン。
- インストール前に [プラグインの開示事項](../PLUGIN.md)、[プライバシーポリシー](../PRIVACY.md)、[利用規約](../TERMS.md)、[サポート案内](../SUPPORT.md) を確認してください。

### 手動インストールの代替

エージェントを使わずに直接インストールする場合だけ使います。ハーネスを一つ選びます。`auto` は検出したすべてのハーネスを配線します。

```bash
./setup.sh --harness claude
# または: ./setup.sh --harness codex
# または: ./setup.sh --harness opencode
```

- setupが表示した次のコマンドをそのまま使用
    - macOS・Linux・WSL2の全ハーネス: ユーザー用 `llmwiki …`
    - ネイティブWindowsの全ハーネス: 明示的な `bun <clone>/src/cli.ts …`; 任意の `llmwiki` ランチャーはGit Bash専用で、Codex/OpenCodeはPowerShellを使用
- 表示された手動アクションを完了
    - Codexのみ: `/hooks` で現在のllmwikiフック2つを確認・信頼
    - OpenCode: 初回セットアップまたはclone再指定後に再起動
- 全分岐・復旧基準: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)
- `./setup.sh --dry-run` は、ファイルやサービスを変えずに計画だけを表示します。
- cloneの場所とフォルダ名は自由です。すべてのフック・コマンド・サービスはcloneの場所から決まります。
- cloneを移動・更新したらsetupを再実行します。何度実行しても安全です。
- 個別の手順: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` · `bun <clone>/src/daemon/wire.ts`（Claude） · `wire-codex.ts` / `wire-opencode.ts`。各wireスクリプトは `--revert` で自分の変更だけを元に戻します。

## 仕組み

ループは6段階です。2つは自動で、残りはそれぞれコマンド一つです。

1. **キャプチャ**（自動） — バックグラウンドのデーモンが、すべてのセッションのtranscriptをキューに入れます。フォルダやターミナルは問いません。
2. **更新**（`/wiki-save`） — キューの新しい部分を、プロジェクトのログ層（`2_milestone`、`3_decision`、`4_insight`）に追記します。
3. **統合**（`/wiki-save`、`/wiki-deep`） — ログを概念ごとのページ（`5_topic/`）にまとめます。
4. **読み取り**（自動） — セッション開始時にL0とページへのポインタ、プロンプトごとに関連ポインタや抜粋を最大3つ、ルールが掛かったファイルの編集前にはそのルール（Claude Code）。
5. **クイズ**（`/wiki-quiz`） — wikiの決定から作る間隔反復の質問。人のための段階です。
6. **自己治癒**（`/wiki-save`、`/wiki-deep`） — `lint` が構造を、`review` が意味を点検し、`gaps` が欠けているものを追跡します。

役割分担:

- **事実** — AIが無人で書く。
- **判断**（方向性・決定・矛盾） — 常に人。
- **自分の決定についての記憶** — `/wiki-quiz` で保つ。
- ページは生のtranscriptからだけ作り、他のwikiページから作り直しません。

transcriptはllmwikiではなく、エージェントのファイルです。

- 各エージェントのスケジュールで入れ替わります（Claude Codeは約30日、Codexは終了したセッションを `.zst` に圧縮）。llmwikiはコピーを作りません。
- 残したいセッションは、消える前に `/wiki-save` で締めます。transcriptがすでにないキュー行は、deepパスが整理します（`capture-prune`、30日のガード）。

LLMが維持し人が方向を決めるプロジェクトwikiという発想は、[Andrej KarpathyのLLM-wikiノート](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) から来ています。参照した外部資料はこのノートだけで、設計とコードは独自のものです。

### クイズ（`/wiki-quiz`）

他の段階は**モデル**を根拠の上に置きます。この段階は**人**の記憶を保ちます。判断力は、過去の決定の記憶とともに薄れるからです。

- **スケジュール** — エンジンが決定的に処理。LLMなし。
    - 日単位の忘却曲線: 1・3・7・16・35・60日のボックス。
    - 間違えたりスキップしたら1日に戻る。同じ項目を1日に2回は聞かない。
    - 優先順位: 方向性 > 決定 > インサイト・トピック > マイルストーン。同列なら新しい順。
- **1回のセッション**
    - エンジンが期限の来た項目を選び、エージェントがそのページを読んで問題を先にすべて作ります。次の問題は待たずに表示されます。
    - 採点はページに基づく要旨の採点です。間違えた問題は翌日最初に出ます。
    - 問題数: `llmwiki.config.toml` の `[quiz] questions`。既定は **3**、実行ごとに増やせます（`/wiki-quiz 5`）、上限は **7**。
    - 質問が出る場所: Claude Code `AskUserQuestion`（1回に4問） · OpenCode `question` · Codex `request_user_input`（1回に3問。Planモードの外では `codex features enable default_mode_request_user_input` の実行後のみ）。それ以外では番号付きブロック一つで表示。
- **記録** — `docs/wiki/6_quiz/`（台帳と日別ノート）。人専用のフォルダで、インデックス・検索・注入の対象外です。

### 根拠がページと一緒に移動する（ページフォーマット v3）

`[^s1]: <session>.jsonl` のような引用は、**1台のマシンにしかない**transcriptを指します。チームメイトは結論は読めても、根拠は見られません。v3は根拠を1〜2行、脚注の下に一緒に置きます。

```markdown
- ログ層は捨てずに、その上にトピック層を重ねることにした [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "ログはそのままにして上に重ねよう。置き換えるほうが危ない"
```

- **フォーマット**
    - 脚注の行そのものは変わりません。この行を読むパーサーが4つあります。
    - 抜粋は `llmwiki excerpt` だけが作ります。原文どおり、長さに上限があり、秘密情報をスクリーニングします。
    - 判断の主張は人の発言を、事実の主張はツールの実行記録を引用します。
- **ページ本文**
    - 読む順に番号付きセクション（`## 1. <見出し>`、`### 1-1. <見出し>`）。短いページは箇条書きだけで十分。
    - `-` 1行に要点一つ、補足は `    -`、さらに詳しくは `        -`（4段目はなし）。
    - 3項目を超える列挙は、親1行と項目ごとの子箇条に分ける（lint: `dense-bullet`）。
    - 自然な所では短い体言止め。親や見出しを繰り返さない（セクションのない長いページは lint: `flat-body`）。
- **lint** は、transcriptを読める場所でだけ引用を検証します。他のcloneでは黙ります。「確認できない」が「間違い」と読まれてはいけないからです。
- **検索** は抜粋を無視するので、根拠を付けても検索品質とページ予算は減りません。

### Open Knowledge Format (OKF v0.2)

`docs/wiki/` は [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) バンドルです。OKFリーダーならそのまま開けて、llmwikiもどのOKFバンドルでも読めます。

- すべてのページに `type`（`Decision` · `Topic` · `Current State` …）、`status`（`stable` · `draft` · `deprecated`）、`generated: { by, at }`、脚注ごとに `sources` 項目一つ。
- リンクは `[[wikilink]]` ではなく、相対Markdownリンク。
- フォルダごとに生成される `index.md`。`log.md` は日付グループで新しい順（`llmwiki log-append`）。
- 既存wikiの変換は一度だけ、人が決めて行います: `llmwiki okf <repo>`（dry-run） → `--commit`。適合確認は `llmwiki okf --bundle docs/wiki`。
- 外部リーダーでも確認済み: Googleのリファレンスパーサーとビューア、`W4G1/okf`、`okf-rs`、`okf-studio` がエラー0で開きます（韓国語のファイル名を含む）。
- llmwiki独自のフィールドは拡張キー `x-llmwiki` 一つにまとめます。他のリーダーは無視し、`llmwiki okf` は保持します。

### 自己治癒

wikiが何が欠けているかを報告し、人は判断だけを埋めます。

- `/wiki-save`・`/wiki-deep` のとき:
    1. `lint`（決定的） — 構造: orphan・stale・danglingのページ。
    2. `review`（生成的） — 意味: 矛盾・古くなった主張・概念の欠落。締めくくりでは期限が来たときだけ実行し（`--if-due`、既定7日、`LLMWIKI_REVIEW_INTERVAL_DAYS`）、最近のページと関連ページだけを見ます。deepパスは常に実行します。
    3. `gaps` — 概念の欠落と次の質問を `0_review/gap-queue.md` に集めます。
- ギャップは、誰かがそのテーマで作業したとき、deepパスが埋めたとき、または `review` が2回続けて報告しなかったときに閉じます。
- 乏しい根拠からページを作り出すことはしません。

## 効果はあるのか

### エージェントは先の決定を守るのか — 対照実験

wikiを書くのは簡単でも、コーディングエージェントにそれを守らせるのは難しい。実務リポジトリ2つで、実際のClaude Codeセッションを使って測りました（2026-10-13/14）。

1. あるセッションが会話でプロジェクトのルールを決めて締めくくります。
2. 後の新しいセッションが、そのルールに関わる別の作業を受けます。
3. ブラインド採点者が、変更がルールに従っているかを確認します。

| エージェントが持っていたもの | 先の決定を守った割合 |
| --- | --- |
| wiki なし | — （Q&A: 正答率 0.57、幻覚 23%） |
| wiki あり（Q&A の質問） | 正答率 0.73–0.78、幻覚 4–8%（480回） |
| 決定が wiki ページにしかない（コーディング作業） | **0/8** — コーディング32回でエージェントは wiki ページを一度も開かず検索もしなかった |
| 決定を L0 の「有効なルール」1行に | **8/8** |
| 決定はページのみ、編集時 + プロンプトごとの抜粋で配信 | **8/8**（抜粋のみ 4/8、編集時 gate のみ 7/8） |

その結果、v0.14.0で変わったこと:

- 人が決めたルールは具体的な1行としてL0に残り、適用パスがタグ付けされます（`x-llmwiki: { applies_to, rule, recall }`）。
- プロンプトごとのブロックは、タイトルだけでなくルール本文を載せます。
- 対象パスのファイルを編集しようとすると（EditツールでもBashの書き込みでも）、編集の前にルールがエージェントに示されます（Claude Code）。

数字を読むときの注意:

- 標本は小さいです: リポジトリ2つ、シナリオ4つ、条件ごと8回、採点モデル1つ。
- 課題は、素直な変更がルールを破るように作っています。配信の仕組みが機能する根拠であって、あなたのルールがどれほど頻繁に効くかの主張ではありません。
- OKFへの変換だけでは正答率は変わりませんでした（+0.03、誤差の範囲）。効果はエージェントに実際に届く内容から生まれます。
- 新規ユーザーとして、隔離したHOMEに新しくcloneして実行した場合（`./setup.sh` → `llmwiki init` → セッション → `/wiki-save` → 新しいセッション）、2/2のシナリオでルールが守られました。1回は編集時のgateにより、もう1回はプロンプトごとの抜粋を見たエージェントが自ら決定ページを開いたことによります。

### 11週間、毎日使ってみた結果

開発者1名、マシン1台、リポジトリ19個、ページ997件 — 2026-08-21の実測であり、推計ではありません。エンジンが自分自身について報告する数値で、`llmwiki doctor`・`llmwiki bench`・`llmwiki downstream-read` により自分のwikiで確認できます。

| 観察したこと | 実測 | なぜ重要か |
| --- | --- | --- |
| セッションのコストがwikiの大きさに比例しない | 最大のリポジトリ（236ページ）でセッション開始時の注入6.7KB | ポインタ数には上限があり、比例しない |
| 検索が速いまま | 同じリポジトリで検索0.11秒・プロンプトごとのフック0.16秒 | 毎プロンプト走るループ |
| 派生データは作り直しやすい | 全件再インデックス6.9秒 | wikiはgitのMarkdownで、インデックスは捨ててよい写し |
| ローカル状態が増え続けない | wiki 19個で合計167MB | キャプチャがハーネス自身の保持期間とともに期限切れになる |
| 一つのwikiを複数のエージェントが読む | 同じリポジトリでCodexとClaude Codeの双方から閲覧記録 | エージェントを替えても知識がゼロから始まらない |
| 効果が低いときも計測する | ポインタ開封率2.1% | 仮定せず報告する。同じ計器が自身の標本欠陥（54セッション中5件だけを読んで出した「0%」）も検出した |

一人の開発者が一台のマシンで、本人が書く言語のwikiで得た数値です。この規模でエンジンが軽く正直に動くことを示すもので、チーム運用・他のコーパス・回答品質についての主張ではありません。

### リリース検証の範囲

- すべてのリリース候補を、固定した新しいcloneから検証します: Claudeフック、Codexフック、OpenCodeプラグインのコールバック、登録、キャプチャ、締めくくり、再起動、次のセッションでの検索。
- 検索のfixtureが、生成ページ10・100・1,000件で正しさを確認します。
- 文書化されたmacOS・Linux・ネイティブWindows・WSL2の分岐、ローカル限定のデータ境界、公開パッケージに入る正確なファイルを確認します。
- 主張しないこと: 実際のモデルが常に良いページを書くこと、初めての人が助けなしに流れを理解できること。ユーザビリティ調査は事前登録のみで、参加者の結果はまだありません。
- 正確な境界: [リリースゲート](../reference/RELEASE_GATES.md)、[サポート契約](../reference/support-contract.json)、[ユーザビリティ調査プロトコル](../reference/USABILITY_STUDY.md)。

## 設定

### 設定ファイル（`llmwiki.config.toml`）

以下はすべて一つのファイルで変えます。エンジンのコードはそのままです。

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # 英語・詳しいコメント付き
```

| 設定 | 何が変わるか |
|---|---|
| `[wiki] lang` | **エンジン**が書く言語。未指定ならセッションに従う（既存ページ → 自分が入力した言葉）。`en` · `ko` · `ja` · `zh` で固定可能。ページの言語は常に会話の言語 |
| `[[category]]` | wikiのフォルダ構成と、各フォルダに入れる内容 |
| `[quiz] questions` | クイズ1回の問題数。`5_topic` · `0_review` · `6_quiz` フォルダは固定 |
| `[private] dirs` | 自分にはインデックスされるが、コミットされないフォルダ |
| `[models]` | 下書きのモデル（`light`）と検証のモデル（`heavy`） |
| `legacy_dirs` | 名前を変えた後も読み続ける旧フォルダ。中核ファイル（`current-state` · `overview` · `log`）は固定 |
| `[lint.banned_terms]` | 警告する表現（助言のみ、ブロックしない） |

- いちばん簡単な方法: やりたいことをエージェントに伝え、`llmwiki.config.toml` だけを編集させます。結果は `llmwiki config <project-path>` で確認します。
- 既存のページは、明示的に承認するまで移行しません。

### 環境変数

生成パス（`autoupdate`、`review`）は**有効にするまでオフ**です。

- 何も設定しなければ、llmwikiはサブプロセスを起動せず、どのプロバイダにも何も送りません。
- マシンの環境に `LLMWIKI_LLM_CMD` を設定することが一度きりのオプトインです。リポジトリの設定・Markdown・追跡ファイル・自動読み込みされる `.env` では有効にできません。
- 有効にした後も、transcriptやページから取ったブロックは、プロンプトに入る前に秘密情報のスクリーニングを通ります。スクリーニング後に何も残らなければ、呼び出しを取り消します。

| env | 既定値 | 用途 |
|---|---|---|
| `LLMWIKI_LLM_CMD` | **未設定 — サブプロセスもネットワークもなし** | LLM呼び出しのコマンドテンプレート。`{prompt}`・`{model}` をトークン単位で置換（シェル解析なし）。`{prompt}` がなければstdinで渡す。引用符が要る複数語の値はJSON配列（`["my-llm","--q","{prompt}"]`）。どのCLIでも可（Codex、`llm`、ollama…） |
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | 推論ティア — VERIFYと `review` |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | 下書きティア — WRITE（ページ生成） |
| `CLAUDE_CONFIG_DIR` | （Claude Code標準） | 配線・キャプチャ・doctorがこのディレクトリもClaudeプロファイルとして扱う |
| `LLMWIKI_STATE_DIR` | `$XDG_DATA_HOME/llmwiki`（または既存の `<clone>/.state`） | マシンローカルの状態の場所。リポジトリの `.env` では変えられない。独自のパスは、新規・空・すでにllmwiki所有のいずれかのみ |
| `LLMWIKI_LANG` | `en` | セッション開始時のルールと見出しの言語（`ko` で韓国語）。wikiの本文は変わらない |
| `LLMWIKI_SEARCH_RELAX` | （on） | `off` で、0件の検索語をORで一度だけ再試行するフォールバックを無効化。A/B計測用 |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144`（256KB） | ソースファイルごとのサイズ上限。超えたファイルは名前でのみ検索可能。wikiページは対象外 |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | `review` 1回の入力上限。大きなwikiでは最近のページとタグ関連ページだけを見る |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` は前回のreviewからこの日数が経ってから実行。それまでは約0.03秒でスキップ |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | `5_topic` ページの文字数予算（`topic-oversize`、助言）。超えるとdeepパスが出典から書き直し、`distill-verify` で確認（引用が減ってはいけない） |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | `overview` が警告する文字数予算（`--check` は書き込まずにプレビュー） |
| `LLMWIKI_L0_BUDGET` | `1600` | L0（`current-state`）の文字数の**目安**。注入では切らない: 長いページもすべて注入し、1行の通知を付ける。`oversized-l0` lintは1.25倍から警告 |

- 各ティアは、最新の上位モデルや、Anthropic以外のモデル・エンドポイントに替えられます。

読み取りはどのハーネスでも動きます。

- `bun <clone>/src/cli.ts context <repo>` はセッション開始時のコンテキストを出力します。`… turn-context <repo>`（フックのstdin JSONまたは `--prompt`）は関連ポインタを最大3つ出力し、確信がなければ黙ります。
- Claude Codeは2つのフックを自動で配線します。最近のCodexは同じフックスクリプトをネイティブに実行します（`adapters/codex/`）。OpenCodeは1ファイルのプラグインで注入します（`adapters/opencode/`）。
- その他のハーネスは、AGENTS.mdや起動プロンプトから同じコマンドを呼べます。
- プロンプトごとの注入は追加機能です。セッション開始時のコンテキストと `search` はどこでも同じです。
- 読み取りループは、どのポインタが実際に開かれたかを学び、それを**並べ替えにだけ**使います。テキストは増やしません。
    - デーモンが1日1回、出力の記録とハーネスごとの閲覧記録を、プロジェクトごとの小さな `affinity.json` にまとめます。
    - 2日以上・8セッション以上で示され、一度も開かれなかったページは枠を譲ることがあります。2日以上・2セッション以上で開かれたページは上がることがあります。
    - セッション開始時の制限: 最新の2つは動かさず、最近の6枠のうち最大2枠とspine 1枠だけが変わる。プロンプトごと: 関連度2点の差を覆さない小さな補正。
    - ポインタで示された後に変更されたページは、数え直しになります（mtime基準なので `git checkout`/`pull` でもリセット）。
    - ファイルがなければ従来の順序のまま。手動更新: `llmwiki downstream-read <repo> --refresh-affinity`。

### インデックスの保守

- `/wiki-save` は `llmwiki db-health <repo> --notice` だけを呼びます。クールダウン付きの状態シグナルを記録し、`/wiki-deep` を勧めることがあるだけで、SQLiteのcompactやページ整理はしません。
- `/wiki-deep` はインデックスとlintを先に更新し、`db-health` が対象と判定したときだけcompactして、再確認します。
- **compact後も**ライブのインデックスが30 MiBを超えるときだけ、手動・dry-runの `llmwiki wiki-clean <repo>` を勧めます。
- 固定の既定値（環境変数での上書きはまだなし）:
    - compactの条件は3つすべて: DB **30 MiB**、空きページ率 **10%**、空き **1 MiB** 以上。
    - 通知は **7日** のクールダウン。対象判定が変わるか、インデックスが10%増えたら解除。
    - 整理の分類器は **180日** を過ぎたページだけを候補にします。gapレポートは解消済みの最新 **20件** を残します。
- `wiki-clean --date YYYY-MM-DD` はレビュー日を固定するだけです。`wiki-clean --commit` も `wiki-clean-apply` も、save/deepの自動処理には含まれません。

## チームでの利用

### 1プロジェクトのwikiを共有する

一人で使うなら不要です。ここにあるものはすべて追加的で、一人の利用では何も起きません。

各自が自分のエンジン（自分のデーモンとキュー）を動かし、**自分のセッションだけ**を共有の `docs/wiki/` に記録します。共有は素のgitです。

- **安全な雛形**
    - `.gitignore` に `.llmwiki/` を入れ、古いエンジンが作ったインデックスがコミットされないようにします。
    - `.gitattributes` が `docs/wiki/log.md` と `docs/wiki/**/index.md` に `merge=union` を設定し、同時の追記が衝突せずにまとまります。
- **著者**
    - 著者情報はfrontmatterの `author:` に保存せず、`.mailmap` を反映したgit履歴から算出します。
    - `0_review` の質問には `owner: <GitHub login>` が付きます。セッション開始時に `[→ login]` と表示され、他の人は飛ばせます。
- **チームメイトの引用**
    - インデックスを作り直すとき、形式の正しい `.jsonl` の引用はすべて仮想ソースとして登録されます。
    - チームメイトの引用が自分の `lint` を壊すことはありません。形式が壊れた引用は引き続きエラーです。
- **最新を保つ** — cloneがoriginより遅れていると、セッション開始時に1行で知らせます。始める前にpullします。
- **レビュー** — wikiのコミットはコードと同じブランチ・PRに載せます。PRレビューが、AIが書いたページに対する人の確認です。
- **マージの衝突**
    - `gap-queue.md` / `overview.md`: どちらかを取り、`llmwiki gaps` / `llmwiki overview` を再実行。手でマージしない。
    - `current-state.md`（L0）: どちらを取っても安全。次の `/wiki-save` が作り直します。両側の **Next** の箇条は和集合で残します。
    - 同じ `5_topic` ページ: **両側の箇条をすべて残す**。トピックページは増えるだけなので、和集合が常に正しい。

### チーム規約（`llmwiki.config.toml`、任意）

組み込みのフォルダは `0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic` です。**設定ファイルがなければ何も変わりません。** 生成されるプロンプトとルールがバイト単位で同じであることを、テストで固定しています。

別のチーム形式を使うには、`llmwiki.config.example.toml` をcloneのルートに `llmwiki.config.toml` としてコピーし、カテゴリを宣言します。

```toml
[[category]]
dir = "1_goal"     # docs/wiki 配下のフォルダ名
domain = "goal"    # カテゴリのスラッグ — ここのページは `type: Goal`
review = "human"   # human → 0_review キュー · model → 強いモデルで確定
guide = "四半期目標。変更は人が確定する。"
```

- **一か所で管理** — WRITEプロンプト、セッション開始時のルール、`llmwiki conventions <repo>`（`/wiki-*` スキルが使う）がすべてこのファイルから作られます。
- **リポジトリ別の設定**（任意）
    - `<clone>/configs/` の下に複数の `*.toml` を置きます。`applies_to = ["<folder>", …]` を持つファイルは、そのフォルダと配下すべてに適用されます（最も具体的なパスが優先、`~` は展開）。
    - `applies_to` のないファイルは、全リポジトリの既定です（`configs/default.toml`。`configs/default.toml.example` として同梱）。
    - 優先順位: 名前の一致 → `configs/` の既定 → ルートの `llmwiki.config.toml` → 組み込みの既定。一致の判定は、セッションフックが渡すパス（`CLAUDE_PROJECT_DIR`/cwd）が基準。
- **確認** — `llmwiki config [workspace]` が、どのファイルがなぜ選ばれたかを表示します。不正なファイルは警告付きで安全にフォールバックします。
- **既存wikiの構造変更** — `llmwiki migrate <repo>`（dry-run） → `--commit`。
    - フォルダ名の変更、リンクの書き換え、`domain:` の更新、`.schema-version` の記録。
    - 自動では実行しません。どちら向きのずれも、セッション開始時・`llmwiki doctor`・`/wiki-deep` · `/wiki-doctor` の事前点検で知らせます。適用には常に明示的な `--commit` が必要です。
- **配布** — 設定をチームのエンジンのフォークにコミット → 各自 `git pull` → 一人が `migrate` を実行 → 結果はPRでマージ。`configs/*.toml` は既定でgitignoreされるので、チームの設定は `git add -f configs/<team>.toml` で追跡します。ルートの `llmwiki.config.toml` は普通にコミットされます。
- **互換性** — 設定キーは、廃止の猶予期間・lintの警告・`migrate` の手順を経てからでないと削除しません。

## エンジンの更新

更新は手動です。エンジンが自分を更新することはありません。

- デーモンが1日1回originを確認します。新しいバージョンがあれば、次のセッション開始時に1行の通知と正確なコマンドが表示されます。
- 通知はエージェントだけでなく**あなたに**見えます: Claude Code・Codexはフックのシステムメッセージ、OpenCodeはトースト、すべての `llmwiki` コマンドはstderrに一度表示します。
- バージョン番号は同じでも、originのコードが新しい場合も知らせます。

```bash
cd ~/llmwiki
git pull && ./setup.sh          # pull だけでは不十分です — 下記参照
```

`git pull` が変えるのはcloneだけです。デーモンは起動したときのコードで動き続け、OpenCodeのプラグインは設定ディレクトリにあるコピーです。`setup.sh` を再実行すると、これらを新しいコードに合わせ、デーモンも再起動します。何度実行しても安全です。

`llmwiki doctor` が遅れているものを知らせます。

- `[update] ⚠️ v… → v… available` — cloneが `origin` より遅れている。
- `[update] ⚠️ N commit(s) behind origin at the same version` — バージョン番号は同じだが、originに新しいコードがある。
- `[update] ⚠️ clone files changed after the last successful install` — `git pull` はしたが、setupがインストール済みの構成要素とデーモンをまだ更新していない。setupが成功すれば消える。
- `[daemon] ⚠️ running code older than this clone` — デーモンがpull前のコードで動いている。`llmwiki daemon-sync` は実際に遅れているときだけ再起動し、`llmwiki doctor --fix` も全体点検の中で同じことをします。手で呼ぶことはまれです: `/wiki-save` と `/wiki-deep` が最後の手順で `daemon-sync` を実行します。
- `[opencode] ⚠️ plugin stale` — インストール済みのプラグインのコピーが、cloneのアダプタより古い。

## アンインストール

```bash
cd ~/llmwiki
./setup.sh --uninstall                 # llmwikiが導入したフック・プラグイン・コマンド・ランチャー・サービスをすべて削除
./setup.sh --uninstall --purge-data    # ローカルのランタイム状態も削除
```

- cloneを移動・削除する**前に**、インストールしたcloneから実行します。
- バックアップの復元ではなく、所有権に基づいて削除します。llmwikiが入れた項目だけを消し、ハーネス設定の残り（その間に自分で足したフックを含む）はそのままです。
- wikiには触れません。`docs/wiki/` は自分のリポジトリにある普通のMarkdownです。
- `--purge-data` なしでは、ローカル状態を残して場所だけを知らせます。`--purge-data` はllmwikiが作ったものだけを消します。
- 各リポジトリの `.git/llmwiki/` にある登録マーカーは、エンジンがなければ何もしません。個別の解除は `llmwiki disable <repo>`。

## このマシンに保持されるデータ

| 何 | 場所 | 保持 |
|---|---|---|
| キャプチャキュー（どのリポジトリでいつ作業したか — メタデータのみ） | `<state>/capture.db` | `--purge-data` まで |
| デーモンログ（集計値のみ。未登録プロジェクトのパスは記録しない） | `<state>/daemon.log` | `--purge-data` まで |
| OpenCodeのtranscriptエクスポート（会話本文 — llmwikiが保存する唯一の本文） | `<state>/opencode-export/` | **30日後に自動削除** |
| プロジェクトごとのインデックスとキャッシュ（再生成可能） | `<state>/projects/<id>/` | 圧縮。60日使われなければ削除 |

- `<state>` の既定は `$XDG_DATA_HOME/llmwiki` です。古いインストールの `<clone>/.state` があればそれを使い続け、`llmwiki migrate-state` で移せます。
- 状態ディレクトリとその中のファイルは、非公開の権限（`0700` / `0600`）で作られます。
- ClaudeとCodexのtranscriptは、ハーネスの保存場所からその場で読むだけで、コピーは作りません。
- 保存場所は3つ、それぞれ持ち主は一つ:
    - キャプチャキュー — 中央、`<state>` の下
    - コンテンツ — 各リポジトリの `docs/wiki/`（Markdownが原本）
    - インデックス — `<state>` の下のプロジェクトごとのディレクトリ（`llmwiki state-path <repo>`）。いつでも再生成できるので、リポジトリには `docs/wiki/` だけが残ります

## 前提条件

プラットフォーム・ランタイム・CI・プライバシーについての機械可読な契約は [`reference/support-contract.json`](../reference/support-contract.json) です。

| | 必要 | 備考 |
|---|---|---|
| **Bun ≥ 1.1**（1.2+ 推奨） | ✔ 必須 | 単一バイナリ。POSIX: `curl -fsSL https://bun.sh/install \| bash`。ネイティブWindowsはPowerShellで `irm bun.sh/install.ps1 \| iex`。`.ts` を直接実行し、`bun:sqlite` にFTS5を同梱 — ビルドも `node_modules` も不要。`bun run typecheck` だけ一度 `bun install` が必要（開発用）。1.2未満では、Codexの圧縮rollout（`*.jsonl.zst`）を読むのに `PATH` 上の `zstd` が必要で、`llmwiki doctor` がどの方式かを表示します。 |
| **git** | ✔ 必須 | キャプチャは、ディレクトリがワークツリーかどうかをgitに尋ねます。setupは `PATH` の外（Homebrew・MacPorts・Nix・`~/.local/bin`）も探し、見つからなければ何も変える前に止まります。`llmwiki doctor` が `[deps]` にパスを表示します。 |
| **Codex · OpenCode CLI** | そのハーネスを使う場合のみ | `codex` / `opencode` が `PATH` にあること。Codexはさらに、lifecycle hookのサポートとstableの `hooks` 機能の有効化が必要です。setupはフック・スキル・サービスを変える前に確認します。 |
| **LLM CLI** | 任意・明示的に有効化 | キャプチャ・読み取り注入・`/wiki-*`・`ingest`（キャプチャのみ）はなくても動き、**既定では何も送りません**。`autoupdate`・`review` と `ingest` の統合段階は、シェルに `LLMWIKI_LLM_CMD` を設定したときだけサブプロセスを起動します（例: `export LLMWIKI_LLM_CMD='claude -p {prompt} --model {model} --tools= --permission-mode dontAsk --strict-mcp-config --safe-mode --no-session-persistence'`）。未設定なら、それらのパスは「unavailable」と報告してスキップします。 |
| **OS** | macOS / Linux / Windows | デーモンと無人更新: macOS = launchd、Linux = systemd（`--user`）、なければcron+nohup、Windows = ユーザーごとのスタートアップフォルダ。macOS・LinuxはCIで全テストを実行し、Windowsはプラットフォーム契約のジョブを実行して残りは手で確認しています。詳細: [`daemon/README.md`](../daemon/README.md) |

### ハーネス · OSノート

- **Claude Code** — `./setup.sh --harness claude`。キャプチャ・読み取り注入・`/wiki-*` コマンドが自動で配線されます。
- **Codex** — `./setup.sh --harness codex`
    - ユーザーCLIと5つの `$wiki-*` スキルを入れ、`$CODEX_HOME/hooks.json` に `SessionStart`/`UserPromptSubmit` フックをマージします。
    - 初回のみ: Codexを起動し、`/hooks` で正確なコマンドを確認します。新しいフックや変更されたフックは、信頼するまで実行されません。
    - キャプチャは `$CODEX_HOME/sessions/**/*.jsonl[.zst]` を監視します。
    - Codex Desktop独自のホーム（ランタイム・アカウント別）も収集します。同じrolloutが複数のホームにハードリンクされても、キューでは**1行**のままで、二重に記録されません。
    - スキルはCodex自身で動きます。無人の `autoupdate`/`review` は、`LLMWIKI_LLM_CMD` を設定したときだけ動きます。
- **OpenCode** — `./setup.sh --harness opencode`
    - グローバルな `/wiki-*` コマンド、cloneのパスを固定した読み取り注入プラグイン、ユーザーCLIを入れます。
    - キャプチャはOpenCodeのSQLiteセッションストアを読みます。`XDG_DATA_HOME`/`OPENCODE_DB` はデーモンの環境に保たれます。
- **Windows** — ネイティブとWSL2の両方に対応しています。
    - WSL2ではすべてそのまま動きます。Claude Code・Codexの公式推奨とも同じです。
    - Bunと `bun:sqlite` はネイティブで動きます（FTS5 trigramを含む）。パスの照合はバックスラッシュを正規化します。
    - ネイティブ: BunとGitを入れてから、Git Bashで `./setup.sh --harness claude`（または `all`）。フックスクリプトは、Windowsの `PATH` に `bash` がなくてもClaude Codeが直接実行します。
    - CodexとOpenCodeはシェルコマンドをPowerShellに渡し、`bash` はWindowsの `PATH` にありません。そのためWindowsでは、両ハーネスのフックとスキルが `bun <clone>/src/cli.ts` を直接呼びます — インタプリタも `PATH` の登録も不要です。
    - `~/.local/bin` の `llmwiki` ランチャーは `#!/bin/sh` スクリプトです。Git Bashからだけ使え（そのフォルダを `PATH` に自分で追加）、PowerShellや `cmd` からは使えません。ハーネスが入れるものはこのランチャーに依存しません。
    - キャプチャデーモンはユーザーごとの**スタートアップフォルダ**に登録され、ウィンドウなしで動きます。管理者権限は不要です（Task Schedulerのログオン項目なら権限が要る）。
    - ログオン時に起動し、クラッシュ時の自動再起動は**ありません**（Linuxの `cron @reboot` フォールバックと同じ）。`llmwiki doctor` は「ログオン時に起動」と「実行中」を別々に報告します。

## トラブルシューティング

doctorは2つあり、役割が違います。

- `llmwiki doctor` — インストールの点検: エンジンのファイル・デーモン・フック・入っているスキル・ユーザーCLI。`--fix` は配線を直します。
- `llmwiki wiki-doctor <repo>` — 一つのプロジェクトの `docs/wiki/` の点検。既定は読み取り専用: 構造・インデックスの鮮度・SQLiteの状態・lint・キャプチャの連続性・gapキュー・reviewの周期。`--fix` は安全な派生状態だけを作り直します。
- `/wiki-doctor`（Codex: `$wiki-doctor`） — 全体の修復。エンジンの修復の後、エージェントがlintとreviewの根拠を読んでページ内容を直します。出典を消したり、プロジェクトの方向性を作り出したりはしません。

エージェントのデータが想定の場所にないとき:

- 既定の場所が空なら、よくある別の場所も探します: WSLの `/mnt/c/Users/*` にマウントされたWindowsプロファイル、XDGの変種、`~/.opencode`、Codex Desktopのアカウント別ホーム。
- 候補ごとにスキーマで検証します。**自分のホーム内で**検証された候補が一つだけなら、尋ねずに接続します。
- ホームの外は自動では接続しません（マウントされたWindowsプロファイルは他人のものであることが多い）。代わりに正確な `llmwiki connect` コマンドを示します。
- 明示的に指定した `CODEX_HOME` はそれだけを使います。ただしCodex Desktop自身のホームは例外です（アプリが自分のターミナルにexportするため）。
- `llmwiki locate <harness>` は見つけたものを表示します。進められないときは、試したこと、妨げたもの、選択肢を表示します。
- `llmwiki connect <harness> <path>` は、検証を通ったパスだけを記録します。

その他のサイン:

- 締めくくりの抽出ヘッダーにある `# ⚠ route:` — セッションの編集が別の登録済みリポジトリに向かったことを示します。記録はそのwikiに送られます。
- シェルに `llmwiki` ランチャーのパスがなければ、setupが `PATH` のコマンドを一度表示します。

## 構成

```
setup.sh       ワンクリックのオンボーディング（パス非依存: doctor→デーモン→フック・コマンド→インデックス）
src/           TypeScriptエンジン（Bunランタイム、bun:sqlite内蔵 — node_modules・ビルドなし）
  cli.ts       CLIディスパッチャ — 40以上のサブコマンド: init·status·disable·index·search·lint·doctor·wiki-doctor·db-health·daemon-sync·wiki-clean·locate·connect·save-current·update-*·quiz-*·autoupdate·consolidate·review·gaps·overview·ingest·bench·…（全一覧: このファイル末尾の HANDLERS）
  engine/
    schema.sql   リポジトリごとのインデックススキーマ（documents·chunks·FTS5·references）
    db.ts        WikiIndex: インデックス作成（content_hash増分）·検索·グラフ·staleness
    chunker.ts   FTSチャンク分割（~512トークン）   refs.ts    引用·リンク → グラフのエッジ
    lint.ts      構造の点検（決定的）              review.ts  意味のlint（生成的·範囲限定·キャッシュ）
    gaps.ts      reviewのギャップ → 自動で閉じるキュー 0_review/gap-queue.md（LLMなし）
    quiz.ts      クイズのスケジューリング + 6_quiz/quiz-ledger.md（LLMなし。出題·採点は /wiki-quiz）
    overview.ts  overview入口の正規化（LLMなし·冪等）
    synthesis.ts 決定的なトピックビュー（タグクラスタ·統合ギャップ）— LLMなし·再生成可能
    extract.ts   transcriptの増分抽出（watermark）   update.ts  ログ層のオーケストレーション
    autoupdate.ts  無人の事実更新（write→二次確認→lintゲート）
    consolidate.ts ログ→トピックページ（5_topic）の統合（write→独立VERIFY→grounding→lint）
    source.ts    transcriptソースの抽象化（ハーネス非依存）
    sources/     claude.ts · codex.ts（.zst含む） · opencode.ts（SQLite→export） · plain.ts（任意ファイル）
    ingest.ts    デーモンなしでファイル1つを取り込み（`llmwiki ingest`）
    capture.ts   中央キャプチャキュー（source_kind）   doctor.ts   配線の点検
    config.ts    チーム規約 — llmwiki.config.toml + configs/*.toml のリゾルバ
    migrate.ts   wikiをconfigの構造へ移行（既定はdry-run·リンク書き換え·ずれ検出）
  daemon/
    watch.ts     キャプチャデーモン（すべてのソースを巡回）
    wire.ts      Claudeのフック·コマンド配線（~/.claude* + $CLAUDE_CONFIG_DIR）
    wire-codex.ts Codexフックのマージ + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCodeのグローバルプラグイン + /wiki-* + 共有CLI
    list-pending-repos.ts  キューからpendingのリポジトリだけを出力（スケジューラ用）
daemon/        install.sh（launchd/systemd/cronを自動判定） + autoupdate-*.sh（無人の事実パス）
hooks/         sessionstart-inject.sh（セッション開始） · userpromptsubmit-inject.sh（プロンプトごと） · pretooluse-inject.sh（編集時のルール）
adapters/      codex/（hooks.jsonテンプレート） · opencode/（1ファイルのプラグイン）
skill/         wiki-save · wiki-deep · wiki-doctor · wiki-ask · wiki-quiz（/コマンド）
examples/      sample-wiki/ — 完成したwikiの例。インデックス対象外。コピーしないこと — 実際のwikiは各プロジェクトの docs/wiki に生成される。examples/README.md 参照
tests/         bun:test スイート — `bun test`
package.json·tsconfig.json   Bunのメタデータ（typecheck用。ランタイムは .ts を直接実行）
```

## 回帰測定ツール（エンジン開発用）

日常のループでは使いません。

- **`llmwiki bench <repo>`** — 決定的な検索ベンチマーク（LLMなし、ミリ秒単位）。
    - ゴールデンクエリ: `<repo>/docs/wiki/.bench/golden.toml`（リポジトリごとに20以下、言語不問）。
    - search any-hit `r@k` とプロンプトごとのポインタ的中を採点。拒否クエリは、プロンプトごとのフックが黙れば正解。
    - seed固定のtune/sealed分割: `--tune-only` は反復用、`--sealed` は最終確認用（見るたびに価値が下がる）。
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — 固定コーパスでのA/B。
    - 同じtranscriptから、設定ごとに隔離した一時wikiを作ります。LLMを使うのはこのビルドだけです。
    - 判定の前に両方のレポートを検証します。形式が壊れているか互換性がなければ `keep`。
    - 順序付きのゲートで判定: まず回帰の阻止、次に keep / adopt / undecided。LLMなし。
    - プロンプトやモデルを変えたときだけ実行します。
- **`llmwiki bench-scale --repeats 2`** — 生成コーパスでの規模レポート。
    - 10/100/1000ページの段階を実行し、検索とコンテキストの正しさを確認します。
    - 時間とディスクの数値は観測値で、リリースの基準ではありません。
- **`llmwiki bench-capture --repeats 2 [--sessions 100,1000,10000]`** — 過去セッションでの規模レポート。
    - Claude・Codex・OpenCodeの探索と、上限付きのサンプル生成を比較します。
    - 軽量なフックの入口（セッション開始・空のプロンプト・登録確認）を測り、CLI全体の起動は別に報告します。
    - 件数は決定的で、時間は観測値です。

再現可能な全コマンドと、各結果が許す主張: [`reference/RELEASE_GATES.md`](../reference/RELEASE_GATES.md)。

## コントリビュート

- [CONTRIBUTING.md](../CONTRIBUTING.md) から始めます: クリーンなcloneでの作業の流れと点検。
- [ARCHITECTURE.md](../ARCHITECTURE.md) で、変更を担うモジュールと安全の境界を探します。
- 作業中は `bun run check:quick`、レビューの前は `bun run check`。

## 原則

- transcriptは原本で、変えません。ページはそれを引用するだけで、他のページから作り直しません。更新はwatermark以降だけを処理します。
- 事実はAIが書きます。判断（決定の理由・内容・代替案、方向性）は人のものです。AIの提案は、人が確認するまで `status: draft` のままです。
- gitのMarkdownが唯一の原本です。コミットは一人（リポジトリの所有者）の名義で行います。
- 作り込みすぎない。10万トークン未満なら、ベクトルDBやRAGなしで `index.md` のナビゲーションで十分です。
- 使うほどコンテキストが重くなってはいけません。注入の予算には上限があります。`/wiki-*` スキルは手順だけを常に読み込み（`/wiki-save` ≤ 15KB）、詳細は必要な段階で取り出します（`llmwiki conventions <repo> --section <name>`）。読み取りループはテキストを増やさず、利用記録で順序だけを変えます。

## ライセンス

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
