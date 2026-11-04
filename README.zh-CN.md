# Rigup

[English](README.md) · [文档](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md) · [验证状态](docs/compatibility/status.md)

Rigup 根据项目已有证据，为 coding agent 接入研发流程、skills、MCP 和工程检查。它先研究、生成候选和预览，再通过受保护的更新安装；已有用户修改会参与三方比较。安装后的 skills、MCP runner、hooks 和 CI 脚本可独立运行。

**当前为 0.1.0 开发预览版，通过源码安装。** 默认使用本机已登录的 Codex。四种宿主及三种 SDD 有配置适配，但真实兼容性按场景验证，详见[当前验证状态](docs/compatibility/status.md)。

## 安装

需要 Node.js 24+、npm、Git、POSIX shell 和 `ps`（最小 Linux 镜像安装 `procps`）。语义研究还需要可用的 Codex CLI 登录。不要在 npm registry 中安装同名包来替代本仓库。

```sh
git clone https://github.com/ansonli-dev/rigup.git
cd rigup
npm ci
npm run build
node dist/cli.js --help
```

使用绝对路径运行 `node /path/to/rigup/dist/cli.js`，或在构建后通过 `npm link` 注册 `rigup` 命令。

## 开始使用

先在目标项目准备所选 SDD 的官方入口，再预览安装。`--dry-run` 保存私有候选和预览，不安装到项目。

```sh
node dist/cli.js init /path/to/project --agents codex --sdd openspec --dry-run --json
node dist/cli.js init /path/to/project --agents codex --sdd openspec --review --json
```

检查实际预览，结束会加载待改资产的 agent 会话，再在独立终端执行输出中的 `nextCommand`。后续使用 `update` 更新，使用 `doctor` 只读检查：

```sh
node dist/cli.js update /path/to/project --json
node dist/cli.js doctor /path/to/project --json
```

只安装工具时，不需要 SDD 或模型调用：

```sh
node dist/cli.js init /path/to/project --agents codex --sdd none --tools openwiki,codegraph --review --json
```

OpenWiki 只安装软件、登记 MCP 并给出独立初始化指引；长时间的 wiki 生成由用户另开任务执行。CodeGraph 的初始化使用隔离暂存、完整性检查和恢复流程。

## 文档与贡献

- [使用手册](docs/guides/usage.md)：配置、预算、后端、更新保护、工具与退出码。
- [开发与测试](docs/guides/development.md)：可重复的本地检查与真实集成测试入口。
- [验证状态与外部条件](docs/compatibility/status.md)：已测范围和继续验证所需条件。
- [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[变更记录](CHANGELOG.md)。

```sh
npm run check
```

上述检查包含本地测试、类型检查、构建、文档链接和隔离打包安装；不会发起付费模型请求。具体的 opt-in 测试见开发指南。

Rigup 使用 [MIT License](LICENSE)。第三方集成保留各自的[许可证与声明](THIRD_PARTY_NOTICES.md)。
