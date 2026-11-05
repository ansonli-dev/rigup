# Rigup

[English](README.md) · [文档](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md) · [验证状态](docs/compatibility/status.md)

Rigup 根据项目已有证据，为 coding agent 接入研发流程、skills、MCP 和工程检查。它先研究、生成候选和预览，再通过受保护的更新安装；已有用户修改会参与三方比较。安装后的 skills、MCP runner、hooks 和 CI 脚本可独立运行。

**当前为 0.1.0 开发预览版。** 默认使用本机已登录的 Codex。四种宿主及三种 SDD 有配置适配，真实兼容性按场景验证，详见[当前验证状态](docs/compatibility/status.md)。

## 安装

在 [GitHub Releases](https://github.com/ansonli-dev/rigup/releases) 下载 macOS 或 Linux 的 ARM64、x64 便携包。包内含 `rigup` 可执行命令和 Node 运行时，无需克隆或编译项目。也可以用安装脚本装到个人目录。

```sh
curl -fL --proto '=https' -o rigup-install.sh https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/install.sh
sh rigup-install.sh
export PATH="$HOME/.local/bin:$PATH"
rigup --version
```

CLI 需要 Git 和 `ps` 等常见 POSIX 工具，Linux 需要 glibc 2.35 或以上版本。语义研究仍需配置后端。手动下载、校验、WSL2 和源码安装见[安装指南](docs/guides/releases.md)。

## 开始使用

在项目根目录的交互终端运行。

```sh
cd /path/to/project
rigup init
```

引导会补问未提供的 agents、SDD、可选工具和研究后端，再选择连续执行、审阅或只预览。默认建议使用 Codex，也能在引导中选择其他宿主。直接运行 `rigup` 会打开项目菜单。

参数可以全不填、只填一部分，或在脚本中完整指定：

```sh
rigup init --agents codex
rigup init --agents codex --sdd openspec --dry-run --json
rigup init /path/to/another-project --agents codex --sdd openspec --review --json
```

省略路径就使用当前目录。引导保留已给出的选择，按 `b` 可返回修改；`--json` 和非交互运行不读取键盘，需要通过参数或配置提供必要选择。所选 SDD 的官方入口仍须准备好，缺失时会给出具体待办。`--dry-run` 保存私有候选和预览，不安装到项目。

检查实际预览，结束会加载待改资产的 agent 会话，再从独立终端执行输出的 `nextCommand`。日常命令也默认作用于当前项目：

```sh
rigup update
rigup update --configure
rigup doctor
```

只安装工具时，不需要 SDD 或模型调用：

```sh
rigup init --agents codex --sdd none --tools openwiki,codegraph --review --json
```

OpenWiki 只安装软件、登记 MCP 并给出独立初始化指引；长时间的 wiki 生成由用户另开任务执行。CodeGraph 的初始化使用隔离暂存、完整性检查和恢复流程。

## 文档与贡献

- [使用手册](docs/guides/usage.md)：配置、预算、后端、更新保护、工具与退出码。
- [开发与测试](docs/guides/development.md)：可重复的本地检查与真实集成测试入口。
- [外部验证交接清单](docs/guides/external-validation-handoff.md)：换机跑 Claude、Windows 原生与 WSL2 的准备、命令、验收和恢复。
- [验证状态与外部条件](docs/compatibility/status.md)：已测范围和继续验证所需条件。
- [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[变更记录](CHANGELOG.md)。

```sh
npm run check
```

上述检查包含本地测试、类型检查、构建、文档链接和隔离打包安装；不会发起付费模型请求。具体的 opt-in 测试见开发指南。

Rigup 使用 [MIT License](LICENSE)。第三方集成保留各自的[许可证与声明](THIRD_PARTY_NOTICES.md)。
