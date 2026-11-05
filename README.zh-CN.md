# Rigup

[English](README.md) · [文档](https://github.com/ansonli-dev/rigup/blob/main/docs/README.md) · [验证状态](docs/compatibility/status.md)

Rigup 根据仓库证据，为现有项目接入 coding agent 的研发流程、skills、MCP、hooks 和 CI 检查。安装前可以审阅变更，后续更新会比较已有用户修改。

## 安装

v0.1.0 开发预览版提供 macOS 和 Linux 的 ARM64、x64 便携包，内置 Node.js。可直接下载对应归档，也可安装到个人目录。[GitHub Releases](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) · [安装指南](docs/guides/releases.md)

```sh
curl -fL --proto '=https' -o rigup-install.sh https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/install.sh &&
  sh rigup-install.sh
export PATH="$HOME/.local/bin:$PATH"
```

## 开始使用

```sh
cd /path/to/project
rigup init
```

引导会补问缺少的选择。默认 agent 和研究后端都是 Codex。可以传 `--agents codex` 预选 agent，也可以为脚本提供完整参数。下例只预览本地默认配置，模型调用为零。

```sh
rigup init --agents codex --sdd none --tools none --dry-run --json
```

后续用 `rigup update --review` 审阅变更，用 `rigup doctor` 检查项目。结束受影响的 agent 会话后，从独立终端执行报告中的 apply 命令。详见[使用手册](docs/guides/usage.md)。

## 参与开发

在源码目录运行 `npm ci` 和 `npm run check`。[开发与测试](docs/guides/development.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [变更记录](CHANGELOG.md)

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
