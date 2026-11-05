# Rigup 使用手册

安装后，在目标项目根目录执行 `rigup init`。也可以直接运行 `rigup` 打开项目菜单。[安装指南](releases.md)

## 命令与引导

```sh
rigup init
rigup init --agents codex
rigup init --agents codex --sdd openspec --language zh-CN
rigup init /path/to/project --agents codex --sdd none --tools none --dry-run --json
rigup update --configure
rigup doctor
```

省略路径时使用当前目录。交互终端保留已给的选项并补问缺少的设置，按 `b` 返回。`update --configure` 重新打开设置引导。`--json` 使用非交互模式，stdout 输出一个最终 JSON 对象，进度走 stderr。

`--dry-run` 保存私有候选和预览。`--review` 提供待应用的预览与 `nextCommand`。配置完整时，非交互 `init` 和 `update` 按项目设置选择执行方式。选用 Superpowers、OpenSpec 或 Spec Kit 前，按对应框架准备官方入口。入口或依赖缺失会报告待办。[验证范围](../compatibility/status.md) · [上游版本与入口](../compatibility/upstream-lock.json)

## 项目配置

项目设置保存在 `.rigup/config.yaml`。优先级从高到低为 CLI 参数、项目设置、显式选择的 profile 和默认值。用 `--profile` 或 `profile` 指定 profile 文件，相对路径从目标项目根目录解析。`--configure` 的设置随预览一起审阅并应用。

```yaml
agents: [codex]
backend: codex
sdd: openspec
documentLanguage: zh-CN
executionPolicy:
  mode: review
researchBudget:
  maxCalls: 60
  maxTokens: 100000
mcp:
  - id: customer-knowledge
    agents: [codex]
    command:
      executable: node
      args: [tools/knowledge-server.mjs, --token, '${DOCS_TOKEN}']
      cwd: .
      envRefs: [DOCS_TOKEN]
```

- 用 `scope` 限定项目内相对路径，用 `readBudget.maxFiles` 和 `readBudget.maxBytes` 限制读取。`researchBudget` 约束本轮各阶段的累计用量。
- MCP 的 `envRefs` 由 runner 启动时解析。配置里保存变量名，凭据由宿主环境提供。安装后重载 agent，再检查实际连接。
- `customSkills` 接受本地 `source` 目录，可用 `position` 绑定 `prepare`、`deliver` 或 `release`。`templates` 通过 `source`、`target` 和 `values` 为允许的文档或 skill 资源做标量替换。`change-release` 需要真实的客户部署适配器。

## 项目研发流程

- `--language` 和 `documentLanguage` 接受 `auto` 或语言标签，例如 `zh-CN`、`en`、`ja`。默认 `auto` 参照适用的项目指引。此设置用于新生成的项目规范和语义文档。已有文档保留原文，原生流程入口保留其名称和模板。
- 证据支持的开发规范写入 `docs/rigup/development-rules.md`，也可通过 `projectConventions.documentRoutes.context` 指定目录。原有指引以带行号的链接引用。代码惯例按已验证的模块限定范围。
- 使用 `change-prepare` 将需求、适用规则和检查写入所选 SDD 的提案与任务。审批后使用 `change-deliver` 实现并验证。两者共享项目指引，按变更范围复用已有的测试、CI 和 hooks。

## 研究后端与预算

- `codex` 使用本机已登录的 Codex CLI。研究在隔离工作目录运行，输入来自过滤后的证据。Plan、content 和 acceptance 按当前任务选取正文，锁文件只参与指纹校验。源码、配置或锁文件变化会使相关结果失效。
- `native` 通过 Anthropic API 研究。用 `--model` 或 `model.model` 选择模型，默认密钥变量为 `ANTHROPIC_API_KEY`，可用 `model.apiKeyEnv` 指定。`--model` 和 `--api-key-env` 会选择 native，与 `--backend codex` 互斥。Claude Code 登录与此 API 认证分开。
- `host` 导出私有研究请求。读取报告的 `requestPath` 和该轮输出要求，将实际结果包入 `requestId`、`requestDigest`、`model`、`data` 后保存到指定响应路径，再执行 `nextCommand`。续跑会验证证据、输入指纹和当前设置。`--request` 的目标须在私有 host 缓存内，且与 `--response` 互斥。

```sh
rigup init --agents codex --sdd openspec --backend host --review --json
```

Codex 在请求前登记尝试，在响应后按实际用量核验预算，单次调用可能先超额再被拒绝。Native 将 token 预检和模型请求都计入请求数。Host 的实际用量由执行方另行对账。复用已验证结果可以节省调用，未知消费须先对账再重试。

## 应用与恢复

```sh
rigup update --review --json
rigup update --apply PREVIEW_ID --sessions-ended --json
rigup update --resume --review --json
```

以实际报告中的命令和预览 ID 为准。审阅写入和检查选择，结束会加载待改配置的 agent 会话，再从独立终端 apply。应用后重载宿主。

Rigup 比较上次生成的基线、本地文件和新候选。非重叠改动可合并，冲突保留本地内容，等待用户处理后重新预览。混合配置按拥有的键、表或标记块更新，完整文件也核对权限位。需要显式退役时使用 `--retire logicalId,...`。

中断后保留项目 `.rigup/` 和私有状态 `~/.local/state/rigup/`。普通候选与请求位于 `~/.cache/rigup/`。先核实 controller 和原生写入进程已退出，再在原项目路径用原配置执行 `--resume`。续跑可从持久记录恢复已批准的预览。输入或权限前置变化时先对账，再生成新预览。对未确认的副作用保留记录，等待身份和结果核实。

Git 项目应用集成后，`.rigup/.gitignore` 会排除本机安装回执、基线、软件和原生工具状态。项目配置和共享检查脚本仍可跟踪。

升级前，先用原版本续跑或对账未完成的语义研究。准备新预览时，会使用新版本的证据格式和独立的预算记录。

## OpenWiki 和 CodeGraph

只接入工具时可以跳过 SDD 和模型研究。

```sh
rigup init --agents codex --sdd none --tools openwiki,codegraph --review --json
```

- CodeGraph 在隔离暂存区建索引，核验后提升到项目。软件与初始化分别留回执，已有用户状态需要对账。
- OpenWiki 安装软件、登记 MCP 并提供交接。重载宿主后，在独立会话用 `openwiki_begin` 的 `mode=init` 开始规划和逐页生成。已有运行按 OpenWiki 的进度恢复，完整 wiki 生成单独计时和计费。

## 工程检查和退出码

`quality` 选择项目已有的检查。Git hooks 从 index 或实际推送的提交范围构建隔离快照，所选命令须能在快照内运行。

```yaml
quality:
  preCommit: [lint]
  prePush: [test]
  gitlab:
    checks: [test]
    reportPaths: [reports/junit.xml]
```

GitLab 使用拥有的 include 块。OpenWiki CI 需要固定版工具、既有初始化、显式 source 范围和模型配置。

`rigup doctor` 默认只读。明确选择已有命令才会执行，例如 `rigup doctor --run-checks environment,test --json`。报告分开记录配置、安装、初始化和宿主重载。

退出码 `0` 表示当前阶段完成，`1` 为失败或冲突，`2` 为参数问题，`3` 为待办或交接，`130` 为取消。结合 `phase`、`installStatus`、`pending`、`conflicts` 和 `nextCommand` 判断下一步。
