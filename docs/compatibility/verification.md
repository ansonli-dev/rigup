# Rigup 实现与真实验收记录

更新：2026-11-04。依据 [上游核验标准](README.md)、[实施计划](../superpowers/plans/2026-11-02-rigup-implementation.md) 和 [文档生成标准](../superpowers/specs/2026-11-03-documentation-system-design.md)。所有状态绑定下列精确对象；协议解析、组件冒烟、真实模型和完整兼容分别留证。

最新范围调整：按用户要求，OpenWiki 初始化已从脚手架移出，改为安装/接线后给出独立初始化指引；CodeGraph 保留受保护索引与恢复。下文较早的双工具自动初始化记录是历史证据，当前行为及最新 291 项通过结果见文末「OpenWiki 独立初始化交接」。

## 四个独立结论

- **实现与本地检查：passed（实现及本地验证）。** Tasks 1–9 已完成本地交付。一位 gpt-6-astra 审查者以独立上下文检查全分支，发现 8 项 Important，无 Critical/Minor；同一修复轮已补失败回归并修复。本地完整测试 261 项，250 通过、11 跳过、0 失败，typecheck 通过；原生冒烟复验为 4 通过、7 跳过；build/pack dry-run 通过，61 个包文件不含缓存/测试/客户数据。正式产品完整验收仍见另外三个结论。
- **真实动态生成：pending。** host/service 已完成真实模型 analyze → plan → content → acceptance → 独立 apply、无变化复用、新反例 update 和本地修改保护；14 个唯一 Evidence 与实际过滤后源码逐项相符。仍须分开评估语义质量及覆盖范围。host/monorepo 也已完成真实双产物生成、更新和来源抽核；两个 native 场景缺 Anthropic API key/模型授权。一个成功案例不代表全部真实生成已通过。
- **真实宿主与工具兼容：pending。** Codex、OpenCode 的无 SDD 原生 skill 发现和客户 MCP 已通过限定场景。Claude、OMP、12 个 SDD 组合、两工具各宿主连接、原生初始化恢复和真实 GitLab 行为分别记录缺口。
- **首版完整验收：pending。** 完整组合、真实工具/框架 gates、独立模型生成、语义抽核和重要评审问题都满足后才能完成。缺环境、失败或未测均不得改成 mock 通过。

项目自身环境、软件测试、Agent eval 是 InstallReport 的其他结果。安装接线成功不等于这些检查通过，也不替代本产品验收。

## 可复现入口和记录边界

环境：macOS/arm64，Node 24.15.0、npm 11.12.1。上游精确来源与完整性固定于 [upstream-lock.json](upstream-lock.json)。真实验收使用无客户秘密的固定 [单服务](../../test/fixtures/live/service) 和 [monorepo](../../test/fixtures/live/monorepo)，[预标注](../../test/fixtures/live/annotations.json) 位于被研究项目之外。

本地入口为 `npm test`、`npm run typecheck`、`npm run build`、`npm pack --dry-run`。普通测试的 SDK transport 和协议替身仅证明本地契约。真实入口为 `npm run test:live`；单独真实生成命令为 `RIGUP_LIVE=1 RIGUP_OPENSPEC_BIN=<official-1.16.0-bin> RIGUP_LIVE_PROJECTS=service|monorepo RIGUP_LIVE_HOST_MODEL=gpt-6.1-sol node --import tsx --test test/live-generation.test.ts`。native 另需 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`；不会复制或编造密钥。

host 使用真实 `codex exec --ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only --model gpt-6.1-sol --json --output-last-message <private-output> -C <empty-model-root> -`。只提供 Rigup 过滤的证据，禁止自行读其他文件、执行命令或写项目；每次返回原样 JSON，不合成“修复响应”。实际请求的模型 ID 已记录，CLI 没有暴露服务端最终模型修订，不能声称已核实最终修订。provider 修订、可见 token、时间及意外命令计数在各阶段报告中独立记录。

每轮配置最多 12 请求；首次试验观察上限为 300000 token。多产物及修复试验在开始前使用 `RIGUP_LIVE_MAX_TOKENS=500000`，不超过 500000。恢复保留同轮既有失败请求与实际用量，不因进程续跑清零。新 fixture/新预算的试验与历史失败分开留证。host 产品报告自身仍将无法证明的模型用量标为 unknown，验收驱动额外观察真实 CLI 用量。原始会话及请求位于隔离临时 control 目录，不随包发布；共享证据仅涉及这些固定 fixture。

## 真实动态生成逐项状态

- `generation/host/service`：**执行 passed；正式语义验收 pending。** [完整结果](evidence/2026-11-04-live/generation-host-service.json)，[来源抽核](evidence/2026-11-04-live/generation-host-service-source-audit.json)。首轮 prompt 3，更新 prompt 4，template 1/read policy 3/document policy 1，OpenSpec 1.16.0，fixture commit、路径、时间与每次实际用量见结果。初始轮 210677 token；含失败及修复的更新轮 371574 token。create/cancel 的抛错和 reconcile 返回值与源码一致；新增 amend 的同角色反例阻止泛化；原 testing.md 不变，原生工作流保持引用且不接管。抽核执行者为实现 agent，不能冒充用户或人工批准。初始模型对独立支持采取保守 local-pattern，未完全识别可成立的 convention；初稿原生流程摘要偏长，后续版本已缩短。这些质量限制保留。
- `generation/host/monorepo`：**执行 passed；正式语义验收 pending。** [完整结果](evidence/2026-11-04-live/generation-host-monorepo.json)、[来源抽核](evidence/2026-11-04-live/generation-host-monorepo-source-audit.json)。prompt 4/template 1/read policy 3/document policy 1，OpenSpec 1.16.0。第一轮 318696 token、更新轮 216952 token，各在预设 500000 上限内；14 个唯一 Evidence 与实际源码一致。API/worker 生成两个不同职责产物；create/close 初始 convention 限于所查 API 操作，worker 三次 retry 仅为 local-pattern；新增 get 的 body.message 反例后 API 结论降级。原测试 cwd 权威未重写；两次独立 apply、无变化复用和用户说明保护均完成。抽核执行者为实现 agent，未声称人工批准。第一次规划在实现协议变化后被正确拒绝；300000 token 试验因双产物需要更多调用而停止，原证据保留。
- `generation/native/service`：**pending。** 缺 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_MODEL`，未发真实独立模型请求；[前置记录](evidence/2026-11-04-live/generation-native-service.json)。
- `generation/native/monorepo`：**pending。** 同样缺真实独立模型配置；[前置记录](evidence/2026-11-04-live/generation-native-monorepo.json)。

历史失败均保留：service [预算耗尽](evidence/2026-11-04-live/generation-host-service-attempt1-budget-failed.json)、[安装后缓存失效](evidence/2026-11-04-live/generation-host-service-attempt2-cache-failed.json)、[gap 协议字段缺失](evidence/2026-11-04-live/generation-host-service-attempt3-guidance-failed.json)、[旧正文不可审阅导致 pending](evidence/2026-11-04-live/generation-host-service-attempt4-plan-failed.json)；monorepo [上下文变化](evidence/2026-11-04-live/generation-host-monorepo-attempt1-context-changed.json)、[预算停止](evidence/2026-11-04-live/generation-host-monorepo-attempt2-budget-exhausted.json)。相应产品缺口已用失败回归修复：托管输出先投影再过滤，partial observation 明确 gap 属性，旧产物的过滤可信基线仅作比较上下文。它们不会变成新的源码规范。

## 无 SDD 的四宿主场景

- `codex/none`：**passed，限原生发现和客户 MCP。** Codex 0.166.0 app-server 实际 skills/list、thread/start、mcpServerStatus/list、mcpServer/tool/call；发现 .agents skill，完成 initialize/list 并调用 echo。[证据](evidence/2026-11-04-live/codex-none-customer-mcp.json)。未由此推断模型遵守 SDD gates。
- `opencode/none`：**passed，限原生发现和客户 MCP。** OpenCode 1.18.5 的 `debug skill`、`mcp list` 实际发现 .opencode skill，服务器观察到 initialize、tools/list。[证据](evidence/2026-11-04-live/opencode-none-customer-mcp.json)。未声称模型已消费引用或工具调用已完成。
- `claude/none`：**pending。** Claude Code 2.1.273，auth status 显示 loggedIn=true，但实际 headless 模型请求返回 401（api_error）；已有认证尚未证明可发模型请求。实际探针连接了客户 MCP，未证实 skill/引用发现或 echo 调用。早先 restricted 探针的 Unknown command 也保留在 [历史记录](evidence/2026-11-04-live/claude-restricted-discovery-pending.json)。需有效会话/API 权限及原生发现条件，不能由 auth status 推断请求可用或发现成功。[实际记录](evidence/2026-11-04-live/claude-none-customer-mcp.json)。
- `omp/none`：**pending。** OMP 18.1.13 的隔离 HOME 未配置可用模型，原生 RPC 启动失败/超时。需隔离配置中的真实可用模型与相应授权，未复制用户凭据或设置假 key。[实际记录](evidence/2026-11-04-live/omp-none-customer-mcp.json)。这不证明用户全局账户没有授权。

## 四宿主 × 三 SDD 组合

以下 12 项均 **pending**，各项独立：

- `claude/superpowers`：Claude 2.1.273 / Superpowers 7.0.1；需原生入口发现、包装流程及不可取消 gates 的实际会话。
- `claude/openspec`：Claude 2.1.273 / OpenSpec 1.16.0；同上，尚无真实行为证据。
- `claude/spec-kit`：Claude 2.1.273 / Spec Kit e0d414929552a4084d918babfd70d859f129eb13；同上。
- `codex/superpowers`：Codex 0.166.0 / Superpowers 7.0.1；需原生框架/固定 skills 与客户 references 的实际 gate 压力场景。
- `codex/openspec`：Codex 0.166.0 / OpenSpec 1.16.0；官方 init、真实 setup 研究/独立 apply 已运行；另一个真实只读压力场景已读取固定 delivery skill、project references、客户 review marker 和原生 apply skill，拒绝在缺批准/原生产物时实现或捏造检查通过，见 [gate 证据](evidence/2026-11-04-live/codex-openspec-customer-reference-gate.json)。该场景 passed，但 prepare、实施后验证/评审、其他 gate 及完整组合仍 pending。
- `codex/spec-kit`：Codex 0.166.0 / 锁定 Spec Kit commit；需实际 `speckit-*` 加载与 gates 场景。
- `opencode/superpowers`：OpenCode 1.18.5 / Superpowers 7.0.1；普通 canary 发现不能替代框架与 gates。
- `opencode/openspec`：OpenCode 1.18.5 / OpenSpec 1.16.0；缺完整框架原生会话证据。
- `opencode/spec-kit`：OpenCode 1.18.5 / 锁定 Spec Kit commit；缺完整框架原生会话证据。
- `omp/superpowers`：OMP 18.1.13 / Superpowers 7.0.1；上游 Pi 支持不足以证明 OMP，绑定保持 pending；还需真实 OMP 模型会话。
- `omp/openspec`：OMP 18.1.13 / OpenSpec 1.16.0；需可用 OMP 模型和实际框架/gates 会话。
- `omp/spec-kit`：OMP 18.1.13 / 锁定 Spec Kit commit；需可用 OMP 模型和实际框架/gates 会话。

pending 表示缺条件或未验证；尚无足够已核实限制将这些场景标成 unsupported。不得以缩小首版范围宣布完整验收。

## 工具、独立运行和外部条件

- OpenWiki 0.7.3：官方 scoped 安装、完整性、直接 stdio initialize/tools/list 的组件记录 [见历史证据](evidence/2026-11-03-openwiki-stdio-startup.json)。`openwiki/mcp/claude`、`openwiki/mcp/codex`、`openwiki/mcp/opencode`、`openwiki/mcp/omp` 各为 **pending**，组件的 host 标识不能替代原生宿主加载。初始化、失败恢复、模型研究、GitLab 更新与防自触发真实 job 仍 pending；需保护范围、真实模型和 GitLab 环境。
- CodeGraph 1.6.2：指定仓库和发行包完整性已核实。[历史安装证据](evidence/2026-11-03-codegraph-project-install.json)。本轮官方原生 init/query/sync/query **passed**，能查询初始 createOrder 及源码变化后的 lookupOrder，见 [真实索引/查询](evidence/2026-11-04-live/codegraph-index-query.json)；仅说明原生 CLI，未宣称 Rigup 自动初始化已通过；`codegraph/mcp/claude`、`codegraph/mcp/codex`、`codegraph/mcp/opencode`、`codegraph/mcp/omp` 各为 **pending**，尚未由真实原生客户端证明其 MCP 加载。自动原生初始化仍须补齐写入保护和恢复；watcher 不可用时 init --yes 可能写 Git hooks，不能作为受保护安装操作直接放行。
- `installed-assets/independent/codex`：**passed，限声明场景。** 真实 npm pack → 临时消费目录安装 → packaged CLI setup → 删除消费目录整个 node_modules → standalone pre-commit 快照检查/MCP runner echo → Codex 原生发现及 MCP 调用。[完整证据](evidence/2026-11-04-live/packaged-independent-assets-codex.json)。不推广到其他宿主或尚未验证的真实工具依赖。
- GitLab CI lint/真实 runner、OpenWiki CI 更新：**pending**，缺目标 GitLab host/project/token 与 runner/model 条件。[缺口记录](evidence/2026-11-03-gitlab-ci-lint.md)。本地真实快照测试验证 index、多个推送 commit、失败退出码/报告保存、防循环接线，不能冒充服务端 CI lint。
- `change-release`：**pending**，未验证真实部署适配器、目标授权及恢复。仅声明 deploy 命令或客户 skill 不会生成虚假 release 能力。

## 本地实现覆盖与历史边界

本地测试覆盖：集中 onboarding/返回/取消/隐藏 key；语义任务才要求模型；host analyze/plan/content/acceptance 跨进程上下文及累计预算；用户改删和缺损基线的三方保护；旧库存去向、明确退役、重命名和导航最终接线；预览后变动拒绝；写前 fsync/启动屏障；SIGINT/SIGKILL、未知写进程与普通缓存丢失恢复；manifest 最后切换；快照 checks 不借未提交修复；安装状态与客户测试/eval 分离；无 CLI 运行。它们是可重复的实现证据。

2026-11-03 的 [101 项本地契约日志](evidence/2026-11-03-local-contracts.txt)、[版本探测](evidence/2026-11-03-installed-version-probes.json)、[OpenWiki 非 TTY help 失败](evidence/2026-11-03-openwiki-help-non-tty-error.txt)、[OMP 独立 read 失败](evidence/2026-11-03-omp-skill-discovery.txt) 与 [目录解析组件](evidence/2026-11-03-omp-skill-parser.txt) 保留。历史失败不被新结果删除；组件/静态结果不能推广成真实完整兼容。

## 最终代码审查与回归（2026-11-04）

审查范围为 0214ffd..d4cc499，审查者 gpt-6-astra，独立上下文、只读；仅一次审查。8 项 Important 全部进入同一修复轮，没有 deferred minor。结果与执行裁决见 [最终审查数据](evidence/2026-11-04-live/final-review-results.json)。

- 凭据：read policy 提升为 **4**。普通 YAML/JSON/TOML 的 environment/认证列表、credentials/auth 字段及已知命令认证参数受过滤；PRIVATE-TOKEN、短 user 参数和 OAuth bearer 明文参数在有效设置/导出前被拒绝。真实 host 导出的字节也在回归中断言无 fixture 凭据。
- 快照：从指定 Git tree 直接批量读取 blobs 并恢复文件模式，禁用 replace objects，不经过 archive 属性转换。export-ignore 和 export-subst 的真实 Git 回归不再能掩盖暂存坏文件。
- review/apply：检查种类与具体变更保存在不可变预览和最终 handoff JSON；独立 apply 恢复执行已选 test，实际失败仍保存成功接线并退出 1。
- 原生来源：Superpowers 支持真实的未加前缀名称及宿主插件原生名称。读取可核实的用户/启用插件元数据；依赖不足、来源冲突、未知或不匹配版本保持 pending。客户 skill 资源需证明等效，用户范围 native skill 通过原生调用引用，不建立越界文件链接。全局来源变化也会阻止中断预览续写。多版本缓存无法证明哪个生效时不按目录新旧猜测。
- 模型身份：运行时解析的非秘密 provider/model/key-reference 单独进入请求、run 同意范围及研究/生成缓存；切换模型使旧上下文失效，不把环境选择永久当成下一轮显式项目设置。
- 基线：已知托管目标在 baseline 缺失/不符时仍被隔离；语义读取/缓存复用在对账前停止，不将旧生成正文重新送模型。
- 软件复用：与操作对账共用实际安装查询，检查锁摘要、固定包/版本/完整性、依赖 manifest、launcher 和可执行文件；预览到 apply 之间、恢复及检查后的实际状态同样核验；损坏的既有范围只报告待对账，不重装覆盖。

旧真实生成和 gate 证据明确绑定其 read policy 3/template 1/prompt 3 或 4。上述确定性边界修复使用本地回归复验，并未伪造为 read policy 4 下的新模型语义通过。两后端全部正式语义/人工验收仍为 pending。

## 受保护原生初始化与恢复（2026-11-04 补齐）

本节更新前文的初始化/MCP 待办；原历史证据保留。[完整实测](evidence/2026-11-04-native-initialization/initialization-recovery.json)、[官方源码与发布包边界](evidence/2026-11-04-native-initialization/source-boundaries.json)。OpenWiki 0.7.3、CodeGraph 1.6.2、Codex CLI 0.166.0，Node 24.15.0，darwin-arm64。

- 软件安装、宿主注册、项目初始化分别留证。CLI `--tools openwiki,codegraph` 默认选择 Codex，并规划两个固定安装和两个初始化操作；交互式项目安装也包含受保护初始化。
- CodeGraph 官方 SDK 只向新暂存目录写入，完整索引通过 native index_state、版本和只读 SQLite 完整性检查后再原子提升；不调用可能安装 Git hooks 的 `init --yes`。原生查询实际找到 createOrder 及 src/order.js。
- OpenWiki 官方生命周期在隔离暂存仓库创建原生规划 run，只有 openwiki 状态目录被提升；不改写项目 AGENTS/CLAUDE 或创建计划任务。此时是已初始化且可恢复的规划阶段，不能声称全部 wiki 页面已生成完成。Codex 随后通过真正的 OpenWiki MCP begin 在实际项目恢复相同 runId，源码差异由上游重新规划。
- 初始化成功后、控制器保存终态前模拟中断；删除普通缓存后 `--resume` 从独立持久日志恢复已批准预览，核验实际状态并完成后续操作，软件和初始化回执分别提交。真实 CodeGraph 写入数据库后终止进程，确认所有写进程退出，再仅重建未发布暂存区，80 文件/160 节点索引恢复成功。
- 保留已有用户 wiki、索引、根指令、工作流和 Git hooks；不隐式认领既有非空状态。拒绝符号链接、失效预览、替换的执行/查询命令及依赖缺失/乱序。带有效目录身份和提升凭据的原生输出不回流语义研究；凭据损坏时隔离已知生成范围并停止语义复用。
- doctor 只读核验原生初始化，unchanged update 不重装、不重新初始化。真实 Codex app-server 加载两个 MCP，调用 CodeGraph 原生主入口 explore 并恢复 OpenWiki。此组连接验收 modelCalls=0，没有模型选择或切换。

Claude 及其他宿主、其他平台、独立模型矩阵按用户要求延后。OpenWiki 正文生成的语义质量、GitLab/部署等需要外部目标或凭据的场景不由本组证据推定通过。

## 默认本机 Codex 研究主线（2026-11-04）

新增 `backend: codex`，并作为 fresh setup 的默认研究后端；agent 默认为 Codex。显式 `host` 文件交换和 Anthropic `native` 保留；仅有既存 Anthropic model 配置而未写 backend 的项目继续使用 native，不被默认值更换提供方。

[最新真实结果](evidence/2026-11-04-native-initialization/codex-mainline.json)：Codex CLI 0.166.0、官方 OpenSpec 1.16.0、当前默认模型，无 `--model` 覆盖。研究/规划实际 2 次请求，分别 48378 和 53192 token，合计 101570，在 fixture 开始前明确的 8 请求/300000 token 预算内。固定 workflows/references 与根入口共写入 5 项；下一次 update 写入 0 项、预算日志逐字不变，没有新模型调用；原 README 和业务源码保持原样。这是执行/接线验收，不替代正式语义或人工批准。实际模型 ID 未由 CLI 暴露，结果明确标为 default/unknown，不推断成指定模型已通过。

- 只把既有 RepositoryReader/host 协议过滤后的证据交给 Codex，在项目外新建空私有 cwd；忽略用户配置并禁用 shell、浏览器、应用、图像读取、子 agent、宿主 skill 发现等入口。接收的 JSON 必须继续通过真实 Evidence 校验，观察到工具活动就拒绝，原始错误/模型文本不进入用户错误信息。
- 输入发送前持久保留未知用量和进程身份；完成后从真实 turn.completed 记录 input+output token（缓存输入不重复加计），已接收结果复用消费 0 新调用。预算与未决尝试保存到独立 state/codex；普通缓存删除、日志损坏或遗失均不能把已知消费静默归零或自动重发未决请求。
- CLI 未暴露服务器端总输入/推理 token 硬封顶接口；本后端按每次实际返回用量检查，单次调用可能先超出上限，超额结果被拒绝且用量保留。调用次数及项目读取范围仍有独立边界；现有 Anthropic native 的发送前 token 检查单独保留。
- [首次启动提示误判记录](evidence/2026-11-04-native-initialization/codex-mainline-attempt1-startup-warning.json) 保留。其错误项是 skip_host_skill_discovery 的原生启动提示，未发生工具调用；精确分类回归后复用了当时已保存的真实结果，没有重发该请求。其他错误和工具事件继续拒绝。进程身份记录失败时的真实子进程清理也有失败到通过回归。

本轮没有运行 Claude/其他宿主或模型切换矩阵；GitLab/部署等外部目标仍保留原待办。本地 Codex 后端入口和参数以 [官方 App Server/CLI 文档](https://learn.chatgpt.com/docs/app-server) 及本机精确版本的 `exec --help`/`features list` 核实。

## 原生初始化补齐后的最终审查与回归

一次独立上下文、只读的 gpt-6-astra 审查覆盖分支 0214ffd..7c4db91，并重点检查 1ffacb2..7c4db91 的新增主线。4 项 Important 全部接受并在同一修复轮完成；无 Critical、无 deferred minor，未追加复审。[审查、裁决与校验摘要](evidence/2026-11-04-native-initialization/final-review-results.json) 保留每项影响、回归入口和本轮完整裁决。

- 缓存删除恢复：生命周期 run 身份、累计读取/模型预算及 Codex 已返回结果改为独立持久状态；同一未知调用不会因普通缓存删除而重发，已完成结果恢复消费 0 新请求。权威预算可纠正调用方尚未更新的 unknown 用量，损坏的持久 run 明确阻止续跑。
- 提供方选择：CLI 显式 Anthropic model/API-key 引用进入 native 后端；与显式 Codex 选择冲突时研究前拒绝。配置层的优先级同样处理，避免选择被默认值静默忽略。
- 活动会话：默认 Codex 和持久 apply 恢复共用受影响宿主会话交接，保留同一具体预览，声明会话结束前不写配置。
- 未提交原生状态：写原生产物前保存 intent；manifest 提交前即隔离已知生成区。中断后源码改变仍安全拒绝旧预览，并阻止这些产物成为新研究依据。没有 Rigup 意图/提升记录的同名用户目录仍正常可读。

四项发现的 7 个回归先全部失败，再全部通过；另外验证了已完成结果跨缓存恢复和权威预算恢复。最终 `npm test` 为 **298 项：285 passed、13 skipped、0 failed**；13 项跳过为需显式启用的真实验收入口，不计作通过。`npm run typecheck`、构建（pack 的 prepack）及 `npm pack --dry-run --json` 均通过；发布清单 67 文件，包含原生 worker、Codex 后端和会话交接模块，无测试、缓存、scratch 或客户数据。完整 [测试日志](evidence/2026-11-04-native-initialization/final-tests.txt)、[失败回归](evidence/2026-11-04-native-initialization/review-regressions-red.txt)、[通过回归](evidence/2026-11-04-native-initialization/review-regressions-green.txt) 已归档。

真实原生安装/中断恢复/Codex MCP 验收在 intent/隔离修复后再次通过，见最新 initialization-recovery.json。默认 Codex 真实模型验收沿用上节已记录的 2 请求结果；最终防护修复使用本地进程/协议回归，没有新增模型调用，也未宣称替代全部组合、对抗性模型评测或人工语义批准。源码变化后的中断安装仍可能需要手工回执对账；后续 wiki/index 更新继续由原生工具承担。

## OpenWiki 独立初始化交接（2026-11-04 范围收窄）

OpenWiki 的长流程不再属于脚手架初始化。CLI 和 onboarding 选择工具时仅安排 OpenWiki 软件安装与 MCP 接线；即使旧配置写有 `initialize: true`，新计划也不产生 OpenWiki 初始化操作，不创建规划 run，不等待 wiki 正文完成。预览、成功安装/无变化更新报告和 doctor 给出独立任务指引：重载当前项目的 coding agent，要求它通过 `openwiki_begin(mode=init)` 进入 OpenWiki 原生规划/页面流程，中断后恢复原生进度。指引不是阻塞安装的 requirement，未生成 wiki 的 setup 仍可完成。

旧 OpenWiki 受保护回执继续只读核验，已接受但未保存终态的操作允许对账；旧的未完成操作不再派发新的 OpenWiki 初始化写入。已有 wiki、未决范围隔离和所有用户草稿均保留。CodeGraph 的官方 SDK 暂存、只读完整性检查、原子提升与中断恢复保持有效。

[最新真实验收](evidence/2026-11-04-openwiki-handoff/initialization-recovery.json)：官方 OpenWiki 0.7.3、CodeGraph 1.6.2、Codex 0.166.0；真实预览只有 `install:openwiki`、`install:codegraph`、`initialize:codegraph` 三个操作。初始化成功后中断并删除普通缓存，恢复后软件回执包含两工具、初始化回执仅有 CodeGraph；此时项目没有 `openwiki/` 或 `.rigup/native/openwiki/`。真实 CodeGraph 半写数据库后的取消/重建、源码查询、根指令/工作流/hooks 保护均通过。

脚手架完成后另开明确的 Codex 原生 MCP 会话，才调用 OpenWiki begin；再次 begin 恢复相同 runId，且不新增 Rigup 的 OpenWiki 所有权回执。此处仅验证独立规划入口和恢复，不生成 wiki 正文；整组验收 **modelCalls=0**，没有新增模型测试或外部模型凭据。

本轮范围回归先观察到 6 项预期失败，再全部通过；补充旧已接受回执的只读对账测试。最终本地 `npm test`：**304 项，291 passed、13 opt-in live skipped、0 failed**。类型检查、构建和 pack dry-run 结果与边界决策见 [范围调整记录](evidence/2026-11-04-openwiki-handoff/scope-change.json)。历史自动初始化证据保留，不能用作当前默认流程声明。
