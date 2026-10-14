<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki

由编码智能体维护的项目 wiki，用测验帮你记住自己做过的决定。

[English](../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文**

llmwiki 将编码会话记录到 `docs/wiki/`。Claude Code、Codex 和 OpenCode 可以共享同一个 wiki，在后续会话中读取相关内容，并就过去的决定向你提问。

- **记录工作:** 用 `/wiki-save` 保存决定、经验和项目背景。
- **用于下次工作:** 会话开始时提供当前状态，每次提问时提供相关摘录。Claude Code 还会在编辑前提示文件适用的规则。
- **拥有文件:** git 中的 Markdown，采用 Open Knowledge Format（OKF v0.2）。
- **按项目启用:** 运行 `llmwiki init` 前不会生效。存储与搜索由本地 Bun、SQLite 完成。

## 快速开始

需要 Git、[Bun](https://bun.sh) **1.2.21 或更新版本**，以及一个编码智能体。无需构建或安装运行时依赖。

### 1. 安装

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

在此目录启动 `claude`、`codex` 或 `opencode`，粘贴以下内容：

```text
Read setup_text.md and install llmwiki for this machine and the coding agent I am currently using. Follow the file exactly, run the health checks, and tell me about any manual step that remains.
```

如需可复现的安装，请在 setup 前从 [Releases](https://github.com/suwonleee/llmwiki/releases) 选择标签。

### 2. 为项目启用

安装检查通过后，在同一会话中让智能体初始化项目，或直接运行：

```bash
llmwiki init /absolute/path/to/my-project
```

**OpenCode:** 安装后重启一次。**Codex:** 按安装提示在 `/hooks` 中检查并信任钩子。原生 Windows 的 PowerShell 中使用 `bun <clone>/src/cli.ts init <repo>`。

### 3. 使用

在项目目录中正常工作。需要保留的会话应在智能体清理原始对话前保存。

| 何时 | Claude Code / OpenCode | Codex |
|---|---|---|
| 一次有意义的会话结束时 | `/wiki-save` | `$wiki-save` |
| 不定期（积压、深度整理） | `/wiki-deep` | `$wiki-deep` |
| 向 wiki 提问 | `/wiki-ask` | `$wiki-ask` |
| wiki 看起来有问题 | `/wiki-doctor` | `$wiki-doctor` |
| 做测验 | `/wiki-quiz` | `$wiki-quiz` |

```bash
llmwiki status /absolute/path/to/my-project
llmwiki --help
llmwiki --version
```

`llmwiki <command> --help`

## wiki 格式：OKF v0.2

从 v0.14.0 起，新 wiki 采用 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)：带类型的 YAML 元数据、来源、相对 Markdown 链接、目录索引和日期日志，可在 llmwiki 之外阅读。现有 wiki 仅在你选择时转换。

```bash
llmwiki okf /path/to/project            # 预览变更
llmwiki okf /path/to/project --commit   # 检查后应用
llmwiki okf --bundle /path/to/project/docs/wiki  # 检查格式
```

## 更新与卸载

更新是手动的。pull 后再次运行 setup，以更新守护进程和已安装的 OpenCode 插件。之后重启 OpenCode。

```bash
cd ~/llmwiki
git pull && ./setup.sh
```

```bash
./setup.sh --uninstall
```

移动或删除 clone 前先卸载。项目中的 wiki 文件会保留；只有需要删除本地运行状态时才添加 `--purge-data`。

## 文档

- [使用指南](GUIDE.zh.md) — 插件与手动安装、配置、团队使用、故障排查和测量结果.
- [安装详情](../reference/INSTALLATION_FLOW.md) · [setup_text.md](../setup_text.md)
- [贡献指南](../CONTRIBUTING.md) · [Architecture](../ARCHITECTURE.md) · [Support](../SUPPORT.md)
- [隐私](../PRIVACY.md) · [许可证: Apache-2.0](../LICENSE)

引擎在本地存储和搜索。编码智能体遵循其自身的提供商设置。引擎额外启动的生成任务仅在设置 `LLMWIKI_LLM_CMD` 后启用。

小规模对照实验和一位开发者的使用数据均在指南中注明局限，不能视为普遍的准确率保证。
