# 三方集成安装与原生工作流设计

基线是 Rigup 0.6.0 的 `2fddb1f`。目标用户在一个项目里选宿主、SDD 和可选工具。Rigup 先查已有安装，给出还需要的操作，将获批的工具安装与接线应用到项目。 [Issue #71](https://github.com/ansonli-dev/rigup/issues/71) · [Issue #72](https://github.com/ansonli-dev/rigup/issues/72) · [实施方案](../plans/2026-11-16-integration-setup.md)

## 用户流程

- 保留已有项目数据、工作流、接线和可核验的安装。OpenWiki、CodeGraph、OpenSpec 优先使用有可信回执的项目包，其次使用安全 PATH 上可用的 CLI。复用保持实际已安装版本，并说明来源。已存在的目录、回执或已登记的 CLI 有问题时，给修复动作。只在确实缺失时显示可用的安装范围，项目是首次默认。
- 可选工具的项目范围是 `.rigup/tools/<工具>/`，全局范围是当前用户 PATH 上可写的 npm 前缀。项目配置由每个仓库管理。向导只检查所选工具。已有 YAML/profile 的 `install` 继续表达项目包或 PATH。`--tools` 决定本次成员。已保存的同名工具沿用其 `install`、`initialize` 和仍选中的宿主，显式新选工具才走自动探测。非交互对新工具默认项目范围。普通 `update` 检查保存接线。已保存 PATH 工具缺失时给出 `rigup update <项目> --configure --tools <需保留的完整列表>`。这个交互入口可重新选择缺失工具的安装位置，保留显式初始化偏好及其余工具。一次性选择写回既有 YAML 使用 `--configure`。
- Superpowers 和 Spec Kit 按所选宿主解析已启用的入口。缺失动作采用宿主或上游支持的安装位置及命令。Claude 支持项目和用户安装。已登记但未加载、禁用、冲突和依赖不可用各有修复说明。Spec Kit 检查六个绑定入口、项目 constitution 与当前工作流引用的有效 `.specify` 脚本、模板及启用的无条件必需 hook 入口。动态条件沿用原生执行判断。保留上游 sh、ps、py 的选择及路径。相关文件单独计入安装来源验证，研究 inventory 继续屏蔽生成脚本和管理数据。缺入口时优先复用原生 `specify`，新项目执行 `specify init --here --integration <key>`，已初始化项目按当前版本的 `specify integration install <key>` 及 multi-install 条件。缺 CLI 时说明一次性 `uvx` 与用户级 `uv tool install` 两条官方路径。

## 实现取舍

- 可选工具走主预览与 apply。OpenSpec 沿用已存在的独立原生准备。
- 生产按有效配置和安装文件静态发现。隔离验收用宿主的技能列表/读取验证发现规则。

## 软件安装、接线与恢复

新安装以所选 registry 的稳定 `latest` 解析一次，预览显示实际写入位置、包名、版本、registry 和完整性。项目工具沿用现有 staging、保护和回执。全局选择作为私有运行参数及 `SetupPlan.operations` 中的已批准安装操作，沿用预览、报告、会话交接、继续签名及中断 apply。成功后以 `install:false` 保留 PATH 接线。全局写入范围和回执由全局安装共享逻辑维护，项目回执表示项目包。

共享全局 npm 安装沿用 OpenSpec 的用户前缀发现和批准数据，冻结包身份、canonical prefix、前缀及 npm 启动器身份。apply 始终先安装核验再写项目配置。按 canonical prefix 串行，保留 v0.6.0 的 `openspec:<prefix>` 锁身份，复用受保护 writer，持久化进程身份后执行，恢复前查清整个进程组或 Windows Job 已退出。发现遗留锁却没有可证明旧 writer 已退出的记录时，保留状态并给原版本/手工对账提示。核验固化 tarball，以过滤环境及 `--ignore-scripts` 安装。持久完成记录、准确 launcher 及包版本都匹配时才结算。每包回执按前缀和批准保存，残留和半成品指向原批准。每个操作成功后先持久记录和报告。后续安装失败、取消或接线失败时保留此前已完成项和原批准恢复动作。

用同一个安全 PATH 解析器服务探测、doctor 和现有项目根定位的 MCP launcher。排除相对目录、项目内路径和指回项目的链接或 junction。Windows 的 npm `.cmd` 解析已核验的 Node argv，真实 `.exe` 和 CodeGraph 官方独立包支持原生入口。宿主负责从自己的 PATH 启动可信 Node，launcher 的过滤从该 Node 启动后开始。doctor 在检查到候选 Node 来自项目或不可用时引导修正宿主 PATH。通过已安装的 CodeGraph 平台载荷直达 bundle 入口，兼容核验过的旧分发，避免 shim 下载。MCP 实际连接单独验证。

CodeGraph 软件和索引分开。仅在托管项目包和空索引范围下沿用保护式索引 worker。已有回执核验后复用，非空外部索引保留。PATH 方式使用原生 `codegraph status` 或 `codegraph init` 交接。OpenWiki 接通后沿用独立原生 wiki 初始化与恢复，保留 wiki 内容。 [CodeGraph 索引](https://github.com/colbymchenry/codegraph/blob/main/site/src/content/docs/guides/indexing.md) · [CodeGraph 平台分发](https://github.com/colbymchenry/codegraph/blob/main/BUNDLING.md) · [Windows 安装](https://github.com/colbymchenry/codegraph/blob/main/install.ps1)

## OpenSpec 独立准备

复用已安装 CLI 时沿用版本，仅审批需要补齐的原生项目文件。缺 CLI 时项目范围使用现有项目 npm 运行时及 staging，使便携版可使用随附 Node/npm。全局范围要求用户 Node/npm 和可写的 PATH 前缀。一个范围不可用时可用另一个。独立审批涵盖软件目录、`/tools/` 管理块和所需原生文件。写入前先保留用户 ignore 并合并管理块，核验 staging 与最终目录被有效忽略且无已跟踪后代。规则反向匹配时保留现场、提示具体路径。发布前复核。在写入前保存 OpenSpec 独立准备的私有批准、CLI/包身份、原生范围和阶段。恢复先读取此记录，再探测及执行。普通准备发现未完成批准时指向原 `--resume`，包括已出现临时 launcher 的情况。兼容直接调用旧 `--prepare-openspec` 时的全局默认，新流程所有生成命令都写明 `--install-scope project|global`。TTY 内的主预览和独立准备已完成的写入各自报告。

项目 CLI 入口 `rigup openspec <args>` 使用 Rigup Node 运行时执行经核验的项目 CLI。从当前项目根运行，保留原生 argv（包括 `--json`、`--verbose`、`--`）、IO 和退出码。此分派位于 Rigup 参数解析前。项目宿主指令和三份工作流引用注明该调用方式，覆盖直接使用原生入口时的命令。所选 CLI、原生项目根与宿主入口共同决定就绪。共享检查覆盖 init、update、MCP 研究、应用与恢复。独立准备是写入入口。已批准 CLI 或项目根变化要求重新准备和审阅。原生生成内容、已有批准及项目所有权继续适用。 [OpenSpec 安装](https://github.com/Fission-AI/OpenSpec/blob/main/docs/installation.md) · [提案入口](https://github.com/Fission-AI/OpenSpec/blob/v1.16.0/src/core/templates/workflows/propose.ts)

## 十二种原生绑定

| 宿主 | Superpowers | OpenSpec | Spec Kit |
| --- | --- | --- | --- |
| Claude | 启用插件的 `superpowers:*` 或有效本地名 | `openspec-*` | `speckit-*` |
| Codex | 生效 Marketplace 包或原生技能的实际名 | `openspec-*` | `speckit-*` |
| OpenCode | 官方插件注册的裸名或独立原生技能 | `openspec-*` | `speckit.*` 命令 |
| OMP | OMP 自身已加载来源的裸名，可用 `skill://` 加载 | `openspec-*` | `speckit.*` 命令 |

`bindSdd` 返回 `SddBinding` 或报告缺失入口。移除 `PendingBinding` 及其消费分支。多宿主仍共享一次审批和应用。来源冲突、必需入口缺失与项目文件冲突仍保护项目。明确禁用宿主技能或拒绝三个 Rigup 项目入口时，说明如何恢复。只列出入口不足以证明宿主可调用。registry 与向导依据相同的来源语义说明宿主、所缺入口和下一步。`change-prepare`、`change-ready`、`change-deliver` 及项目引用使用实际绑定。原生关卡和 Rigup 自己的 GOAL、当前版本与显式实施批准均保留。兼容性矩阵记录事实。当前 release 的审批和恢复保留原权限及快照。旧 release 的未开始预览重新生成，有持久写入的旧审批通过原 Rigup 版本完成或照现有提示对账。

- Claude 按用户、项目和本机项目 settings 合并，识别与 canonical 项目匹配的 `project` 和 `local`，以及当前启用的 `user` 插件。按实际调用名区分命名空间与裸名，按宿主规则处理 personal/project 同名。原生入口明确 `disable-model-invocation` 时给修复动作。Codex 沿用启用配置及宿主命名，按宿主活跃版本规则先选 `local` 或最高版本，再验证 manifest 和技能。旧版本齐全不能替代有问题的当前目录。 [Codex 活跃插件版本](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core-plugin-common/src/installed.rs)
- OpenCode 按版本的有效配置顺序读取 XDG 与环境覆盖。V1 在既有配置后加 `OPENCODE_CONFIG_DIR`，V2 使用它替代默认用户目录。各自在原生顺序处理显式配置、项目配置、inline 和受管理策略。匹配 `OPENCODE_DISABLE_PROJECT_CONFIG` 与宿主的真实值规则。V1 `plugin` 官方 git 包按上游 `packages/<spec>/node_modules/superpowers` 查找，包括 Windows cache key。V2 先按插件 ID 处理 `plugins` 有序选择，验证 `integration.use` 允许加载，再核验 `npm/git-superpowers-<spec 哈希前 12 位>/<最新数字 generation>/node_modules/superpowers`。兼容明确加载的上游本地入口。验证当前有效安装、入口和包内技能。V1 按 frontmatter 调用，V2 按路径 ID，包含根目录平铺技能、兼容 `.claude/skills` 和 `.agents/skills` 以及有效自定义根。根据生效的宿主版本/布局、禁用和技能权限解析。常见两版共用路径可复用。实际命中来源、ID 或启用状态不明确时给配置修复提示。对 Spec Kit 命令核对生效的载体和来源，包括同 ID 的 inline 命令遮蔽。仅有声明或旧缓存时说明加载或修复操作。 [OpenCode 技能 ID 与优先级](https://opencode.ai/docs/skills/#ids)
- OMP 按自身项目和用户范围发现 `package.json`、`omp-plugins.lock.json`、`node_modules` 中已启用的 npm/link 插件和 Claude 兼容 Marketplace。OMP 用户 Marketplace 依 ID 覆盖 Claude 用户记录，项目 Marketplace 记录按宿主优先。用户 Marketplace 的显式禁用在覆盖后生效。项目 Marketplace 禁用项不会覆盖较低层记录。缺 `enabled` 沿用宿主默认。npm/link 项目包按包名优先。Claude 用户记录受 OMP Claude provider 控制，当前项目记录与 OMP 自有记录按其原生例外。最后应用宿主技能过滤。`skills.enabled` 决定技能加载，包括三个 Rigup 项目技能。`enableSkillCommands` 控制 slash 投影，Spec Kit 文件命令及技能读取可继续使用。`@loneexile/omp-superpowers` 的四个必需入口统一来自该包时，使用其 `docs/specs`、`docs/plans` 与审批约定，保留 Rigup 关卡。两套不一致的来源报告冲突。
- Spec Kit 先用固定上游版本实跑 `specify init` 验证命名与六个入口。OpenCode 的 `.opencode/command/` 和 `.opencode/commands/` 共用现有宿主命令目录规则，供扫描、向导和研究过滤。OpenSpec 独立准备继续按生成器实际输出约束写入。
- 生效的包根要符合 scope，项目提供的链接及插件入口、manifest、技能 realpath 受该根约束。用户显式外链按原生宿主规则。各来源使用现有预算。快照基于生效来源的 canonical 路径和修订、manifest/入口摘要及技能正文摘要。只哈希选中的来源及影响它的有效配置，普通 MCP 写入无关配置时保持快照。仅同一可调用名存在有效来源冲突时给诊断。普通项目研究接口不读取 `.omp/plugins/` 等原始管理记录。宿主的实际入口由独立无模型探针逐对验证。

[Superpowers 安装](https://github.com/obra/superpowers/blob/v7.0.2/README.md#installation) · [Claude 安装范围](https://code.claude.com/docs/en/discover-plugins#choose-an-install-scope) · [OpenCode 插件](https://github.com/obra/superpowers/blob/v7.0.2/.opencode/INSTALL.md) · [OMP Marketplace](https://github.com/can1357/oh-my-pi/blob/v18.19.0/docs/marketplace.md) · [Spec Kit 集成命令](https://github.github.com/spec-kit/integrations/cli.html)

## 验收

- OpenWiki 与 CodeGraph 各测已有项目包、已有 PATH、缺失装项目、缺失装全局。检查交互、非交互、重配和选项回退。全局安装后第二个项目直接复用。验证正常 MCP 初始化、接线与现有 wiki/索引的保留。
- 覆盖报告、保存和独立 apply、取消、scope 生命周期和原审批继续。检验 retag、相同版本的不同 tarball、前缀或 npm/registry 变化、两工具同时选全局、跨项目残留 writer、旧预览、已存在索引、Windows shim 与独立版、路径有空格和子目录。
- OpenSpec 分开验证两种范围、只补缺失入口、主预览取消、原审批恢复、没有独立 Node/npm 的便携版以及全新宿主可用项目 CLI。
- 12 个 fixtures 同时覆盖绑定和三份工作流引用，12 组空入口均报缺失。`claude,omp` + `superpowers` 从实际扫描到预览、独立 apply 和后续更新。禁用或内容、身份替换使旧预览和中断恢复失效。
- 实机矩阵分开记录已加载技能、可调用来源、OMP slash 清单和 MCP 初始化。每格有版本化脱敏回执或 `not live-tested` 及原因。先完成完整回归、真实 CLI/包验证和修复复跑，再升级文档版本、检查 CI、合并、发布并关闭两条 Issue。
