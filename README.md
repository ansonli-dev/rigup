# Rigup

Rigup 为项目接入 coding agent、原生研发流程、MCP 和已有工程检查。它先读取项目证据，再准备候选、比较用户修改并安装。已安装的 skills、MCP runner、hooks 和 CI 脚本不依赖 Rigup CLI。

当前是实现与验收中的首版。源码与本地契约覆盖 Claude Code、Codex、OpenCode、Oh My Pi 的配置适配，以及 Superpowers、OpenSpec、Spec Kit 的原生入口绑定。真实发现、连接、生成质量和完整组合验收分别记录在 [验收记录](docs/compatibility/verification.md)；配置文件可解析不代表宿主已经加载。

## 本地运行

需要 Node.js 24+、npm；快照检查还需要 Git。当前实际验证环境为 macOS，其他平台需要单独验证。

```sh
npm ci
npm test
npm run build
node dist/cli.js --help
```

先在目标目录或宿主可发现的用户/插件位置准备所选 SDD 的官方入口。Rigup 核对原生调用名、来源身份和已声明依赖；可核实的启用插件会参与发现，多来源冲突、依赖缺失或版本不明确时保持待处理。原生客户端实际加载仍需独立验证。框架与工具的精确来源见 [upstream-lock.json](docs/compatibility/upstream-lock.json)。

默认 agent 和研究后端为本机 Codex；语义研究使用已有 Codex 登录，不需要额外 API key。仅接入工具或普通本地 skill 时不调用模型，也不必选择 SDD：

```sh
node dist/cli.js init /path/to/project --tools openwiki,codegraph --dry-run --json
node dist/cli.js init /path/to/project --agents codex
node dist/cli.js update /path/to/project --json
node dist/cli.js doctor /path/to/project --json
```

有效设置完整时，非交互 init/update 默认连续完成。TTY 在研究前集中补问缺失项和本轮完成方式。`--json` 不读取 stdin；stdout 只含一个最终对象，进度写入 stderr。`--dry-run` 只保存私有候选和预览，不安装。`--review` 提供具体变更、绑定的检查选择、previewId 和独立 apply 命令。检查选择保存在预览中，独立 apply 不能通过省略参数跳过已选检查。

## 项目设置

唯一的项目设置文件是 `.rigup/config.yaml`。优先级为 CLI 覆盖、项目设置、显式选择的 profile、默认值。profile 路径通过 `--profile path` 或 `profile:` 选择，不扫描其他 profile。

```yaml
agents: [codex]
backend: codex
sdd: openspec
executionPolicy:
  mode: continuous
readBudget:
  maxFiles: 2000
  maxBytes: 8000000
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

MCP 登记不会启动服务。环境变量在已安装 runner 运行时解析；配置、请求和报告不保存凭据值。远端 URL 的认证参数、URL 内嵌凭据和命令中的明文认证参数会被拒绝。服务是否已连接需另行验证。

`--configure` 在本轮预览中保存有效设置；TTY 可返回修改，非交互只使用明确提供的设置。它只对本次配置目标形成绑定摘要的裁决，不授权覆盖其他用户文件。保存 continuous/review 偏好也不代表未来操作获得无限授权。

普通自定义 skill 使用 `customSkills: [{source: /absolute/local/skill}]`。选择 `position: prepare|deliver|release` 表示参与相应位置；release 仍要求真实部署适配器。自定义资源原样复制，附带脚本不会在 setup 时执行。

本地上下文模板使用 `templates: [{source, target, values}]`，仅支持标量 `{{name}}` 替换。目标限于所选文档或 skill references/assets；不能替换固定 SKILL 主流程、可执行脚本、hooks/CI 或机器配置。原文充足时优先引用现有规范，系统现状正文由 OpenWiki 维护。

## 研究后端

`codex` 是默认本机后端，目前验证 Codex CLI 0.166.0。它在项目外的空私有目录运行，只接收经过读取策略过滤的证据；忽略用户配置，禁用 shell、浏览器、应用和子 agent，不选择另一个模型，也不复制登录凭据。研究、规划、正文和验收沿同一条主线连续执行。结果先通过 Evidence 校验，再进入安装候选。

`native` 是 Rigup 的独立模型后端，目前使用 Anthropic SDK，与目标 coding agent 无关。通过 `--model` 或 `model.model` 选择已开通的模型；也可使用 `ANTHROPIC_MODEL`。显式 `--model`/`--api-key-env` 默认选择 native；与 `--backend codex` 同时使用会在研究前拒绝，避免静默忽略提供方选择。API key 来自 `model.apiKeyEnv` 指定的变量，默认 `ANTHROPIC_API_KEY`。TTY 临时输入的隐藏密钥只在本轮内存中使用，不保存到配置。

`host` 导出经过读取策略过滤的研究请求，交给宿主 agent 返回 JSON。沿同一条 init/update 主线逐阶段续跑，不产生可安装的半成品：

```sh
node dist/cli.js init /path/to/project --backend host --sdd openspec --agents codex --json
# 按报告中的 requestPath 完成研究，将响应保存到给出的本地路径。
# 使用 nextCommand；它包含 --continue 和 --response，保留本轮仍匹配的选择与范围。
```

响应包含 `requestId`、`requestDigest`、`model` 和 `data`。data 按导出的 instructions/context 返回 observations、unknowns 及当前阶段的 artifacts/dispositions、content 或 accepted/reason。Evidence 必须对应过滤后的路径、行号与摘要。

`--request /absolute/private/path.json` 可指定导出位置，必须在本机私有 host 缓存目录内；它与 `--response` 互斥。默认缓存为 `~/.cache/rigup/host/`。响应可从显式本地文件读取，仍须通过原请求和当前上下文校验。源码、库存、有效选项、版本或执行方式变化会拒绝旧上下文。不要手写批准、通过状态或执行命令来代替研究结果。

codex 在发送输入前持久记录请求与未知用量，完成后记录 CLI 实际 input/output token；失败、缺损日志或未知结果不会自动重发。本轮身份、累计预算和已返回结果保存在普通缓存之外，缓存删除不建立新一轮请求，结果复用不新增调用。CLI 的总输入/推理用量无法在服务器端硬封顶，当前在每次实际用量返回后核验剩余上限，超额结果不被接受；这与 native 的发送前 token 预检分别记录。native 将 token 预检和模型请求计入请求预算。host 的人工往返无法自行证明模型 token 用量，报告明确标为 unknown；执行宿主的一方需另外约束、记录真实用量。研究读取范围和字节预算在所有阶段共享，不能通过正文任务越界。

## 预览、更新和恢复

每项比较 B（上次生成）、L（本地）和 N（新候选）。L=B 时更新，N=B 时保留用户修改；非交叠改动可合并，重叠冲突则保留 L。已知托管资产的基线损坏时，先隔离这些目标并停止语义研究/复用，等待对账；不会把旧生成规则当新规范。缺少可信基线不会自动接管既有内容；用户删除的托管项也不会自动重建。混合配置只编辑拥有的键、表或标记块，基线不复制无关字段。

预览检查最终虚拟项目的配置、入口和链接。用户保留的局部修改若破坏必需绑定，安装同样会停止。逐项 adopt/restore/replace/remove 裁决通过 `preview(plan, resolutions)` 绑定目标、选择器与当前完整摘要后重新预览；CLI 当前会报告冲突，用户可先手工处理，再运行更新。明确退役使用 `--retire logicalId,...`，遗漏旧项不授权删除，也不会自动卸载共享软件。

```sh
node dist/cli.js update /path/to/project --review --json
node dist/cli.js update /path/to/project --apply PREVIEW_ID --sessions-ended --json
```

结束会加载待改资产的宿主会话，再从独立终端 apply，之后重载配置。此交接也适用于默认 Codex 后端和中断恢复；报告保留具体预览及下一条命令。响应本身不授权热更新。

同一目标使用同一执行锁。写入前保存持久未决记录和必要备份；外部进程通过启动屏障，记录持久保存后才开始写。manifest 最后切换，新基线使用独立目录，旧 B 保留。多文件写入并非整体事务，失败后可能已有部分效果；Rigup 不 reset 工作区或假装失败前什么都没发生。

崩溃后使用 `rigup update /path/to/project --resume` 对账。已批准的中断预览有独立持久副本，普通候选缓存删除后也能恢复；恢复 apply 不要求重新提供研究模型凭据。活动进程或未确认结果仍会阻止后续写入。普通缓存丢失不能清除持久未决状态；无可信基线时保留冲突。状态目录为 `~/.local/state/rigup/`，普通候选/请求在 `~/.cache/rigup/`。不要通过删除持久状态来绕过未确认的写进程。

当前自动软件安装仅针对锁定的 OpenWiki/CodeGraph，位于新的空 `.rigup/tools/<id>/` 范围，禁用 npm lifecycle scripts，并验证包、依赖树、launcher 和安装回执。`--tools openwiki,codegraph` 为 OpenWiki 安装软件并登记 MCP，为 CodeGraph 另行规划受保护索引：官方接口先写入空暂存区，验证后原子提升索引。已有非空用户状态不被接管；软件回执与 CodeGraph 初始化回执分别保存。根 agent 指令、计划工作流和 Git hooks 不由自动索引覆盖。无法证明安全的既有状态保持待对账；Superpowers+OMP 的绑定也尚未验证。没有已验证部署适配器时不安装 `change-release`。

OpenWiki 的完整研究和 wiki 生成可能耗时较长，由用户在脚手架完成后单独发起。Rigup 不创建 OpenWiki 规划 run、不等待 wiki 生成，也不把它作为脚手架安装的完成条件。旧配置中的 OpenWiki `initialize: true` 同样只给出独立操作指引；已成功的旧初始化允许只读对账，未完成的旧操作不会自动重新派发。

安装完成后，在本项目重启 Codex（或所选 coding agent），确认 OpenWiki MCP 已加载，再发起独立任务：

```text
使用 OpenWiki MCP，根据当前源码和测试初始化本仓库的 wiki。
从 openwiki_begin（mode=init）开始，按原生流程完成规划、逐页生成和收尾。
如果已有未完成的运行，恢复已有进度。
```

该任务的运行时间和模型消费由单独会话承担，进度由 OpenWiki 原生机制保存；初始化是否完成以 OpenWiki 的实际状态为准。脚手架预览、安装报告和 doctor 都会提供这一步指引，未生成 wiki 不会阻塞安装。doctor 仍会如实将尚未核实的原生初始化标为 pending。

自动原生索引开始前就保存初始化意图；manifest 尚未提交时，已知生成区同样被隔离，避免中断产物回流成研究依据。中断期间源码变化会拒绝旧预览，需先对账再重新准备；不会自动认领同名用户目录来绕过该边界。旧 OpenWiki 回执和未决记录的隔离保护继续保留。

## 工程检查与报告

`quality.preCommit`、`quality.prePush` 和 `quality.gitlab.checks` 从已有 build/lint/test/environment/eval 命令中选择，不创建业务测试体系。示例：

```yaml
quality:
  preCommit: [lint]
  prePush: [test]
  maxPushCommits: 100
  gitlab:
    checks: [test]
    reportPaths: [reports/junit.xml]
```

pre-commit 检查 index，pre-push 检查 hook 输入中的实际推送 commit 范围；从选中 Git tree 的原始 blobs 和文件模式创建隔离快照，不应用 `export-ignore`/`export-subst`，不 stash/reset，也不借用工作区未提交修复或 node_modules。团队须提供能在快照内运行或准备依赖的既有命令；依赖不可用时明确失败，不回退到工作区。符号链接、submodule 和超出范围预算的快照需单独适配。已有 hook 不覆盖；共享 hooks 路径越出当前 worktree 时保持人工待办。

GitLab 以拥有的 include 块接入，保留客户 jobs/includes/comments。报告与失败退出码一并保留。OpenWiki CI 更新只处理明确的 source 路径，不 commit/push，跳过 generated-update 标记；固定版本软件、既有初始化及模型凭据仍是 CI 前置条件。

```sh
node dist/cli.js doctor /path/to/project --run-checks environment,test,eval --json
```

doctor 默认只读，不初始化或修复业务。只有显式 `--run-checks` 才执行所选已有命令。配置、软件可用性、初始化、宿主重载、环境、软件测试和 Agent eval 分开记录；每次真实检查绑定命令、输入、commit、环境和时间。项目检查失败不会抹掉已成功安装的接线。

退出码：0 为本次阶段完成（dry-run 尚未安装）；1 为失败/冲突；2 为参数或字段格式错误；3 为必需输入、外部前置或续跑待办；130 为取消。JSON 含 phase、installStatus、checks、pending、conflicts、requiredInput、nextCommand 及相关 preview/report 数据。

进度计数来自实际事件。静默任务在 TTY 10 秒、纯文本 30 秒反馈存活，60 秒无进展说明等待对象。没有可比样本时显示 ETA 待估算；人工等待不倒计时，失败不显示虚假 100%。

## 验证与待办

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm run test:live
```

普通测试使用固定项目和受控协议，不等于真实语义验收。live 测试写入脱敏证据；独立模型需要 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_MODEL`，宿主生成需要已登录的 Codex 与 `RIGUP_OPENSPEC_BIN` 指向官方 OpenSpec 1.16.0。可用 `RIGUP_LIVE_PROJECTS=service` 限定单个生成 fixture，`RIGUP_LIVE_HOST_MODEL` 选择该宿主实际可用的模型。每次 live setup/update 最多 12 个宿主请求，默认 300000 个观察到的 token；复杂 fixture 可在启动前用 `RIGUP_LIVE_MAX_TOKENS=500000` 提高到硬上限 500000，历史失败用量仍留证。`RIGUP_CODEGRAPH_BIN` 可指向官方 1.6.2 二进制，验证独立临时项目的真实索引、查询和增量更新。

缺失环境会明确记录 pending。真实生成还需对预标注的支持样例、反例、范围、原规范复用、源码变化和用户修改保护逐项复核。GitLab 服务端 lint、其他宿主/框架组合、其他平台和发布接入各有独立状态，不能由一个成功案例推广；详见 [验收记录](docs/compatibility/verification.md)。

本机 Codex/原生工具主线可单独复验，其他宿主与模型矩阵无需一起运行：

```sh
RIGUP_LIVE_NATIVE=1 RIGUP_LIVE_CODEX=1 node --import tsx --test test/live-native-initialization.test.ts
RIGUP_LIVE_CODEX_BACKEND=1 RIGUP_OPENSPEC_BIN=/path/to/openspec node --import tsx --test test/live-codex-backend.test.ts
```

第一组验证官方固定版本安装、CodeGraph 受保护初始化/恢复、OpenWiki 独立交接及 Codex MCP 连接，不调用模型。第二组使用本机默认 Codex 模型验证研究到安装与无变化复用；不运行模型切换。

另已对锁定提交的 Domain-Driven Hexagon 和 Bulletproof React 运行真实 GitHub 项目 E2E。DDD 主线通过，前端工具接线及业务浏览器测试通过；前端完整语义流程因研究预算超限未完成，保留失败结果。对象、环境调整、实际用量和复验入口见 [真实项目记录](docs/compatibility/evidence/2026-11-05-github-projects/README.md)。
