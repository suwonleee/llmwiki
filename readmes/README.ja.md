<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki

コーディングエージェントが管理するプロジェクトwiki。自分の決定はクイズで覚えておけます。

[English](../README.md) · [한국어](README.ko.md) · **日本語** · [中文](README.zh.md)

llmwikiはコーディングセッションを `docs/wiki/` に記録します。Claude Code・Codex・OpenCodeが同じwikiを共有し、次のセッションで関連する内容を読み、過去の決定をクイズで問い直します。

- **作業を記録:** `/wiki-save` で決定・知見・プロジェクトの状況を保存。
- **次の作業に反映:** 開始時の状況とプロンプトごとの抜粋。Claude Codeでは編集直前にファイルのルールも提示。
- **ファイルを所有:** gitのMarkdownで、Open Knowledge Format（OKF v0.2）を採用。
- **プロジェクトごとに選択:** `llmwiki init` まで無効。保存と検索はローカルのBun・SQLiteで実行。

## クイックスタート

Git、[Bun](https://bun.sh) **1.2.21以上**、コーディングエージェント一つが必要です。ビルドや実行時依存関係のインストールは不要です。

### 1. インストール

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

このフォルダで `claude`、`codex`、`opencode` のいずれかを起動し、次を貼り付けます。

```text
Read setup_text.md and install llmwiki for this machine and the coding agent I am currently using. Follow the file exactly, run the health checks, and tell me about any manual step that remains.
```

再現可能なインストールには、セットアップ前に [Releases](https://github.com/suwonleee/llmwiki/releases) のタグを選びます。

### 2. プロジェクトで有効にする

セットアップの検査が成功したら、同じセッションでプロジェクトの初期化を依頼するか、直接実行します。

```bash
llmwiki init /absolute/path/to/my-project
```

**OpenCode:** セットアップ後に一度再起動してください。**Codex:** 案内に従い `/hooks` でフックを確認・信頼してください。ネイティブWindowsのPowerShellでは `bun <clone>/src/cli.ts init <repo>` を使います。

### 3. 使う

プロジェクトのディレクトリで作業します。残したいセッションは、エージェントが元の会話を削除する前に保存してください。

| いつ | Claude Code / OpenCode | Codex |
|---|---|---|
| 意味のあるセッションの最後 | `/wiki-save` | `$wiki-save` |
| ときどき（バックログ・深い整理） | `/wiki-deep` | `$wiki-deep` |
| wikiに質問する | `/wiki-ask` | `$wiki-ask` |
| wikiがおかしいとき | `/wiki-doctor` | `$wiki-doctor` |
| クイズに答える | `/wiki-quiz` | `$wiki-quiz` |

```bash
llmwiki status /absolute/path/to/my-project
llmwiki --help
llmwiki --version
```

`llmwiki <command> --help`

## wikiの形式: OKF v0.2

v0.14.0から新しいwikiに [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) を採用しました。型付きYAMLメタデータ、出典、相対Markdownリンク、フォルダ索引、日付別ログにより、llmwikiの外でも読めます。既存wikiは利用者が選んだときだけ変換します。

```bash
llmwiki okf /path/to/project            # 変更を確認
llmwiki okf /path/to/project --commit   # 確認後に適用
llmwiki okf --bundle /path/to/project/docs/wiki  # バンドルを検証
```

## 更新・アンインストール

更新は手動です。pull後にsetupを再実行して、デーモンとインストール済みOpenCodeプラグインを更新してください。その後OpenCodeを再起動します。

```bash
cd ~/llmwiki
git pull && ./setup.sh
```

```bash
./setup.sh --uninstall
```

cloneを移動・削除する前にアンインストールしてください。プロジェクトのwikiは残ります。ローカルの実行状態も削除する場合だけ `--purge-data` を追加します。

## ドキュメント

- [ユーザーガイド](GUIDE.ja.md) — プラグイン・手動インストール、設定、チーム利用、トラブル対応、測定結果.
- [インストール詳細](../reference/INSTALLATION_FLOW.md) · [setup_text.md](../setup_text.md)
- [貢献](../CONTRIBUTING.md) · [Architecture](../ARCHITECTURE.md) · [Support](../SUPPORT.md)
- [プライバシー](../PRIVACY.md) · [ライセンス: Apache-2.0](../LICENSE)

エンジンの保存・検索はローカルで実行します。コーディングエージェントは自身のプロバイダー設定に従います。エンジンが別途起動する生成処理は `LLMWIKI_LLM_CMD` を設定した場合だけ有効です。

小規模な比較実験と開発者一人の実測値は、制約とともにガイドに記載しています。一般的な精度の保証ではありません。
