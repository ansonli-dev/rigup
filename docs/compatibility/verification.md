# Rigup 实现与真实验收记录

更新：2026-11-04。依据 [上游核验标准](README.md)、[实施计划](../superpowers/plans/2026-11-02-rigup-implementation.md) 和 [文档生成标准](../superpowers/specs/2026-11-03-documentation-system-design.md)。所有状态绑定下列精确对象；协议解析、组件冒烟、真实模型和完整兼容分别留证。

## 四个独立结论

- **实现与本地检查：本地通过，整体评审待完成。** Tasks 1–8 已提交；Task 9 已实现 onboarding、连续执行/review/JSON、进度、host 往返、打包和验收入口。最近一次本地测试 243 项，233 通过、10 跳过、0 失败；真实 npm bin 符号链接入口随后补回归修复。typecheck/build/pack dry-run 通过。最终全套检查、打包清单和一次 fresh-context 分支评审完成后更新此结论。
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
