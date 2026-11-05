# Rigup

[![CI](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml) · [npm](https://www.npmjs.com/package/@ansonli.dev/rigup) · [便携版下载](https://github.com/ansonli-dev/rigup/releases) · [English](README.md)

Rigup 为已有仓库配置编程 agent 的研发流程。它根据源码证据和你选择的接入项准备项目指引、skills 和配置，应用前可预览具体变更。

[Rigup 能做什么](#rigup-能做什么) · [快速开始](#快速开始) · [工作原理](#工作原理) · [接入范围](#接入范围) · [命令速查](#命令速查) · [文档](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md)

## Rigup 能做什么

- **项目指引。** 从源码、测试和已有约定提取适用范围明确的指引，并记录项目现有的构建和测试命令。
- **规格驱动研发流程。** `change-prepare` 接入所选流程的规划和审批，`change-deliver` 接入原生的实施和验证步骤。
- **工具和工程检查。** 按需配置 MCP、安装 skills，并让 Git hooks 或 GitLab CI 运行项目已有的检查。

以 Codex 搭配 OpenSpec 为例，应用后会生成这些流程文件或托管区块。

```text
AGENTS.md                               # 托管区块中的流程入口
.agents/skills/change-prepare/SKILL.md  # 准备变更并取得审批
.agents/skills/change-deliver/SKILL.md  # 实施并验证变更
.rigup/manifest.json                    # 文件归属和基线引用
```

## 快速开始

### 1. 安装

已有 Node.js 24 或更新版本时，可以通过 npm 安装。

```sh
npm install -g @ansonli.dev/rigup
rigup --version
```

macOS 和 Linux 也可以通过安装器下载内置 Node.js 的便携版。安装器会将 `rigup` 链接到 `~/.local/bin`。

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/ansonli-dev/rigup/main/install.sh | sh
```

宿主需要 Git 和 `ps`，Linux（含 WSL2）需要 glibc 2.35 或更新版本。[安装、升级与固定版本](docs/guides/releases.md)

### 2. 初始化项目

```sh
cd /path/to/project
rigup init
```

引导会补问缺少的设置，包括生成项目文档的语言。可以传 `--language zh-CN` 选简体中文，默认 `auto` 沿用项目指引的语言。语义研究默认使用本机已登录的 Codex。下例做非交互预览，模型调用为零。

```sh
rigup init --agents codex --sdd none --tools none --dry-run --json
```

### 3. 应用并重载

在审阅模式中，先检查预览并结束受影响的 agent 会话，再从独立终端执行报告里的 `nextCommand`。重开 agent 后，已接入原生研发流程的项目可以使用 `change-prepare` 和 `change-deliver`。用 `rigup doctor` 检查安装与重载状态。[应用与恢复](docs/guides/usage.md#应用与恢复)

## 项目开发规范

选用研发流程后，Rigup 引用已有指引，并从代码中识别尚未记录的惯例。证据充分时，`docs/rigup/development-rules.md` 会写明每条规则的适用范围、触发时机、操作、验证方式和源码依据。

两个流程 skill 将适用规则带入原生提案和任务执行，并指出已有的测试和 hook 定义，方便 agent 复用覆盖本次改动的检查。[研发流程与语言](docs/guides/usage.md#项目研发流程)

## 工作原理

```mermaid
flowchart TD
    accTitle: Rigup 初始化与更新
    accDescr: Rigup 根据仓库证据和接入选项准备预览。应用后保存基线，供下次更新比较。
    repo["仓库内容"] --> evidence["筛选证据"]
    choices["接入选项"] --> evidence
    evidence --> candidate["候选文件"]
    candidate --> preview["预览变更"]
    preview -->|应用| installed["项目文件和基线"]
    installed -.->|下次更新| preview
```

1. **筛选证据。** Rigup 按设置的范围扫描仓库，限制读取的文件数和字节数，并过滤敏感输入。语义生成的规划、内容和验收阶段各自选取所需片段。锁文件的摘要也纳入项目指纹，用于校验缓存结果。[研究后端与预算](docs/guides/usage.md#研究后端与预算)
2. **生成预览。** Rigup 将项目指引、固定模板和接入配置组装成候选文件。预览列出文件改动、冲突和待执行的操作，例如工具初始化。
3. **应用和更新。** 应用前重新核对预览，成功后记录托管文件、配置键和标记区块。更新时比较已保存的基线、当前文件和新候选。非重叠改动可以合并，冲突会保留本地内容并交由用户处理。中断后可根据保存的运行记录继续。[受保护的应用与恢复](docs/guides/usage.md#应用与恢复)

## 接入范围

- Agent 配置适配覆盖 Codex、Claude Code、OpenCode 和 Oh My Pi。[已验证场景](docs/compatibility/status.md)
- 选择 Superpowers、OpenSpec 或 Spec Kit 前，先准备对应的官方入口。[流程接入前置条件](docs/guides/usage.md#命令与引导)
- Rigup 在暂存区构建并验证 CodeGraph 索引，随后将索引移入项目。OpenWiki 通过 MCP 接通，由用户在独立会话生成 wiki。[工具设置](docs/guides/usage.md#openwiki-和-codegraph)

安装后的 MCP runner、hooks 和 CI 脚本使用运行环境 PATH 中的 Node.js。[平台与运行时要求](docs/guides/releases.md)

## 命令速查

```sh
rigup                    # 打开项目菜单
rigup init               # 初始化当前项目
rigup update --review    # 准备待审阅的更新
rigup update --configure # 重新打开设置引导
rigup doctor             # 检查项目状态
rigup --help             # 查看可用选项
```

`init`、`update` 和 `doctor` 是子命令。命令后可给项目路径，省略时使用当前目录。用 `--review`、`--json` 等选项选择执行方式或输出格式。

## 参与开发

在源码目录运行 `npm ci` 和 `npm run check`。[开发与测试](docs/guides/development.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [变更记录](CHANGELOG.md)

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
