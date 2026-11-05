# Rigup

[![CI](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml) · [v0.1.0 开发预览版](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) · [English](README.md)

Rigup 为已有仓库接入 coding agent 的研发流程。它根据源码证据准备项目指引，接入选定的工具，并在应用前提供具体变更供审阅。

[快速开始](#快速开始) · [接入范围](#接入范围) · [命令速查](#命令速查) · [文档](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md)

## 快速开始

### 1. 安装

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/ansonli-dev/rigup/main/install.sh | sh
```

安装器会选择 macOS 或 Linux 的 ARM64、x64 归档，校验后把命令链接到 `~/.local/bin`。便携包内置 Node.js。如果找不到 `rigup`，执行 `export PATH="$HOME/.local/bin:$PATH"`。宿主需要 Git 和 `ps`，Linux（含 WSL2）需要 glibc 2.35 或更高版本。[手动下载与平台说明](docs/guides/releases.md)

已有 Node.js 24 和 npm 时，可以按包名全局安装。

```sh
npm install -g rigup
```

### 2. 初始化项目

```sh
cd /path/to/project
rigup init
```

引导会补问缺少的 agent、研发流程和工具。语义研究默认使用本机已登录的 Codex。可以传 `--agents codex` 预选 agent。下例用本地默认配置做非交互预览，模型调用为零。

```sh
rigup init --agents codex --sdd none --tools none --dry-run --json
```

### 3. 应用并重载

在审阅模式中，先检查预览并结束受影响的 agent 会话，再从独立终端执行报告里的 `nextCommand`。重开 agent 后，已接入原生研发流程的项目可以使用 `change-prepare` 和 `change-deliver`。用 `rigup doctor` 检查安装与重载状态。[应用与恢复](docs/guides/usage.md#应用与恢复)

## 接入范围

- 配置适配覆盖 Codex、Claude Code、OpenCode 和 Oh My Pi。选择 Superpowers、OpenSpec 或 Spec Kit 前，先准备官方入口。Rigup 绑定对应原生步骤和审批门禁。[已验证场景](docs/compatibility/status.md)
- 可选工具包括 CodeGraph 和 OpenWiki。CodeGraph 在暂存区建索引并校验。OpenWiki 安装后接通 MCP，由用户另开任务生成 wiki。[工具设置](docs/guides/usage.md#openwiki-和-codegraph)
- Skills、MCP runner、hooks 和 CI 检查按选择安装。基于 Node 的资产使用 agent 或 CI 环境的 PATH。更新时会比较上次安装基线、本地修改和新候选。[配置与更新](docs/guides/usage.md)

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
