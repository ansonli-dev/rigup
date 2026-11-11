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

省略路径时使用当前目录。交互终端保留已给的选项并补问缺少的设置，按 `b` 返回。`update --configure` 重新打开设置引导。`--json` 使用非交互模式，stdout 输出一个最终 JSON 对象，英文进度走 stderr。文档语言只控制生成内容。

`--dry-run` 保存私有候选和预览。已配置 provider 时，生成完整规则的 dry-run 仍会请求模型。首次设置可用 `--defer-research` 明确只准备基础接线。`--review` 提供待应用的预览与 `nextCommand`。配置完整时，非交互 `init` 和 `update` 按项目设置选择执行方式。Superpowers 和 Spec Kit 使用项目已有的官方入口。[验证范围](../compatibility/status.md) · [上游版本与入口](../compatibility/upstream-lock.json)

首次选择 OpenSpec 后，Rigup 检查 PATH 中的 CLI、项目的 OpenSpec 根和所选宿主的工作流入口。缺失时可确认自动补齐。Rigup 用 npm 安装锁定版本的 CLI，在临时目录生成原生文件并补入项目的空缺。已有项目配置和技能保留原样。自动安装使用用户终端里的 Node.js 22.12 或更新版本、npm 和 PATH 上可写的用户安装位置。便携版也按这个环境检查。

在显式审阅或非交互设置中，缺少先决条件时可执行报告的 `nextCommand`。其中 `--prepare-openspec` 单独补齐原生依赖，使用同一套保护步骤保留已有项目文件。交互中选择手动准备后，可用报告里的续跑命令，也可回到项目执行 `rigup init` 继续已选择的宿主和 OpenSpec。

在 PowerShell 中，用引号包住逗号分隔列表，也可以为每个值重复选项。

```powershell
rigup init . --agents claude --sdd none --tools 'openwiki,codegraph' --defer-research --review --json
```

## 项目配置

项目设置保存在 `.rigup/config.yaml`。优先级从高到低为 CLI 参数、项目设置、显式选择的 profile 和默认值。用 `--profile` 或 `profile` 指定 profile 文件，相对路径从目标项目根目录解析。`--configure` 的设置随预览一起审阅并应用。

```yaml
agents: [codex]
projectRules: true
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
- 仓库根目录的 `.rigupignore` 使用 gitignore 规则排除研究来源。Rigup 的 CLI 读取和 MCP 引用验收都使用同一范围。项目配置和原生工作流入口仍可用于安装与检查发现。宿主的 Glob 和 Grep 由宿主管理。研究任务会要求按源码目录搜索并跳过 .rigup/tools/。在 Claude Code 中，也可以把 Read(/.rigup/tools/**) 添加到项目 .claude/settings.local.json 的 permissions.deny 列表。OpenSpec 的项目规格和 Spec Kit 的项目 constitution 保留在可研究范围内，除非被项目主动排除。
- MCP 使用宿主原生的工作目录与环境变量配置。配置保存变量名，凭据由宿主环境提供。遇到宿主无法表达的参数展开或工作目录，选择项目已有的启动命令。安装后重载 agent，再检查实际连接。
- `customSkills` 接受本地 `source` 目录，可用 `position` 绑定 `prepare`、`deliver` 或 `release`。`templates` 通过 `source`、`target` 和 `values` 为允许的文档或 skill 资源做标量替换。`change-release` 需要真实的客户部署适配器。
- 对支持 HTTP MCP 的企业 GitLab、协作文档等服务，在对应 `mcp` 项填入 HTTPS `url` 和 `bearerTokenEnv: TEAM_MCP_TOKEN`。从启动宿主的环境提供专用凭据。宿主和服务继续负责工具权限、审批和读写范围。`rigup doctor` 只报告变量名及是否存在。

## 发现并补齐项目约定

新服务、已有规范的服务和混合仓库都可以用 `rigup init --review` 接入。后续用 `rigup update --review` 复核实际变化。预览的 `harness` 列出按工作目录发现的 npm 检查、可核实的 GitLab 作业和按范围适用的项目约定。执行结果由实际运行的检查提供，可以通过 `rigup doctor --run-checks build,test` 查看。

在团队 profile 或 `.rigup/config.yaml` 的 `projectConventions.topics` 声明需要整理的主题。每个主题使用稳定的小写 slug 和仓库相对范围。范围 `.` 表示全仓。已有规范可通过 `source` 指定。

```yaml
projectConventions:
  topics:
    - id: api-errors
      title: API 错误响应
      scope: [services/legacy]
      source: services/legacy/docs/errors.md
    - id: api-errors
      title: API 错误响应
      scope: [services/new]
```

待填约定默认创建在 `docs/rigup/conventions/`，每个主题与范围只创建一次。请保留 YAML 元数据，在下方填写正文，完成后把 `status` 改为 `confirmed`。选用 `not-applicable` 时在正文写明原因。下次更新会核对确认状态和适用范围，并更新工作流引用。更改文档目录或删除页面后，安装收据仍保留原始创建记录。

如果约定移到所选业务范围之外，在对应主题的 `source` 指定新路径，再复核该主题的适用范围。

局部或截断的扫描保留既有全局 GitLab 接线。要调整全局选择，先从完整仓库范围复核。v0.3.5 的已完成安装走同一更新入口。旧预览需要重新生成。用旧版完成尚未恢复的旧安装，再切换到新版。 [Unified Harness V1 兼容验证](../compatibility/unified-harness-v1.md)

## 先安装工作流，再生成规则

首次交互按 Enter 默认先安装基础接线、稍后生成规则。也可以同时准备两部分。基础安装支持 `--sdd none`，也可以在项目设置中保存 `sdd: none`。配置 `projectRules: false` 时可只安装所选工作流和工具。

```sh
rigup init --defer-research --review
rigup update --apply PREVIEW_ID --sessions-ended
```

基础设置完成后重载宿主，审核项目的 Rigup MCP 配置并启用它。要生成规则，可告诉 agent「为当前项目生成 Rigup 规则，从 `rigup_begin` 开始」。宿主按工具返回的任务执行分析、计划、内容和独立验收。服务端保存续跑状态，`rigup_finish` 只交付预览。退役旧条目时，在审阅列出的删除项后向 `rigup_finish` 提供相应 `retireIds`，再从独立终端应用。

自 v0.2.4 升级时，可用 `rigup update --configure --review` 接入 MCP，审阅后应用基础设置。恢复已批准但中断的安装时，使用原设置执行 `rigup update --resume --review`。

## 项目研发流程

- `--language` 和 `documentLanguage` 接受 `auto` 或语言标签，例如 `zh-CN`、`en`、`ja`。默认 `auto` 参照适用的项目指引。此设置用于新生成的项目规范和语义文档。已有文档保留原文，原生流程入口保留其名称和模板。
- 从 `docs/rigup/development-rules.md` 按变更路径查找适用主题，再阅读 `development-rules/<topic>.md` 或原有指引。主题页写明规则、例外和验证方法，源码证据保存在私有运行记录。可通过 `projectConventions.documentRoutes.context` 指定输出目录。
- 使用 `change-prepare` 将需求、适用规则和检查写入所选 SDD 的提案与任务。审批后使用 `change-deliver` 实现并验证。两者共享项目指引，按变更范围复用已有的测试、CI 和 hooks。对于 OpenSpec，交付前由 agent 核对活跃变更、必需产物和同一变更范围的人类审批。这项检查依赖 agent 遵循技能，文件写入权限由宿主及项目策略控制。
- 两个技能的项目参考会列出已识别的专用检查及工作目录。遇到已识别的 Yarn、PM2、Playwright 或 PostgreSQL 检查，会显示准备条件和适用的终端命令。对于带测试库保护的单条 Jest 命令，指引会复用已有的串行选项，或在命令未指定并发方式时加上 `--runInBand`。若沙箱无法运行检查，在有权限的终端核对环境后执行交接命令，将退出状态和脱敏测试摘要带回原交付任务。

## 研究后端与预算

CLI 支持 `anthropic` 和 `openai-compatible`。将 `RIGUP_PROVIDER`、`RIGUP_MODEL_ID` 和 provider 的密钥变量注入当前进程。Anthropic 使用 `ANTHROPIC_API_KEY`，OpenAI 兼容接口使用 `OPENAI_API_KEY`。可用 `RIGUP_BASE_URL` 指定 HTTPS API 根路径，`RIGUP_API_KEY_ENV` 指定自定义密钥变量名。环境变量优先于本机私有 `~/.config/rigup/provider.json` 中同一 provider 的 `model`、`apiKeyEnv`、`baseURL`。`--model` 覆盖本轮模型 ID。没有 provider 凭据时可在 agent 内使用 Rigup MCP。

```sh
rigup update --review --model MODEL_ID --json
```

私有 provider 文件使用 `provider`、`model`、`apiKeyEnv` 和可选 `baseURL`。限制文件和目录为当前用户可访问，并把密钥值留在进程环境或当次隐藏输入中。CLI provider 只能请求经过过滤的读取、清单和搜索。Anthropic 的计数预检和生成均计入请求数，OpenAI 兼容接口需要报告实际 token 用量。未知消费会保留在私有运行状态中，等待对账。MCP 宿主的模型费用由宿主记录。源码、配置或读取范围变化时会重新校验相关结果。

旧项目的后端设置和私有请求续跑参数继续用于兼容已有运行。新设置使用 CLI provider 或 Rigup MCP。续跑旧研究时以原报告里的命令为准。

## 应用与恢复

```sh
rigup update --review --json
rigup update --apply PREVIEW_ID --sessions-ended --json
rigup update --resume --review --json
```

以实际报告中的命令和预览 ID 为准。审阅写入和检查选择，结束会加载待改配置的 agent 会话，再从独立终端 apply。应用后重载宿主。没有文件、归属或工具操作变化时，审阅返回 `installStatus: up-to-date` 和退出码 0。基础接线完成而规则仍待生成时，返回退出码 3，并说明如何从宿主或 CLI 开始研究。

Rigup 比较上次生成的基线、本地文件和新候选。非重叠改动可合并，冲突保留本地内容，等待用户处理后重新预览。审阅时，手工改过的宿主入口标记块会单独列为冲突。JSON 报告用 `installStatus: conflict` 标识冲突，在 `error` 中列出阻塞原因。要继续更新，可把自定义内容移到标记之外并恢复块内的托管内容，然后运行 `nextCommand` 给出的审阅命令。混合配置按拥有的键、表或标记块更新，完整文件也核对权限位。需要显式退役时使用 `--retire logicalId,...`。

中断后保留项目 `.rigup/` 和私有状态 `~/.local/state/rigup/`。普通候选与请求位于 `~/.cache/rigup/`。先核实 controller 和原生写入进程已退出，再在原项目路径运行 `rigup update --resume --review`。Rigup 从持久记录恢复原有选择和批准的预览。复核后，在独立终端执行报告中含 `--apply`、`--sessions-ended` 和 `--resume` 的命令。输入或权限前置变化时先对账，再生成新预览。对未确认的副作用保留记录，等待身份和结果核实。

Windows 上，新建的私有缓存和状态目录使用独立的 ACL。若错误指出已有目录继承了额外权限，请先结束相关 Rigup 进程并检查错误中列出的路径和账号。保留已有数据，由目录所有者修正 ACL 后重试。如果报错的缓存目录来自失败的首次运行且为空，可先将它改名，再让 Rigup 重新创建。若报错路径是可被其他账号修改的父目录，请先修正该父目录的权限。

工具安装使用 `.rigup/tools/` 下的专用暂存目录，核验包、依赖树和入口后才提升到正式路径。重试只清理私有记录可验证归属的暂存目录。旧安装残留如果占用了正式路径，先将报告列出的目录移到安全的位置留存，再复核同一预览。

升级前用生成预览的 Rigup 版本完成或核对中断的安装。研究续跑遇到中断安装时，会给出待处理的预览 ID。用该安装原有的审批完成恢复后，再继续研究。

Git 项目应用集成后，`.rigup/.gitignore` 会排除本机安装回执、基线、软件和原生工具状态。项目配置仍可跟踪。

项目级 MCP 接线使用相对路径。让宿主的 PATH 可找到 受支持的 Node.js 和 Rigup。新 clone 里的共享接线可以启动服务，研究依赖本机建立归属记录。若初次预览发现已有文件归属不明，先留存冲突文件，再审阅重建后的接线。

升级前，先用原版本续跑或对账未完成的语义研究。准备新预览时，会使用新版本的证据格式和独立的预算记录。

## OpenWiki 和 CodeGraph

只接入工具时可以跳过 SDD 和模型研究。

```sh
rigup init --agents codex --sdd none --tools openwiki,codegraph --review --json
```

- CodeGraph 在隔离暂存区建索引，核验后提升到项目。软件与初始化分别留回执，已有用户状态需要对账。Windows 的项目内 MCP 入口默认将共享 daemon 空闲时间缩短为 3.5 秒。最后一个客户端断开后，待进程退出再移动或重装工具目录。已启动的 daemon 在重启后读取新的设置。
- OpenWiki 安装软件、登记 MCP 并提供交接。重载宿主后，在独立会话用 `openwiki_begin` 的 `mode=init` 开始规划和逐页生成。已有运行按 OpenWiki 的进度恢复，完整 wiki 生成单独计时和计费。

## 工程检查和退出码

`rigup doctor --check-host claude --json` 会从项目目录运行 Claude Code 的原生 MCP 健康查询。查询可能启动已批准的 MCP 服务，包括访问配置的远程服务。托管的项目级 MCP 服务都连接时，`claude:load` 显示 `passed`。此结果对应本次探针。已有交互会话可在 `/mcp` 查看自己的连接状态。

初始化完成后，用 agent 打开项目，按原生工作流准备提案、审批和交付。项目参考列出已有命令、工作目录和对应的项目文件。任务直接记录这些信息。例如在 Hexagon 根目录运行 `npm run deps:validate`，从原生命令输出定位违规文件，修复后重跑同一命令。

行为变更使用原生规格的场景和审批。任务记录实际命令与结果，并可链接项目测试报告或 CI 作业。数据库访问需要获准终端时，带上工作目录和已有准备条件。回到交付后读取项目测试报告，或记录退出状态和脱敏摘要。共享测试库检查按顺序运行。

`quality.preCommit` 和 `quality.prePush` 核对已有且启用的项目 hook。项目自己的 hook 决定检查输入和执行方式。GitLab 作业在 CI 的提交检出中直接运行所选项目命令，`reportPaths` 指向项目原本生成的 JUnit 文件。需要专用数据库或进程的检查使用项目已有的 CI 作业。OpenWiki CI 由 runner 提供固定版本工具和所需环境变量。

升级旧安装时，预览会列出待退役的旧启动包装器和检查脚本。旧 hook 由 Rigup 生成时，先把项目自有 hook 配置到项目自己的路径，再按预览的 `--retire` 提示处理旧的受管文件。已有验证记录仍可查阅。

`rigup doctor` 用于可选的安装诊断。显式选择已有命令才会执行，例如 `rigup doctor --run-checks test --json`。

退出码 `0` 表示当前阶段完成，`1` 为失败或冲突，`2` 为参数问题，`3` 为待办或交接，`130` 为取消。结合 `phase`、`installStatus`、`pending`、`conflicts` 和 `nextCommand` 判断下一步。
