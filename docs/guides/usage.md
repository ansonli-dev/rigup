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

`--dry-run` 保存私有候选和预览。选中研发流程时，生成完整规则的 dry-run 仍会请求模型。`--review` 提供待应用的预览与 `nextCommand`。配置完整时，非交互 `init` 和 `update` 按项目设置选择执行方式。Superpowers 和 Spec Kit 使用项目已有的官方入口。[验证范围](../compatibility/status.md) · [上游版本与入口](../compatibility/upstream-lock.json)

首次选择 OpenSpec 后，Rigup 检查 PATH 中的 CLI、项目的 OpenSpec 根和所选宿主的工作流入口。缺失时可确认自动补齐。Rigup 用 npm 安装锁定版本的 CLI，在临时目录生成原生文件并补入项目的空缺。已有项目配置和技能保留原样。自动安装使用用户终端里的 Node.js 22.12 或更新版本、npm 和 PATH 上可写的用户安装位置。便携版也按这个环境检查。

在显式审阅或非交互设置中，缺少先决条件时可执行报告的 `nextCommand`。其中 `--prepare-openspec` 单独补齐原生依赖，使用同一套保护步骤保留已有项目文件。交互中选择手动准备后，可用报告里的续跑命令，也可回到项目执行 `rigup init` 继续已选择的宿主和 OpenSpec。

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
  maxTokens: 1200000
mcp:
  - id: customer-knowledge
    agents: [codex]
    command:
      executable: node
      args: [tools/knowledge-server.mjs]
      cwd: .
      envRefs: [DOCS_TOKEN]
```

- 用 `scope` 限定项目内相对路径，用 `readBudget.maxFiles` 和 `readBudget.maxBytes` 限制读取。`researchBudget` 约束本轮各阶段的累计用量。
- MCP 使用宿主原生的工作目录与环境变量配置。配置保存变量名，凭据由宿主环境提供。遇到宿主无法表达的参数展开或工作目录，选择项目已有的启动命令。安装后重载 agent，再检查实际连接。
- `customSkills` 接受本地 `source` 目录，可用 `position` 绑定 `prepare`、`deliver` 或 `release`。`templates` 通过 `source`、`target` 和 `values` 为允许的文档或 skill 资源做标量替换。`change-release` 需要真实的客户部署适配器。

## 先安装工作流，再生成规则

首次交互选择研发流程时，按 Enter 默认先安装工作流、稍后生成规则。也可以选择同时准备两部分。OpenSpec 的基础预览可在独立终端当场确认应用。需要结束宿主会话时，按报告里的命令交接。基础安装完成即可打开 agent 发起提案，生成额外的项目规则是后续选项。

```sh
rigup init --defer-research --review
rigup update --apply PREVIEW_ID --sessions-ended
rigup update --review
rigup update --apply RULES_PREVIEW_ID --sessions-ended
```

第一阶段无需模型请求，技能在重载后可配合项目原有指引使用。第二阶段按已保存的选择生成并独立验收规则，应用后重载宿主。中断时使用原设置执行 `rigup update --review --resume`。现有完整设置入口仍可一次准备两部分。

## 项目研发流程

- `--language` 和 `documentLanguage` 接受 `auto` 或语言标签，例如 `zh-CN`、`en`、`ja`。默认 `auto` 参照适用的项目指引。此设置用于新生成的项目规范和语义文档。已有文档保留原文，原生流程入口保留其名称和模板。
- 从 `docs/rigup/development-rules.md` 按变更路径查找适用主题，再阅读 `development-rules/<topic>.md` 或原有指引。主题页写明规则、例外和验证方法，源码证据保存在私有运行记录。可通过 `projectConventions.documentRoutes.context` 指定输出目录。
- 使用 `change-prepare` 将需求、适用规则和检查写入所选 SDD 的提案与任务。审批后使用 `change-deliver` 实现并验证。两者共享项目指引，按变更范围复用已有的测试、CI 和 hooks。
- 两个技能的项目参考会列出已识别的专用检查及工作目录。遇到已识别的 Yarn、PM2、Playwright 或 PostgreSQL 检查，会显示准备条件和适用的终端命令。对于带测试库保护的单条 Jest 命令，指引会复用已有的串行选项，或在命令未指定并发方式时加上 `--runInBand`。若沙箱无法运行检查，在有权限的终端核对环境后执行交接命令，将退出状态和脱敏测试摘要带回原交付任务。

## 研究后端与预算

- `codex` 使用本机已登录的 Codex CLI。研究在隔离工作目录运行。Codex 可按主题请求限定行段或字面搜索，Rigup 在读取预算内返回选中的片段，每轮最多两批补证。规划、写作和验收按各自任务选取证据，锁文件只参与指纹校验。源码、配置或锁文件变化会使相关结果失效。
- `native` 通过 Anthropic API 研究。用 `--model` 或 `model.model` 选择模型，默认密钥变量为 `ANTHROPIC_API_KEY`，可用 `model.apiKeyEnv` 指定。`--model` 和 `--api-key-env` 会选择 native，与 `--backend codex` 互斥。Claude Code 登录与此 API 认证分开。
- `host` 导出私有研究请求。读取报告的 `requestPath` 和该轮输出要求，将实际结果包入 `requestId`、`requestDigest`、`model`、`data` 后保存到指定响应路径，再执行 `nextCommand`。续跑会验证证据、输入指纹和当前设置。`--request` 的目标须在私有 host 缓存内，且与 `--response` 互斥。

```sh
rigup init --agents codex --sdd openspec --backend host --review --json
```

Codex 默认最多 60 次请求、累计 120 万 token。发出请求前，Rigup 用已准备的上下文估算下一次所需额度。收到响应后，仍按 Codex 报告的实际总用量（含缓存输入）核验。单次调用可能超出估算。额度不足时报告已用量、上限、估算和建议的累计额度。确认额度后执行报告中的 `--continue … --research-tokens N`，续用原有请求和用量记录。重试同一运行时沿用已指定的额度，明确提供新额度时才调整。未知消费须先对账再重试。

Native 和 Host 默认 10 万 token。Native 将 token 预检和模型请求都计入请求数，Host 的实际用量由执行方另行对账。

## 应用与恢复

```sh
rigup update --review --json
rigup update --apply PREVIEW_ID --sessions-ended --json
rigup update --resume --review --json
```

以实际报告中的命令和预览 ID 为准。审阅写入和检查选择，结束会加载待改配置的 agent 会话，再从独立终端 apply。应用后重载宿主。

Rigup 比较上次生成的基线、本地文件和新候选。非重叠改动可合并，冲突保留本地内容，等待用户处理后重新预览。混合配置按拥有的键、表或标记块更新，完整文件也核对权限位。需要显式退役时使用 `--retire logicalId,...`。

中断后保留项目 `.rigup/` 和私有状态 `~/.local/state/rigup/`。普通候选与请求位于 `~/.cache/rigup/`。先核实 controller 和原生写入进程已退出，再在原项目路径运行 `rigup update --resume --review`。Rigup 从持久记录恢复原有选择和批准的预览。复核后，在独立终端执行报告中含 `--apply`、`--sessions-ended` 和 `--resume` 的命令。输入或权限前置变化时先对账，再生成新预览。对未确认的副作用保留记录，等待身份和结果核实。

工具安装使用 `.rigup/tools/` 下的专用暂存目录，核验包、依赖树和入口后才提升到正式路径。重试只清理私有记录可验证归属的暂存目录。旧安装残留如果占用了正式路径，先将报告列出的目录移到安全的位置留存，再复核同一预览。

升级前用生成预览的 Rigup 版本完成或核对中断的安装。研究续跑遇到中断安装时，会给出待处理的预览 ID。用该安装原有的审批完成恢复后，再继续研究。

Git 项目应用集成后，`.rigup/.gitignore` 会排除本机安装回执、基线、软件和原生工具状态。项目配置仍可跟踪。

升级前，先用原版本续跑或对账未完成的语义研究。准备新预览时，会使用新版本的证据格式和独立的预算记录。

## OpenWiki 和 CodeGraph

只接入工具时可以跳过 SDD 和模型研究。

```sh
rigup init --agents codex --sdd none --tools openwiki,codegraph --review --json
```

- CodeGraph 在隔离暂存区建索引，核验后提升到项目。软件与初始化分别留回执，已有用户状态需要对账。
- OpenWiki 安装软件、登记 MCP 并提供交接。重载宿主后，在独立会话用 `openwiki_begin` 的 `mode=init` 开始规划和逐页生成。已有运行按 OpenWiki 的进度恢复，完整 wiki 生成单独计时和计费。

## 工程检查和退出码

初始化完成后，用 agent 打开项目，按原生工作流准备提案、审批和交付。项目参考列出已有命令、工作目录和对应的项目文件。任务直接记录这些信息。例如在 Hexagon 根目录运行 `npm run deps:validate`，从原生命令输出定位违规文件，修复后重跑同一命令。

行为变更使用原生规格的场景和审批。任务记录实际命令与结果，并可链接项目测试报告或 CI 作业。数据库访问需要获准终端时，带上工作目录和已有准备条件。回到交付后读取项目测试报告，或记录退出状态和脱敏摘要。共享测试库检查按顺序运行。

`quality.preCommit` 和 `quality.prePush` 核对已有且启用的项目 hook。项目自己的 hook 决定检查输入和执行方式。GitLab 作业在 CI 的提交检出中直接运行所选项目命令，`reportPaths` 指向项目原本生成的 JUnit 文件。需要专用数据库或进程的检查使用项目已有的 CI 作业。OpenWiki CI 由 runner 提供固定版本工具和所需环境变量。

升级旧安装时，预览会列出待退役的旧启动包装器和检查脚本。旧 hook 由 Rigup 生成时，先把项目自有 hook 配置到项目自己的路径，再按预览的 `--retire` 提示处理旧的受管文件。已有验证记录仍可查阅。

`rigup doctor` 用于可选的安装诊断。显式选择已有命令才会执行，例如 `rigup doctor --run-checks test --json`。

退出码 `0` 表示当前阶段完成，`1` 为失败或冲突，`2` 为参数问题，`3` 为待办或交接，`130` 为取消。结合 `phase`、`installStatus`、`pending`、`conflicts` 和 `nextCommand` 判断下一步。
