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

省略路径时使用当前目录。交互向导固定显式参数，按项目配置和探测结果预选其余选项。`update --configure` 重新打开向导。可绘制的终端用 Space 多选，行式模式接受 `1,2`、`1，2`、`1、2`、`1 2`，按 `b` 回到上一可编辑项。可选工具允许空选。遇到错误输入会重问当前项。

可执行预览按 agent 配置、项目指南、Rigup 配套文件等类别汇总改动。选择安装、保存预览或取消。保存后可复制终端显示的 `--apply` 命令。默认输出报告本轮写入与下一步。加 `--verbose` 可查看路径、完整日志位置和通过的诊断项目。完整差异保存在私有状态目录。`rigup doctor` 默认显示诊断汇总、需要处理的项目和下一步。`--json` 使用非交互模式，stdout 输出一个对象，文本诊断走 stderr。

`--dry-run` 保存私有候选和预览。已配置 provider 时，生成完整规则的 dry-run 仍会请求模型。首次设置可用 `--defer-research` 明确只准备基础接线。`--review` 提供待应用的预览与 `nextCommand`。成功生成但尚未应用的预览返回退出码 3，表示需要确认或应用。配置完整时，非交互 `init` 和 `update` 按项目设置选择执行方式。Rigup 核对工作流入口的来源和依赖。Claude Code 和 Oh My Pi 缺少 Superpowers 时，参见[准备 Superpowers](#准备-superpowers)。 [验证范围](../compatibility/status.md) · [最近验证的上游组合](../compatibility/upstream-lock.json)

首次选择 OpenSpec 后，Rigup 检查已核验的项目 CLI 或安全 PATH 上的 CLI、项目的 OpenSpec 根和所选宿主的入口。已有 CLI 时沿用其版本，可用 `--prepare-openspec` 补齐项目文件。缺少 CLI 时，交互引导默认项目范围。项目范围使用 `.rigup/tools/openspec/`，便携版可使用随附的 Node 和 npm。全局范围使用终端 PATH 上的 Node 和 npm，以及可写的用户前缀。两种范围都在准备前显示并冻结版本、registry、包完整性和目标位置，再核对对应 Node 是否满足包的要求。

```sh
rigup init --agents codex --sdd openspec --prepare-openspec --install-scope project
rigup openspec status --change my-change --json
```

使用 `--install-scope global` 可显式选择全局安装。旧式独立准备命令省略 `--install-scope` 时沿用全局默认。项目范围的 `rigup openspec` 可从子目录执行，使用项目根并保留原生参数、输出和退出码。Rigup 在隔离环境中生成所选宿主缺少的原生文件，核对后补入项目。OpenSpec 2.1 起使用原生 `--scope project`。 [OpenSpec 2.1 发布说明](https://github.com/Fission-AI/OpenSpec/releases/tag/v2.1.0)

在显式审阅或非交互设置中，缺少先决条件时可执行报告的 `nextCommand`。其中 `--prepare-openspec` 单独补齐原生依赖，使用同一套保护步骤保留已有项目文件。交互中选择手动准备后，可用报告里的续跑命令，也可回到项目执行 `rigup init` 继续已选择的宿主和 OpenSpec。

OpenWiki 和 CodeGraph 优先复用项目回执核验通过的安装，也可复用安全 PATH 上已有的安装。缺少软件时，交互引导提供可用范围，默认项目。项目模式与非交互首次自动安装使用 `.rigup/tools/`，全局模式写入当前用户的 npm 前缀。新安装预览展示精确版本、registry、包完整性和目的地。应用和中断恢复使用原审批，后续项目可复用全局 PATH 安装。用 `RIGUP_NPM_REGISTRY` 选择 registry。

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
- 对支持 HTTP MCP 的企业 GitLab、协作文档等服务，在对应 `mcp` 项填入 HTTPS `url` 和 `bearerTokenEnv: TEAM_MCP_TOKEN`。从启动宿主的环境提供专用凭据。宿主和服务继续负责工具权限、审批和读写范围。`rigup doctor` 列出变量名、实际消费者和待验证状态。

应用设置时，Rigup 按已启用的本地消费者增量准备私有 `.rigup/.env`，并将它及临时文件加入 `.rigup/.gitignore`。原有注释和非空值保留。空值可从明确配置、无歧义的仓库目标或已声明的调用环境填入。基础向导默认将提供方凭据留在调用环境。审阅和 dry-run 不写该文件。模板只声明所选能力需要的输入，JSON 和终端报告不含值。已跟踪、链接或未被有效忽略的文件保持原样并提示修正。写入时，Rigup 先限制临时文件的权限，再写入凭据并原子替换。

CLI provider 和显式选择的 `customer.commands.environment` 可以读取各自声明的本地输入。后者通过 `--run-checks environment` 执行，仅向该命令传入声明的引用；参数中的 `${NAME}` 以无 shell 的临时参数展开，保存的命令仍保留引用。恢复安装时保留历史检查，但只有本次实际执行的检查能验证当前输入。宿主启动的 MCP 和 GitLab CI 从宿主或 runner 获取凭据，本地存在同名变量不能证明它们已配置或连接。生成本地 GitLab include 不需要 token 或远端地址。远端目标只从明确配置或唯一兼容 Git remote 推导。

自动安装 OpenSpec、OpenWiki 或 CodeGraph 优先使用包所属 scope 的 registry，未设置时使用通用 registry。npm 沿用用户的 `.npmrc`、代理和 CA。实际安装使用用户设置的缓存，预览查询使用独立临时缓存。`RIGUP_NPM_REGISTRY` 可覆盖本次安装的两种 registry 设置，值须为无凭据的 HTTPS 地址或回环 HTTP 地址。预览按包列出实际 registry、版本和完整性。来源变化后需重新审阅，已核验的暂存可用原批准恢复。

项目 YAML 中的未知顶层键会产生告警，重配时保留手写值和注释。MCP 省略 `agents` 时跟随本次最终选中的宿主。命令默认在项目根运行，环境引用默认为空。工具省略 `install` 或 `initialize` 时只复用现有工具。自定义模板会替换已提供的值，保留其他占位文本。

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

局部或截断的扫描保留既有全局 GitLab 接线。要调整全局选择，先从完整仓库范围复核。v0.3.5 的已完成安装走同一更新入口。 [Unified Harness V1 兼容验证](../compatibility/unified-harness-v1.md)

## 准备 Superpowers

首次交互式 `rigup init` 选择 Claude Code 或 Oh My Pi 和 Superpowers 后，Rigup 会展示可执行的准备步骤，再询问是否批准。也可以单独准备，包括已配置的项目：

```sh
rigup init . --agents 'claude,omp' --sdd superpowers --prepare-native --review --json
rigup init . --agents 'claude,omp' --sdd superpowers --prepare-native
```

独立准备结束后直接退出。向导准备成功后重新扫描，再生成常规的项目预览。Rigup 复用已识别的有效入口。缺失时默认展示要执行的命令和写入位置。加 `--verbose` 可查看来源、完整性和核验详情。CLI 版本在批准后探测，与最近验证版本不同会显示提示。若本地还没有 Claude 官方 marketplace，先批准添加，再批准从目录读取的插件目标。

| 宿主 | 批准后可能写入 |
| --- | --- |
| Claude Code | 项目共享的 `.claude/settings.json`、Claude 用户配置目录中的市场和插件缓存及本机状态。Rigup 展示缓存官方目录中的 Superpowers SHA 和可用版本，并核对安装回执及复扫结果。 |
| Oh My Pi | OMP 插件目录中的 `omp-plugins.lock.json` 和插件文件。能创建目录符号链接时，Rigup 校验固定包的 SHA-512 后从私有状态目录建立链接。Windows 拒绝创建目录符号链接时，Rigup 先展示固定版本的 registry 安装供批准，再核对 `bun.lock` 的完整性、安装目录和加载入口。Claude 项目插件已提供完整工作流时可直接复用。 |

`--review` 和 `--dry-run` 检查准备计划，检查成功返回 0。Review 模式、JSON 输出和重定向保留预览交接。独立准备需要后续操作时返回 3，执行或校验失败返回 1，取消返回 130。交互安装须在终端明确选择“批准”或 Approve。改动使用中的宿主配置后，按提示重载宿主。

如果需要处理阻塞，可在终端或 `--json` 的 `nativePreparation.blockers` 中查看宿主、问题代码、证据路径和建议操作。`.env` 诊断仅列出可能影响安装位置的键名。核对状态并处理问题后，重跑相同命令。Rigup 会使用已验证的现场状态，跳过成功步骤。若报告无法确认写入进程已退出，应先等待进程退出或手动核对状态。已验证的 Claude 项目安装可用 `claude plugin uninstall superpowers@claude-plugins-official --scope project --keep-data` 移除；共享市场缓存不应随意删除。可用 `omp plugin uninstall @loneexile/omp-superpowers` 移除 OMP 插件。有效链接仍使用 Rigup 私有目录中的固定包。

## 先安装工作流，再生成规则

首次交互安装和重配默认把规则生成延期。基础安装支持 `--sdd none`，也可以在项目设置中保存 `sdd: none`。配置 `projectRules: false` 时可只安装所选工作流和工具。启用规则生成后，可用 `--model` 显式请求 CLI provider。

```sh
rigup init --defer-research --review
rigup update --apply PREVIEW_ID
```

基础设置完成后重载宿主，审核项目的 Rigup MCP 配置并启用它。要生成规则，可告诉 agent「为当前项目生成 Rigup 规则，从 `rigup_begin` 开始」。宿主按工具返回的任务执行分析、计划、内容和独立验收。服务端保存续跑状态，`rigup_finish` 只交付预览。退役旧条目时，在审阅列出的删除项后向 `rigup_finish` 提供相应 `retireIds`，再从独立终端应用。

MCP 分析任务的 `seedPaths` 是从可读清单选出的样本，优先提供根指引、构建配置和不同目录的代码与测试。宿主可用已授权的工具继续查找相关文件。提交引用时填写仓库相对路径和准确行号。遇到清单外、拒读或越界错误时，按报告中的路径和原因更正引用，再提交同一任务。Rigup 会遮盖边界明确的凭据命中行并保留证据行号，对无法安全处理的内容继续拒读。

自 v0.2.4 升级时，可用 `rigup update --configure --review` 接入 MCP，审阅后应用基础设置。恢复已批准但中断的安装时，使用原设置执行 `rigup update --resume --review`。

## 项目研发流程

- 向导首问选择中文或 English。已有明确设置时直接使用该语言。非交互命令可用 `--language zh-CN` 或 `--language en`。应用后选择保存在 manifest 中，使用 `--configure` 时也写入项目配置。
- `--language` 和 `documentLanguage` 也接受 `auto` 和其他 BCP 47 标签。`auto` 的界面随系统语言，固定模板为英文，语义文档仍参照项目指引。其他语言标签用于模型生成文字，界面和固定模板采用英文。技能标识符、引用路径及机器报告字段保持稳定。修改产出物语言后需生成新预览。
- 从 `docs/rigup/development-rules.md` 按变更路径查找适用主题，再阅读 `development-rules/<topic>.md` 或原有指引。主题页写明规则、例外和验证方法，源码证据保存在私有运行记录。可通过 `projectConventions.documentRoutes.context` 指定输出目录。
- 使用 `change-prepare` 将需求、适用规则和检查写入所选 SDD 的原生产物，并准备同一变更的 `GOAL.md`。提案、设计和任务需互相一致并经过审阅。`change-ready` 只读检查所有原生前置条件、同一变更引用、验收与验证对应关系和审批范围；通过后给出包含实际仓库相对路径的 `/goal` 命令。宿主支持该命令时用原生 goal 执行，其他情况用 `change-deliver` 交接，不假定 Claude 提供 `/goal`。这项行为检查依赖 agent 实际加载并遵循技能。即使技能已加载，宿主仍可能执行明确的覆盖指令；技能不能替代宿主的文件权限和项目策略。
- 推送前审阅每次待推送提交。已配置 MR 流程时，跟进现有 CI 和 reviewer 的最新 head SHA，处理发现并记录结论；再次推送会使旧的完成证据失效。技能不凭空创建远端工具或把尚未结束的 review 当成通过。
- 工作流的项目参考列出已识别的专用检查及工作目录。遇到已识别的 Yarn、PM2、Playwright 或 PostgreSQL 检查，会显示准备条件和适用的终端命令。对于带测试库保护的单条 Jest 命令，指引会复用已有的串行选项，或在命令未指定并发方式时加上 `--runInBand`。若沙箱无法运行检查，在有权限的终端核对环境后执行交接命令，将退出状态和脱敏测试摘要带回原交付任务。

## 研究后端与预算

CLI 支持 `anthropic` 和 `openai-compatible`。配置 `RIGUP_PROVIDER`、`RIGUP_MODEL_ID` 和对应的密钥变量。Anthropic 使用 `ANTHROPIC_API_KEY`，OpenAI 兼容接口使用 `OPENAI_API_KEY`。`RIGUP_BASE_URL` 接受 HTTP 或 HTTPS API 根路径、本地网关和 `api-version` 等非秘密查询参数。密钥通过 `RIGUP_API_KEY_ENV` 指定的变量提供。请求禁止重定向。`.rigup/.env` 的已声明非空值优先于调用环境，其次取本机私有 `~/.config/rigup/provider.json` 中同一 provider 的设置。`--model` 覆盖本轮模型 ID。没有 provider 凭据时可在 agent 内使用 Rigup MCP。

```sh
rigup update --review --model MODEL_ID --json
```

使用 `--model`、在调用环境中设置有效的 `RIGUP_PROVIDER`，或在提供方提示中选择 CLI 提供方，可授权本次设置导入该提供方的环境输入。选择后运行 `rigup update --review` 并应用保存的预览，即可为已有项目补齐输入。默认由 agent 生成规则时，调用环境中的 provider 密钥保持在调用环境。应用读取获准变量的当前值，保留项目文件里的非空值。实际复制密钥时，终端会显示变量名、目标路径及 Git 忽略状态。提示中键入的密钥仅供本次请求使用。

私有 provider 文件使用 `provider`、`model`、`apiKeyEnv` 和可选 `baseURL`、`maxOutputTokens`。限制文件和目录为当前用户可访问，密钥值留在受保护的本地输入中。每次生成默认最多 16,384 输出 tokens，可用 `RIGUP_MAX_OUTPUT_TOKENS` 或私有设置覆盖，必须是正安全整数，并始终受剩余预算约束。

`maxCalls` 统计实际 HTTP 请求，Anthropic 的远程 `count_tokens` 也计一次。该端点返回 404/405 时，本次后端会话改用保守的序列化 UTF-8 字节估算并报告此情况；其他错误不会静默降级。生成仍必须返回可信的实际 token 用量，未知消费保留在私有运行状态中等待对账。CLI provider 只能请求经过过滤的读取、清单和搜索；授权读取超过文件末尾时可获得过滤后的行数重试，无效最终结果至多在原剩余预算内修复一次并重新完整校验。MCP 宿主的模型费用由宿主记录。源码、配置或读取范围变化时会重新校验相关结果。

直接调用 API 时执行预算上限。Codex 和 Host 文件交接会报告预算告警。Codex 按 `--version` 记录每次尝试的实际版本。`RIGUP_CODEX_TIMEOUT_MS` 接受正整数毫秒，默认 300000。超时或取消后，下一次续跑为当前阶段创建独立尝试。有效的已接受结果和原版本记录可继续复用。

旧项目的后端设置和私有请求续跑参数继续用于兼容已有运行。新设置使用 CLI provider 或 Rigup MCP。续跑旧研究时以原报告里的命令为准。

## 应用与恢复

```sh
rigup update --review --json
rigup update --apply PREVIEW_ID --json
rigup update --resume --review --json
```

以实际报告中的命令和预览 ID 为准。审阅写入、检查和软件范围后，可在当前会话 apply。应用后重载受影响的宿主。无变更时审阅返回 `installStatus: up-to-date` 和退出码 0。基础接线完成、规则待生成时返回退出码 3，并给出研究入口。

Rigup 比较上次生成的基线、本地文件和新候选。非重叠改动可合并，冲突保留本地内容，等待用户处理后重新预览。审阅时，手工改过的宿主入口标记块会单独列为冲突。JSON 报告用 `installStatus: conflict` 标识冲突，在 `error` 中列出阻塞原因。要继续更新，可把自定义内容移到标记之外并恢复块内的托管内容，然后运行 `nextCommand` 给出的审阅命令。混合配置按拥有的键、表或标记块更新，完整文件也核对权限位。需要显式退役时使用 `--retire logicalId,...`。

文本归属比较接受 CRLF/LF 差异，实际内容和权限编辑仍受保护。

克隆已配置 Rigup 的仓库后，使用 `rigup update --review` 核对从项目 MCP 配置识别的 agent。按终端命令应用，Rigup 会在 Git 忽略的本机状态中登记已验证配置的归属，并保留检出的文件字节。若缺少或改动了必需的 Rigup 入口，先按报告核对相应路径。无法确认归属的可选项会在预览中提示，可另行审阅。

中断后保留项目 `.rigup/` 和私有状态 `~/.local/state/rigup/`。普通候选与请求位于 `~/.cache/rigup/`。在原项目路径运行 `rigup update --resume --review`，复核恢复的选择和批准预览，再执行报告中的 `--apply` 与 `--resume` 命令。仍在运行的写入进程会阻止重试。相关输入、目标或检查声明变化时，报告列出需要复核的路径。

Windows 缓存和状态目录使用文件系统现有的目录权限。发布私有 `.rigup/.env` 前，Rigup 为同目录的空临时文件设置当前用户专用 ACL，再写入值并原子发布。

普通写入和恢复记录文件系统实际保存的权限。WSL 的 drvfs 在未启用 metadata 时也可保存普通项目文件。私有值需要文件系统提供受保护的写入权限。无法设置私有权限时，可使用已声明的进程环境变量，报告会指出相关文件。

项目工具安装使用 `.rigup/tools/` 下的专用暂存目录，核验后才移到正式路径。Git 跟踪或忽略规则不符合要求时先保留现场，按报告修正。全局工具按用户前缀串行安装，未核验的残留指向原批准。中断后使用报告里的 `--resume` 命令。独立 OpenSpec 准备也保留原项目和安装范围，已经完成的原生写入会在后续预览取消时继续保留。

升级后，尚未开始应用的 v0.4.0 预览需要重新生成。已开始应用的 v0.4.0 审批可以在 v0.4.1 中按上述流程恢复，Rigup 会核对持久记录。若报告要求原版本，请使用生成预览的可执行文件完成或核对安装。研究续跑遇到中断安装时，会给出待处理的预览 ID。恢复安装后再继续研究。

升级到 v0.7.0 时，尚未应用的 v0.6.0 预览需要重新生成。中断的 v0.6.0 安装先用原版继续或核对现场。旧的 OpenSpec 全局安装锁缺少写入进程的持久证据时，保留锁和前缀中的现有文件，确认旧进程退出后再按报告对账。

Git 项目应用集成后，`.rigup/.gitignore` 会排除本机安装回执、基线、软件和原生工具状态。项目配置仍可跟踪。

项目级 MCP 接线使用相对路径。让宿主 PATH 中第一个 Rigup 与生成项目启动器的版本一致，并提供受支持的 Node.js。启动器在模型研究前检查该可执行文件的版本；不会跳过旧版去选择后面的安装。新 clone 使用启动器内的版本，存在本机 manifest 时二者也必须一致。研究依赖本机建立归属记录。

v0.9.0 可恢复受支持的 v0.8.0 已批准写入和旧 Host `--continue … --response …`。研究续跑会复验引用、反例查询及阶段输入。无关编辑可保留已接受页面，相关证据变化会重新发出受影响的任务。

## OpenWiki 和 CodeGraph

只接入工具时可以跳过 SDD 和模型研究。

```sh
rigup init --agents codex --sdd none --tools openwiki,codegraph --review --json
```

- 项目安装的 CodeGraph 在隔离暂存区建索引，核验后提升到项目。软件与初始化分别留回执。已有索引会保留。复用 PATH 安装时，先运行 `codegraph status`，缺少索引时再运行 `codegraph init`。所有平台沿用上游 daemon 策略，最后一个客户端断开后通常保留约五分钟。移动或重装工具目录前，显式停止该项目的 daemon，或等待它自然退出并核实进程已结束。
- OpenWiki 安装软件、登记 MCP 并提供交接。重载宿主后，在独立会话用 `openwiki_begin` 的 `mode=init` 开始规划和逐页生成。已有运行按 OpenWiki 的进度恢复，完整 wiki 生成单独计时和计费。

## 工程检查和退出码

`rigup doctor --check-host claude --json` 会从项目目录运行 Claude Code 的原生 MCP 健康查询。查询可能启动已批准的 MCP 服务，包括访问配置的远程服务。Rigup 还通过同一项目启动器发送初始化握手，记录实际 `serverInfo.version`；项目级连接和版本都符合预期时，`claude:load` 才显示 `passed`。不会在此调用研究或模型工具。此结果对应本次探针。已有交互会话可在 `/mcp` 查看自己的连接状态。

初始化完成后，用 agent 打开项目，按原生工作流准备提案、审批和交付。项目参考列出已有命令、工作目录和对应的项目文件。任务直接记录这些信息。例如在 Hexagon 根目录运行 `npm run deps:validate`，从原生命令输出定位违规文件，修复后重跑同一命令。

行为变更使用原生规格的场景和审批。任务记录实际命令与结果，并可链接项目测试报告或 CI 作业。数据库访问需要获准终端时，带上工作目录和已有准备条件。回到交付后读取项目测试报告，或记录退出状态和脱敏摘要。共享测试库检查按顺序运行。

`quality.preCommit` 和 `quality.prePush` 核对已有且启用的项目 hook。项目自己的 hook 决定检查输入和执行方式。GitLab 作业运行选中的项目命令，`reportPaths` 接受精确路径或 `reports/junit/**/*.xml` 这样的仓库相对模式。将 JUnit 报告放在专用目录，避免匹配到覆盖率 XML。需要专用数据库或进程的检查使用项目已有的 CI 作业。 [GitLab JUnit 报告](https://docs.gitlab.com/ci/testing/unit_test_reports/)

升级旧安装时，预览会列出待退役的旧启动包装器和检查脚本。旧 hook 由 Rigup 生成时，先把项目自有 hook 配置到项目自己的路径，再按预览的 `--retire` 提示处理旧的受管文件。已有验证记录仍可查阅。

`rigup doctor` 用于可选的安装诊断。显式选择已有命令才会执行，例如 `rigup doctor --run-checks test --json`。

退出码 `0` 表示当前阶段完成，`1` 为失败或冲突，`2` 为参数问题，`3` 为待办或交接，`130` 为取消。结合 `phase`、`installStatus`、`pending`、`conflicts` 和 `nextCommand` 判断下一步。
