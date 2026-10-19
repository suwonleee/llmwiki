<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.png">
    <img src="../assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki

코딩 에이전트가 관리하는 프로젝트 위키. 내가 내린 결정은 퀴즈로 기억합니다.

[English](../README.md) · **한국어** · [日本語](README.ja.md) · [中文](README.zh.md)

llmwiki는 코딩 세션을 `docs/wiki/`에 기록합니다. Claude Code·Codex·OpenCode가 같은 위키를 공유하고, 다음 세션에서 관련 내용을 읽으며, 지난 결정에 대해 퀴즈를 냅니다.

- **작업 기록:** `/wiki-save`로 결정·인사이트·프로젝트 맥락을 저장합니다.
- **다음 작업에 반영:** 세션 시작 시 현재 상태, 질문마다 관련 발췌를 전달합니다. Claude Code에서는 파일 편집 직전에 해당 규칙도 전달합니다.
- **직접 소유:** git의 Markdown 파일이며 Open Knowledge Format(OKF v0.2)을 적용했습니다.
- **프로젝트별 선택:** `llmwiki init` 전에는 동작하지 않습니다. 저장과 검색은 로컬 Bun·SQLite로 실행합니다.

## 빠른 시작

Git, [Bun](https://bun.sh) **1.2.21 이상**, 코딩 에이전트 하나가 필요합니다. 빌드나 런타임 의존성 설치는 없습니다.

### 1. 설치

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

이 폴더에서 `claude`, `codex`, `opencode` 중 하나를 실행하고 아래 문장을 붙여 넣으세요.

```text
Read setup_text.md and install llmwiki for this machine and the coding agent I am currently using. Follow the file exactly, run the health checks, and tell me about any manual step that remains.
```

같은 버전을 재현하려면 설치 전에 [Releases](https://github.com/suwonleee/llmwiki/releases)에서 태그를 선택하세요.

### 2. 프로젝트에서 켜기

설치 검사가 끝나면 같은 세션에서 에이전트에게 프로젝트 초기화를 요청하거나 직접 실행하세요.

```bash
llmwiki init /absolute/path/to/my-project
```

**OpenCode:** 설치 후 한 번 재시작하세요. **Codex:** 설치 안내에 따라 `/hooks`에서 훅을 확인하고 신뢰하세요. 네이티브 Windows의 PowerShell에서는 `bun <clone>/src/cli.ts init <repo>`를 사용합니다.

### 3. 사용하기

프로젝트 폴더에서 평소처럼 작업하세요. 보관할 세션은 에이전트가 원본 대화를 정리하기 전에 저장하세요.

| 언제 | Claude Code / OpenCode | Codex |
|---|---|---|
| 의미 있는 세션의 끝 | `/wiki-save` | `$wiki-save` |
| 가끔 (백로그·깊은 정리) | `/wiki-deep` | `$wiki-deep` |
| 위키에 질문 | `/wiki-ask` | `$wiki-ask` |
| 위키가 이상해 보일 때 | `/wiki-doctor` | `$wiki-doctor` |
| 퀴즈 풀기 | `/wiki-quiz` | `$wiki-quiz` |

```bash
llmwiki status /absolute/path/to/my-project
llmwiki --help
llmwiki --version
```

`llmwiki <command> --help`

질문마다 위키 발췌와 관련 커밋 메시지를 전달하고, 확인한 기록에서 특정 이름을 찾지 못했으면 이를 알립니다. `LLMWIKI_TURN_COMMITS=off` 또는 `LLMWIKI_TURN_ABSENT=off`로 각 채널을 끌 수 있습니다. 위키 파싱 결과는 비공개 임시 캐시를 사용합니다(`LLMWIKI_PAGE_CACHE=off`로 해제).

`/wiki-save`는 이번 세션의 결정·교훈과 인계 상태를 저장합니다. 주제 통합·overview·의미 리뷰는 `/wiki-deep`에서 처리합니다. 결정 신호가 있는 8턴 이상 세션에는 모델용 저장 힌트를 한 번 전달할 수 있습니다(`LLMWIKI_SAVE_NUDGE=off`로 해제). 저장은 사용자 선택이며 저장하지 않은 세션은 만료돼도 보관하지 않습니다. 명령 실행 때 선택적으로 남기는 페이지 버전별 피드백을 다음 순위에 반영하고, 판단 불가는 중립으로 처리하며 틀린 주장은 별도 재확인합니다. 리뷰 provider가 없으면 현재 세션이 `review-input`을 검토하고 `review-import`로 제출할 수 있습니다.

## 위키 형식: OKF v0.2

v0.14.0부터 새 위키에 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)를 적용했습니다. 타입이 있는 YAML 메타데이터, 출처, 상대 Markdown 링크, 폴더별 인덱스와 날짜별 로그를 갖춰 llmwiki 밖에서도 읽을 수 있습니다. 기존 위키는 사용자가 선택할 때만 변환합니다.

```bash
llmwiki okf /path/to/project            # 변경 미리보기
llmwiki okf /path/to/project --commit   # 검토 후 적용
llmwiki okf --bundle /path/to/project/docs/wiki  # 번들 형식 검사
```

## 업데이트·제거

업데이트는 수동입니다. 코드를 받은 뒤 setup을 다시 실행해야 데몬과 설치된 OpenCode 플러그인도 갱신됩니다. OpenCode는 이후 재시작하세요.

```bash
cd ~/llmwiki
git pull && ./setup.sh
```

```bash
./setup.sh --uninstall
```

clone을 옮기거나 지우기 전에 제거하세요. 프로젝트의 위키 파일은 남습니다. 로컬 실행 데이터까지 지우려면 `--purge-data`를 추가합니다.

## 더 알아보기

- [사용 가이드](GUIDE.ko.md) — 플러그인·수동 설치, 설정, 팀 사용, 문제 해결, 측정 결과.
- [설치 상세](../reference/INSTALLATION_FLOW.md) · [setup_text.md](../setup_text.md)
- [기여 안내](../CONTRIBUTING.md) · [Architecture](../ARCHITECTURE.md) · [Support](../SUPPORT.md)
- [개인정보](../PRIVACY.md) · [라이선스: Apache-2.0](../LICENSE)

엔진의 저장·검색은 로컬에서 실행합니다. 코딩 에이전트는 자체 제공자 설정을 따릅니다. 엔진이 별도로 실행하는 생성 작업은 `LLMWIKI_LLM_CMD`를 설정해야 켜집니다.

소규모 통제 실험과 개발자 한 명의 실사용 측정은 한계와 함께 가이드에 정리했습니다. 일반적인 정확도를 보장하는 수치는 아닙니다.
