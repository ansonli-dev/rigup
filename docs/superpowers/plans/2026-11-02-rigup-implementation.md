# Rigup 首版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 用户调用了该技能；其当前版本规定由当前会话逐任务实现，不逐任务派发实现者和评审者。这是技能的执行规则，不是用户另行表达的执行偏好。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付能为新旧项目分析、生成、安装和更新 rigup 的 CLI，安装后的研发 skills 独立运行。

**Architecture:** 保留 Analyzer、Generator、Installer、Integrations 四个模块。分析与生成沿用 OpenWiki 的研究/规划/逐项生成/接受/恢复方式，改换为规范复用、模式提炼及 harness 接入的研究问题和产物；不另建规范分析运行时。CLI 只编排；模型只研究与生成私有候选，确定性代码负责命令、宿主格式、更新保护与最终落盘。不建设常驻服务或研发状态引擎。

**Tech Stack:** TypeScript、Node.js 24 LTS、ESM；`node:test` + `tsx`；TypeScript 编译；Anthropic 官方 TypeScript SDK 作为首个独立模型后端；YAML、JSONC、TOML 使用现成解析库。具体依赖版本在实施时核验并写入 lockfile，不使用未经核实的模型名或上游命令。

**Spec:** [CLI 交互提案](../specs/2026-11-03-cli-interaction-design.md)（本轮已完成文档契约审阅，第 8 节已落实到对应任务；未实现）、[总架构](../specs/2026-11-02-rigup-design.md)、[四模块设计](../specs/scaffold-modules/01-project-analyzer.md)、[安装后的 skills](../specs/2026-11-02-installed-skills-design.md)。[文档体系与生成标准](../specs/2026-11-03-documentation-system-design.md)、[上游核验标准](../../compatibility/README.md)、[独立验收记录](../../compatibility/verification.md)与本计划共同执行。四模块设计的其余文件与[需求基线](../../requirements/2026-11-02-rigup-requirements.md)共同约束本计划。

## Global Constraints

- “脚手架只在 setup/update 时运行”；安装后的 skills、hooks、MCP、CI 不依赖本 CLI。
- “所选四种 agent、三种 SDD、OpenWiki/CodeGraph、自定义 skills 和反馈接线的需求不变。”
- “测试只连接已有命令”；不生成客户业务测试体系、测试环境、身份系统或组织政策。
- “混合配置只改拥有的键/标记块，保留其余字段与注释。”
- “manifest 最后原子写入”；不承诺跨文件/远端事务，不自动 reset，不盲重试结果未知的外部操作。
- 项目级安装优先，软件安装/初始化的版本、写入路径、副作用必须在预览中声明；普通 update 不隐式升级工具。
- 空项目不伪造 as-is；未知来源、版本、负责人、权限和检查结果均显式标未知。
- “没有真实部署能力则不生成可执行发布入口”；保留上游不可取消的人工 gate。
- 不支持热更新，不读取/迁移研发进度，不引入 bundle、DAG、租约或通用插件运行时。
- 耗时操作前集中收齐选择并预检，确认本次有界范围后默认连续研究、生成、预览校验与安装；仅用户事先选择审阅模式才在生成后等待。中途越界/冲突或必需输入缺失时保存并报告，不弹常规问题等待。
- 所有产品实现放在隔离工作区的 `codex/` 分支；保留当前仓库用户未跟踪文件，不一并暂存。
- 文档以支持开发步骤为生成依据；保留开发指南、skills 流程指引、原生变更工作文档三类用途，setup 仅生成前两类的必要内容，不建立类别注册表；遵循文档体系的质量门槛，不生成空 glossary/ADR/未来交付记录，不复制原生 SDD 或 OpenWiki 正文。系统现状由 OpenWiki 生成/更新；Rigup 仅接线、引用和报告缺口，不以未选用或不可用为由自建现状正文。
- 未核验 recipe 不自动执行；官方接口核验、本地契约、真实宿主兼容、真实生成分别留证，未知不冒充支持。

- 全项目遵循总设计 1.1：CLI/静态发现/recipes/机器配置/脚本/固定 skill 流程/安装恢复/真实结果由代码与模板维护；agent 仅研究、受限规划和生成项目语义正文。固定内容可参数化，不从模型 Markdown 提取可执行命令。
- 无必需语义任务或有效语义缓存足够时不调用模型；仅在本次实际需要 native 研究时要求其模型凭据。存在文档不自动等于已完成语义接入，缺研究不得以通用正文填空。
- 外部命令也遵守 Installer 3.1 的所有权保护；项目文本先成为候选，不以 declaredWrites 授权覆盖。旧 manifest 每个托管项都须交代去向，保留项不丢 ownership/旧 B。
- 使用总设计的 StepResult 传播 host 待回传，暂停不产生可安装计划；阶段/job、已接受候选、预算累计与授权关联在同一 run 恢复。执行锁覆盖研究/生成/apply，未决操作记录不随普通缓存清除。
- 本地客户模板及结构化 MCP 输入按 Integrations 第 4 节接入；只对模板使用显式标量替换，不替换固定流程/gates、不执行客户安装插件。

## Review Focus

1. 恶意/意外路径、符号链接与源码内指令：读取不越界，生成不越界，项目内容不能触发执行；Task 2、3、6 覆盖。
2. 用户删改配置、注释、未知字段、缺失或损坏 baseline：保留用户资产，不误认所有权；Task 5、6 覆盖。
3. 预览后改动、写入中断、manifest 失败、外部超时/强杀：拒绝陈旧预览，副作用前持久登记，恢复前对账，不重复副作用；Task 7 覆盖。
4. 部分暂存、未提交修复及推送多个 commit：检查目标确为提交/推送内容，不被工作区掩盖；Task 8 覆盖。
5. 宿主/上游版本不兼容、无凭据或无测试：报告未接入/未验证，不降级为虚假成功；Task 4、8、9 覆盖。
6. 普通配置内嵌凭据泄漏、托管输出反复污染研究输入，以及真实动态生成未验收：Task 2–3 建立读取与投影规则，Task 5–7 验证缓存与目标保护，Task 9 补真实生成验收。
7. 模式识别把单例/机械复制当惯例、漏查反例、将局部推成全局或将建议当规范：Task 3 核实证据和分类，Task 5 保留范围与例外，Task 9 用预标注项目及真实生成复核。
8. 文档无消费者、虚假历史决策、导航死链、规则无检查却声称强制、结果不绑定对象：Task 5 检查候选分类/来源/导航，Task 6 检查最终合并接线，Task 8–9 验真实结果和更新。

## 目录与共享接口

生产目录仅按四模块划分；`src/cli.ts`、`src/types.ts`、`src/config.ts` 为入口和共享契约。测试放 `test/`，固定样例放 `test/fixtures/`；上游版本证据放 `docs/compatibility/`，模板放 `templates/`。

`src/types.ts` 定义以下主数据，运行时也校验，不只依赖 TS：

- `SetupOptions`：选择的 `agents`（claude/codex/opencode/omp）、可选 `sdd`（superpowers/openspec/spec-kit）、tools、自定义 skill 路径及流程插入位置、本地模板的 source/target/values、客户 MCP 的 agents/server id/命令或 URL/envRefs、检查命令、客户集成、模型配置与读取预算、executionPolicy（continuous/review、可选缺口策略、重试上限；不是永久授权）。按 CLI 交互提案补充可选 `projectConventions { tracker?, documentRoutes?, labelMapping? }`：只收集已选能力消费的约定，记录引用不等于实现远端适配，配置仍为唯一选择来源。命令用 `CommandSpec { executable, args, cwd, envRefs }`，不将模型文本当 shell 执行；这些扩展仍为现有 config 的字段，不另建协议文件。
- `ProjectProfile`：规范化 root、输入 fingerprint、Git/worktree 状态、技术栈/模块、带来源和分类的规范（含 statement/classification/scope/supportingEvidence/counterEvidence/coverage/exceptions/unknowns/guidanceDisposition，见 Analyzer 2.1）、已有命令（build/lint/test/environment/eval 分开）、知识入口、unknowns、研究范围和截断状态。`Evidence { path, startLine, endLine, digest }` 可核实，digest 对应脱敏后片段，必要时附行号映射；原始字节摘要只留在私有读取层检查变化。输入 fingerprint 使用排除自身托管输出的研究投影，完整目标摘要单独计算，不能越过项目边界。
- `SetupPlan`：root、fingerprint、有效选项、带 `logicalId/target/content/ownership/source` 的候选、结构化操作、旧托管库存的每项去向、明确 removals、warnings、模板/集成/模型版本。`ownership` 区分整文件、JSON 键、TOML 表及标记块；遗漏不能替代资产处置。
- `InstallManifest`：schemaVersion、installId、有效选项/版本、托管选择器和新生成内容摘要/基线路径、各操作真实结果。继续维护/待处理旧项保留 ownership 和可信旧 B，只有明确移除成功才注销；不复制混合文件的其他字段。
- Installer 内部 `Preview` 含 id、最终差异、目标前置摘要、冲突、操作清单；`InstallReport` 分列配置/初始化/宿主加载/环境/软件检查/eval 的结果和待办，不用单一布尔值掩盖差别。

模块导出 `analyze(root, options, backend): Promise<StepResult<ProjectProfile>>`、`generate(profile, options, backend, previousAssets = []): Promise<StepResult<SetupPlan>>`、`preview(plan, resolutions?): Promise<Preview>`、`apply(previewId): Promise<InstallReport>`。StepResult 沿用总设计的 complete/value 与 pending-host/requestId/requestPath/nextCommand；backend.run 也使用它，CLI 只在 complete 时推进。previousAssets 是编排层加载的可信旧 manifest 只读投影，不是第四份主数据；首次为空，损坏则先诊断。用显式参数注入后端和测试依赖，不增加 DI 框架。

任务按 1→9 顺序落地。Task 2 的工具投影/远端来源用注入规则测纯契约，Task 4 再接核验过的 recipe；Task 3 只测 backend 往返/预算及 analyze 暂停，Task 5 只测生成缓存/候选，完整多阶段进程恢复和安装后 update 在 Task 7，真实输出在 Task 9。前置任务不调用尚未实现的后续业务模块，局部替身不充当整链路通过。

## Task 1: 可运行 CLI 与配置契约

**Files:** 创建 `package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore`、`src/cli.ts`、`src/config.ts`、`src/types.ts`、`src/progress.ts`、`test/cli.test.ts`、`test/config.test.ts`、`test/progress.test.ts`。

**Interfaces:** `runCli(argv: string[], io: CliIO): Promise<number>`；`loadOptions(root: string, overrides: Partial<SetupOptions>): Promise<SetupOptions>`。后续任务复用主数据和参数优先级，不自行解析配置。

- [ ] 写 `help_lists_lifecycle_commands`、`unknown_option_does_not_touch_project`、`explicit_options_override_project_config`、`invalid_config_has_field_error`：断言 help 包含 init/update/doctor；未知选项退出 2 且临时项目字节不变；显式参数优先于 `.rigup/config.yaml`，项目配置优先于选定 profile；错误定位字段，不能吞错使用默认值。
- [ ] 写 `bare_tty_routes_by_project_state`、`bare_non_tty_exits_2_without_writes`、`init_existing_manifest_uses_update_rules`、`damaged_manifest_is_not_fresh_project`、`doctor_is_read_only_by_default`：TTY 无参按真实配置/manifest 路由，非 TTY 无参不初始化；已有资产不重新认领；损坏元数据保留并诊断。
- [ ] 写 `eof_never_confirms`、`plain_terminal_uses_numbered_input`、`back_invalidates_dependent_choices`、`secret_input_never_echoes`：CliIO/prompt 可注入，NO_COLOR/TERM=dumb 无 ANSI，准备/审阅 EOF 取消而非默认同意，Esc 返回使依赖选择失效；纯文本输入可完成多选。以上测试和原 cli/config 行为一起经历 RED/GREEN。
- [ ] 建立最小编译/测试入口并运行 `npm test -- test/cli.test.ts test/config.test.ts`；Expected: 上述行为断言 RED，而不是依赖未安装或测试无法启动。
- [ ] 实现无参路由、TTY/非 TTY 的 CliIO/prompt 适配、参数/配置/profile 优先级及秘密输入、校验和 help/version；未接通的业务命令明确返回“尚未实现”，不写文件或输出成功。`package.json` 声明 bin `rigup`、`build`、`typecheck`、`test`（`tsx --test`）。`.gitignore` 只追加本产品产物，不覆盖用户规则。
- [ ] 在 `src/progress.ts` 建立无调度职责的 ProgressEvent/计时与 TTY、纯文本渲染适配，先完成准确计数、阶段、已用时间、等待及下一步。新增 `test/progress.test.ts` 验无分母研究不伪造局部百分比、无可比依据时整体进度/ETA 待估算、未知必需阶段不伪造完整 ETA、超原估计撤回预测；使用可注入时钟，先 RED 再 GREEN。历史统计/估算放在主线接通后完善，不设固定初始权重或产品必需样本阈值。
- [ ] 定义并验证统一 StepResult、客户模板/MCP 的字段校验和旧库存去向的最小契约；pending-host 不能携带成功 SetupPlan，必需字段缺失与输入错误仍区分。只建立契约，不在本任务伪装接通业务。
- [ ] 运行 `npm test -- test/cli.test.ts test/config.test.ts test/progress.test.ts` 和 `npm run typecheck`；Expected: 全通过。
- [ ] 只暂存本任务文件，提交 `feat: add rigup CLI and configuration contracts`。

## Task 2: 只读项目扫描与可信证据

**Files:** 创建 `src/analyzer/analyze.ts`、`src/analyzer/repository.ts`、`src/analyzer/evidence.ts`、`src/analyzer/read-policy.ts`、`src/managed-input.ts`、`test/analyzer.test.ts`、`test/repository.test.ts`。

**Interfaces:** `scanRepository(root: string, options: SetupOptions): Promise<ProjectProfile>`；`readEvidence(root: string, path: string, startLine: number, endLine: number): Promise<EvidenceRead>`；`EvidenceRead` 含正文与 Evidence。`analyze` 在 Task 3 加入语义研究。

- [ ] 写测试 `empty_and_non_git_are_valid_profiles`、`worktree_root_is_not_common_git_dir`、`monorepo_commands_keep_cwd`、`dirty_add_delete_changes_fingerprint`、`budget_returns_unknowns`、`symlink_escape_and_secret_files_are_denied`、`scan_never_executes_package_scripts`。用临时 Git 仓库/worktree 和恶意脚本 marker，断言 root、命令 cwd、每次字节变化后的不同指纹、截断标记、项目外与密钥文件拒读、marker 不存在。
- [ ] 增加 `embedded_credentials_are_filtered_before_export`、`search_snippets_use_same_policy`、`unknown_sensitive_format_is_denied`、`redacted_evidence_keeps_source_mapping`：用普通 JSONC/TOML/YAML 的敏感 env、认证头和 URL 凭据作 fixture；断言公开 reader/画像/证据缓存不含秘密，行号映射和可见片段摘要可核实，原始摘要仅供读取层检查。
- [ ] 增加 `managed_outputs_do_not_change_research_fingerprint`、`unmanaged_config_edit_invalidates_research`、`generated_text_is_not_normative_evidence`。在 `src/managed-input.ts` 建立纯所有权投影，Task 6 复用；无可信元数据或解析失败不猜测归属，相关缓存禁用并报告。
- [ ] 增加工具生成区与混合目录用户输入的纯投影场景，以及远端规范版本/内容变更、版本未知需重读、无法重读则依赖缓存失效的场景；Task 4 recipe 提供核验后的排除规则，不能按工具目录名整目录忽略用户输入。不新增远端适配/凭据流程。
- [ ] 运行 `npm test -- test/analyzer.test.ts test/repository.test.ts`；Expected: 新行为断言 RED。
- [ ] 实现受限枚举和读取：忽略依赖/二进制/生成区和常见密钥文件，支持显式范围；隐藏的 agent/CI 配置仍能识别。按 Analyzer 3.1 实现统一凭据过滤/拒读、脱敏前后摘要与行号映射；策略版本进入缓存 key。研究指纹覆盖所选原始输入字节及路径的新增/删除，排除 manifest/baseline/托管输出及仅承载输出的目录；混合文件只排除可信托管部分，非托管内容保留，有效用户选项另计，不依赖 HEAD；静态发现入口，不执行脚本。遇到未知语言/构建系统保留证据和未知项。
- [ ] 运行同一任务测试和 `npm run typecheck`；Expected: 全通过，扫描前后客户项目树一致。
- [ ] 提交 `feat: analyze repository facts with bounded read-only evidence`。

## Task 3: 独立模型与宿主的统一研究入口

**Files:** 创建 `src/analyzer/backend.ts`、`src/analyzer/anthropic.ts`、`src/analyzer/host.ts`、`src/analyzer/prompts.ts`、`test/backend.test.ts`；修改 `src/analyzer/analyze.ts`、`src/types.ts`。

**Interfaces:** `AnalysisBackend.run(request: ResearchRequest, reader: RepositoryReader): Promise<StepResult<ResearchResult>>`；request.kind 为 analyze/artifact-plan/artifact-content，包含输入摘要、预算和期望输出格式；reader 仅 list/read/search。完整 result 含经校验的数据、实际模型标识及 unknowns。host 用统一 pending-host 向上传递，接收匹配 requestId/阶段/产物及 requestDigest 的响应后续跑；requestDigest 绑定 runId、规范化 root、输入指纹、旧库存摘要、有效选项/预算、客户模板源/参数、MCP 非秘密配置、读取策略及 prompt/模板/文档标准/集成版本，并与当前上下文重新比较，不安装永久 MCP。

- [ ] 写 `tool_loop_only_exposes_read_tools`、`fabricated_evidence_is_rejected`、`source_prompt_cannot_trigger_exec`、`budget_or_provider_failure_is_not_complete`、`host_response_requires_matching_request`。通过 SDK 的可注入 HTTP transport 观察真实请求：无 exec/write 工具；伪造路径/行号/摘要被拒；预算终止有 unknowns；过期/格式错误响应不进入结果；缺 API key/model 给出配置错误，不偷偷改用假数据。
- [ ] 增加 `provider_and_host_requests_never_contain_fixture_secrets`、`old_read_policy_cache_is_not_reused`：捕获真实 SDK transport 的请求体及导出的宿主请求文件，断言 analyze/artifact-plan/artifact-content 和工具搜索结果都沿用 Task 2 reader，凭据不进入请求、缓存或日志。宿主自身额外读取不属于 CLI 可强制约束范围。
- [ ] 写 `host_response_rejects_changed_options_or_versions`、`host_response_rejects_other_root_phase_or_artifact`、`host_export_stays_in_private_cache`：仅源码未变不足以接收响应；root/预算/agent/SDD/读取策略/模板任一绑定改变均拒绝旧响应；request/response 参数互斥，导出拒绝项目树、符号链接逃逸和覆盖未知文件。有效往返经过同一生成/预览主线，不把响应当安装授权。
- [ ] 用受控调用者分别测试 analyze/artifact-plan/artifact-content 请求的 backend 文件往返及 analyze 向上传递 pending：新进程接受匹配响应、不重复消费、不重置已知预算，未写项目。用量不可取得则 unknown，预算耗尽不混成等待宿主；更换 run、旧库存或项目外模板源后旧响应失效。本任务不调用尚未实现的 Generator/Installer；真实多 job 已接受候选及 CLI 退出 3 的跨阶段恢复在 Task 7。
- [ ] 写 `existing_guidance_is_reused_before_code_inference`、`partial_guidance_limits_research_to_gaps`、`document_presence_does_not_imply_sufficient_guidance`、`conflicting_docs_are_not_resolved_by_mtime`：覆盖名称不同但内容可用、作用域/替代关系、远端引用不可读及文档/实现差异；已有足够规范不触发同主题完整反推，不要求以多数实现证明显式规则。
- [ ] 写 `single_example_stays_local`、`copied_templates_are_not_independent_support`、`counterexample_search_is_required_for_convention`、`competing_patterns_keep_scope_and_unknowns`、`explicit_rule_conflict_is_not_erased`、`budget_without_refutation_does_not_promote_hypothesis`：标注 fixture 包含同角色独立实现、生成副本、跨模块差异及显式规则冲突；断言支持/反例证据、coverage 与分类，不以结构合法代替语义正确。通过 transport fixture 验证反例搜索请求及停止策略；真实识别正确性留到 Task 9。
- [ ] 运行 `npm test -- test/backend.test.ts`；Expected: 上述断言 RED。
- [ ] 初步研究先按 Analyzer 2.0 发现/评估现有规范并记录来源、范围、复用状态、消费者和缺口，取得足够规划的证据即可；未完成主题留给 artifact-content 逐项补证。仅对缺口按 Analyzer 2.1 实现“分组比较 → 模式假设 → 独立支持/反例搜索 → 范围/冲突裁决 → 结构化观察”，与 native/host 共用核实要求；不生成 AS-IS，不从目录摘要直接推规范。用官方 SDK 实现受限工具循环，环境变量 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`，请求/读取/输出总预算和有限重试。SDK API 按官方文档核验。实现宿主请求/回传文件在私有缓存的往返；CLI 后续提供请求路径与续跑方式。源码作为研究数据；规范分类为显式规范/常见惯例/局部模式/建议，引用逐条复核。
- [ ] 运行本任务及 Task 2 测试、`npm run typecheck`；Expected: 全通过；模拟 transport 仅证明协议，不标记真实模型研究已验收。
- [ ] 提交 `feat: add bounded model and host research backends`。

## Task 4: 宿主、SDD、工具与客户 skill 集成

**Files:** 创建 `src/integrations/registry.ts`、`src/integrations/agents/{claude,codex,opencode,omp}.ts`、`src/integrations/sdd/{superpowers,openspec,spec-kit}.ts`、`src/integrations/tools/{openwiki,codegraph,customer-mcp}.ts`、`src/integrations/{custom-skills,custom-templates}.ts`、`test/integrations.test.ts`、`docs/compatibility/upstream-lock.json`；维护 `docs/compatibility/README.md` 和 `docs/compatibility/verification.md`。

**Interfaces:** 注册表分别导出 agent 的路径/格式和 prepare/verify、SDD 的原生入口/产物/gates 映射、工具的 detect/prepare/setup/verify 描述；操作数据 `SetupOperation { id, integrationId, kind, parameters, prerequisiteIds, declaredWrites, version }` 只用于固定顺序列表，不是 DAG 执行平台。`prepareIntegrations(profile, options): Promise<IntegrationPreparation>` 返回候选、操作、所需能力、警告。自定义 skill 不加载 JS/TS 插件。

每个 operation 还须提供 Installer 3.1 所需的目标类别/已有状态前置和保护依据；会改项目文本的部分先转候选。无法证明已有文件保护或与候选重叠无法拆分时，prepare 返回人工待办，不返回可执行 setup。工具生成区投影只排除已核验输出，保留混入的用户输入。

- [ ] 按 docs/compatibility/README.md 核验并锁定每项官方版本/commit、官方来源定位、核验日期、命令/参数、运行时/平台、原生入口/gates、写入范围/副作用和对账方法；建立运行时 schema，evidenceStatus/evidenceRefs 分开记录 source-verified、contract-tested、live-tested。兼容表留真实验证状态。参考 OpenWiki 已研究的宿主适配，但逐项核对当前官方入口；特别核对 Oh My Pi，不从 Pi 推定。CodeGraph 必须来自用户指定仓库。
- [ ] 写 `recipe_rendering_does_not_call_backend`、`model_text_cannot_create_executable_adapter`：固定 recipe/机器格式仅消费校验后的参数，缺 adapter 报待接入，不编译/执行模型文本。
- [ ] 写 `unverified_recipe_cannot_execute`、`version_change_requires_new_evidence`、`ordinary_update_keeps_locked_version`：无官方版本证据的 recipe 不进入自动执行，显式升级才触发新核验；本地替身通过不提升真实兼容状态。
- [ ] 写外部初始化在已声明目录内覆盖用户文件、与候选写入重叠的 prepare 契约：返回安全文本候选或具体人工待办，不返回不安全 setup；核对工具原生状态的保护证据。本任务不调用 Installer；预览后空目录变成非空及真正执行前拒绝的场景在 Tasks 6–7。
- [ ] 按 Integrations 第 4 节实现/测试本地标量模板的实际渲染与消费者引用、未知占位符/表达式/越界/目标碰撞拒绝、固定流程/gates 不可替换、源/参数摘要进入缓存，以及客户 MCP 输入到各所选宿主配置的意图映射。登记不启动，连接验证另授权；已有 server/注释/未知字段保留，秘密不入配置/日志。
- [ ] 写 `four_hosts_use_native_locations`、`three_sdd_bind_native_entries_and_keep_gates`、`missing_native_entry_fails_binding`、`custom_skill_copies_resources_without_execution`、`unknown_version_is_not_supported`、`deployment_requires_customer_capability`。断言选定组合的入口引用存在于锁定上游；四宿主配置可被对应解析器读取；自定义脚本 marker 未创建；无部署适配则无 release。
- [ ] 按 CLI 交互提案增加同 skill 插件/本地副本来源去重与冲突测试：只在授权的可探测范围识别，已满足依赖时复用，未知来源标待核实，不盲装第二份、不自动卸载原来源；项目工作约定可保存，但无可执行适配时必须 pending，不能冒充已接入工单系统。
- [ ] 运行 `npm test -- test/integrations.test.ts`；Expected: 对应行为断言 RED。
- [ ] 实现普通映射/适配，支持无 SDD、同时选择多个 agent。版本未知时报告待验证；SDD 的安装来源和约束保留，不能用自造命令替代。OpenWiki 安装/初始化/MCP 与 CodeGraph 安装/索引/MCP 分成不同操作；不能限制上游写入范围的操作提供人工方案，不执行未声明写入。
- [ ] 先在明确授权的可丢弃测试环境验证锁定上游的最小安装/skill 发现/MCP 路径，再扩展模板；此处是 recipe 冒烟，不调用尚未实现的产品安装器或改客户项目。缺环境继续独立本地工作但保留 pending，不将早期冒烟推成全矩阵通过；产品完整接入由 Tasks 7/9 验证。
- [ ] 运行本任务测试与 `npm run typecheck`；Expected: 全通过；真实版本证据和未验证项均可追溯。
- [ ] 提交 `feat: add native agent SDD and tool integration recipes`。

## Task 5: 动态产物生成与独立研发 skills

**Files:** 创建 `src/generator/{generate,artifacts,cache,render,document-policy}.ts`、`templates/skills/{change-prepare,change-deliver,change-release}/SKILL.md`、`test/generator.test.ts`、`test/skills.test.ts`、`test/document-policy.test.ts`。

**Interfaces:** `generate(profile, options, backend, previousAssets = []): Promise<StepResult<SetupPlan>>`；`validateArtifactList(input: unknown, required: string[]): ArtifactJob[]`，job 含 logicalId、目的、研究起点、相关产物及 pending/done；job/cache 是内部数据，不增加公开主协议。ArtifactJob 仅补 consumer、required/reason、sourceRefs、acceptance，target/ownership 沿用安装意图；旧资产去向按已有 manifest 库存核对，不增加独立数据库。

- [ ] 写 `service_and_monorepo_have_different_evidenced_artifacts`、`empty_repo_has_no_invented_as_is`、`duplicate_or_escaping_targets_are_rejected`、`required_failed_job_blocks_plan`、`corrupt_candidate_is_regenerated`、`changed_input_invalidates_cache`、`candidate_is_saved_before_done`。注入可控 backend 和缓存写失败，断言候选摘要、job 状态及无客户文件写入。
- [ ] 写 `document_jobs_require_consumer_and_generation_reason`、`existing_authority_is_referenced_not_duplicated`、`openwiki_owns_as_is_without_second_copy`、`missing_openwiki_never_falls_back_to_generated_as_is`、`empty_repo_has_no_glossary_adr_or_future_delivery_records`、`local_pattern_is_not_global_policy`、`rules_without_sensors_are_not_enforced`、`navigation_reaches_generated_docs_and_has_no_dangling_links`、`required_semantics_cannot_be_placeholder`：覆盖开发指南/流程指引/原生变更产物的职责边界、无具体消费者不生成、指南不额外复制 skills 流程、setup 不预生成变更文档、来源冲突并列、原生布局优先、未知与建议分开；运行证据与历史批准不由模型预填。
- [ ] 写 `existing_guidance_is_bound_into_agent_prepare_deliver_and_review`、`reused_source_stays_unowned_and_unmodified`、`equivalent_bindings_are_not_duplicated`、`textual_rule_without_check_is_not_enforced`、`source_move_or_delete_invalidates_binding`：断言原文 byte 不变、各宿主/skills 引用同一来源且保留 scope；只绑定已有检查，移动/删除后更新引用或报告失效，不因复用写出第二份规范。
- [ ] 写 `deterministic_assets_render_without_model`、`cached_semantics_do_not_repeat_backend_calls`、`semantic_candidate_cannot_override_fixed_skill_flow_or_gates`、`markdown_commands_are_not_operation_specs`：已明确选择与参数的工具接线不调用模型，所需语义尚未完成则不伪装完成；项目正文仅插入限定位置，安装命令仍来自 recipe/已验证配置。
- [ ] 写 `guidance_preserves_pattern_scope_examples_and_exceptions`、`undecided_patterns_are_not_global_rules`、`suggestions_do_not_become_existing_conventions`：生成指引明确何时/何处适用及真实范例，保留反例与未知，不能把观察改成政策或通用最佳实践。
- [ ] 覆盖旧资产被新清单遗漏、logicalId/路径改变、新反例使旧规则失效、旧入口/宿主自动加载及用户改过旧项：每个旧项须有去向，保留项不丢 ownership/旧 B；未安全修正/解绑的失效规则阻止完成。模板真实引用、源/参数变化触发更新并保护用户修改；不能把旧生成正文当新规范证据。
- [ ] 输入包含相反步骤或“跳过 gate”的语义候选/客户模板，断言拒绝或有限重做；变量正文仅放受限 references，固定流程负责读取。静态保留 gate 文字不作为实际宿主遵守的证据。
- [ ] 写 `workflow_reuses_selected_sdd_artifacts`、`upstream_human_gates_survive_wrapping`、`release_requires_real_adapter`、`installed_skills_do_not_invoke_rigup`。断言 prepare/deliver 引用 Task 4 原生入口和状态；release 缺能力时不存在；脚本/命令不调用本 CLI；流程含任务范围/授权/预算/停止/接手人、有限修复、实际证据和未知项要求，不新增自有状态机。
- [ ] 按 CLI 交互提案增加项目约定投影测试：文档落点沿用原生 SDD/现有布局、多 agent 引用同一项目上下文；未选标签消费者时省略标签说明；无 glossary/ADR 时不生成空文件；修改 tracker/documentRoutes 不自动迁移工单或既有文件。
- [ ] 运行 `npm test -- test/generator.test.ts test/skills.test.ts test/document-policy.test.ts`；Expected: 新行为断言 RED。
- [ ] 实现 document-policy 纯规则：按文档标准第 4 节将已有规范接入 agent 导航、prepare/deliver/评审及已有检查；接入关系复用现有 profile/plan，不增加数据库。按所选能力计算必需信息，将系统现状正文排除出 Generator 任务（由 OpenWiki 负责），复用现有权威来源，再允许模型规划有消费者的正文；确定性校验格式/路径/来源/导航，语义校验充分性并有限重做，分别记录结果。变更工作文档由安装后的 skills 在真实任务发生时维护，交付/反馈留在现有任务/MR/CI/平台中，不强制新增文档；setup 仅配置相关落点。文档标准版本进入缓存 key。
- [ ] 写 `initial_research_can_plan_before_all_topics_are_resolved`、`artifact_research_reuses_prior_evidence_and_only_fills_its_gaps`、`artifact_seed_paths_do_not_limit_valid_followup_reads`：使用共享 backend/reader 与预算，初步研究不要求穷尽全仓；逐项研究不重复已核实内容，复用项仅输出接入引用。新测试先 RED，再实现并 GREEN。
- [ ] 按已有 OpenWiki 源码研究实现“研究 → 动态清单及旧库存核对 → 串行逐项候选 → 校验接受 → 固定组装/恢复”：允许文档引用成环，汇总最后生成。机器命令/配置和公开 skill 集合固定由选择决定；正文由证据生成。缓存 key 含研究输入 fingerprint、有效选项、客户模板源摘要/参数、MCP 非秘密配置、读取策略及模型/prompt/模板版本；旧库存及远端规范有效性也须核对。候选保存后标 done，pending-host 沿 StepResult 返回并保存阶段/累计预算，不构造可安装的部分计划。自定义 skill 原样保留；遗漏不授权删除或注销旧资产。
- [ ] 增加 `installed_inventory_aligns_with_cached_candidates`：以已接受候选构造可信库存 fixture，验证库存从空变为本轮已安装项时确定性对齐缓存、不重复调用 backend；更改非托管规范/源码会触发重新研究，生成正文不得成为新规范证据。本任务仅验证缓存契约；真实安装后连续 update 在 Task 7，缓存丢失也不绕过后续三方保护。
- [ ] 运行同一任务测试和 `npm run typecheck`；Expected: 全通过，生成前后客户项目字节相同。
- [ ] 提交 `feat: generate project-specific rigup assets and SDD workflows`。

## Task 6: 安全预览与三方更新

**Files:** 创建 `src/installer/{preview,merge,ownership,baseline}.ts`、`src/integrations/agents/config-edit.ts`、`test/merge.test.ts`、`test/preview.test.ts`。

**Interfaces:** `preview(plan, resolutions?): Promise<Preview>`；`mergeManaged(base: string | undefined, local: string | undefined, next: string | undefined, intent: ManagedIntent): MergeResult`，result 为 create/update/noop/keep/conflict/remove；Preview 的最终写入内容保存在私有缓存，apply 不再调用模型。

- [ ] 写参数化 B/L/N 真值表：无 B/L 创建、L=N noop、L=B 更新、N=B 保留用户修改、用户删除保留并冲突、无可信 B 不接管、明确移除仅删除未改托管项。另写 `nonoverlapping_edits_merge`、`overlapping_edits_conflict`、`jsonc_comments_and_unknown_fields_survive`、`toml_unowned_tables_survive`、`malformed_markers_need_manual_patch`、`baseline_never_copies_unowned_secrets`。
- [ ] 增加逐项 `PreviewResolution` 的 target/selector/observedDigest/action 校验：adopt/restore/replace/remove 必须形成新预览；目标变化拒绝旧裁决，不永久放宽所有权；基线仅存生成的 N，成功移除注销对应 ownership。
- [ ] 核对旧库存去向完整性与保留项旧基线可达，拒绝漏项计划；检查所有外部 operation 的写入前置/保护方式及候选重叠，无法安全拆分则无可执行操作。覆盖已有用户文件、混合选择器、空目录变化、模板既有目标冲突；不能仅凭 declaredWrites 放行。
- [ ] 写 `kept_local_content_cannot_break_required_bindings`、`nonoverlapping_merge_still_checks_reference_targets`、`unrelated_local_edits_remain_preserved`：N=B 时用户已移除必需入口/改坏 reference，或两侧非交叠修改组合出死链，均保留 L 并产生具体预览阻塞，apply 不可执行；普通局部修改和无关非托管正文不被强制重审。用最终虚拟树检查配置、必需入口/消费者绑定及本地引用，不以候选 N 通过替代；尚待安装且有核验过的确定产出契约的入口可按依赖放行，标待 verify，无契约的目标不得假定存在。需要新语义判断时交回准备/生成，preview 不调用 backend。
- [ ] 运行 `npm test -- test/merge.test.ts test/preview.test.ts`；Expected: 真值表与配置保留断言 RED。
- [ ] 实现纯合并和预览，按 Installer 第 2 节检查最终虚拟项目的接线不变量；成熟 diff3 算法处理文本非交叠修改，选型核验后锁版本。JSONC 用范围编辑、TOML 只更新拥有表/标记块，无法安全保留格式时冲突并提供片段。复用 Task 2 的纯所有权选择器/投影规则，完整目标摘要仍基于实际字节，不能用研究指纹代替。复核路径和符号链接，baseline 摘要不匹配则不可信。preview 不改项目，也不执行安装任务。
- [ ] 运行同一任务测试和 `npm run typecheck`；Expected: 全通过；fixture 中客户密钥不出现在预览、日志和 baseline。
- [ ] 提交 `feat: preview managed changes with ownership-aware three-way merge`。

## Task 7: 顺序安装、失败对账与增量更新

**Files:** 创建 `src/installer/{apply,operations,lock,manifest}.ts`、`test/installer.test.ts`、`test/recovery.test.ts`；修改 `src/cli.ts`。

**Interfaces:** `apply(previewId): Promise<InstallReport>`；`executeOperation(operation: SetupOperation): Promise<OperationResult>` 仅分派内置已知 integration/kind；结果分别为 done/failed/pending/unknown。执行锁基于规范化项目目录，不依赖 Git 是否初始化；覆盖研究/host 导出/生成/apply，独立 apply 也取得同一锁。普通候选缓存与用户应用状态目录中的锁/未决操作记录分开。

- [ ] 写 `dry_run_has_no_project_side_effect`、`stale_preview_is_rejected`、`same_target_lock_prevents_second_apply`、`second_apply_is_idempotent`、`interrupt_reconciles_real_files`、`manifest_failure_keeps_old_baseline_valid`、`lost_cache_does_not_authorize_overwrite`、`remote_timeout_queries_before_retry`。故障注入分别放在文件写入后、初始化后、manifest rename 前；统计副作用执行次数并断言没有自动 reset。
- [ ] 写 `sigint_waits_for_writing_process_before_unlock`、`unconfirmed_process_exit_keeps_project_blocked`、`sigint_exits_130_and_reconciles_remote_unknown`：用可控子进程/时钟模拟取消，停止新调度后标 cancelling；终止确认前不释放锁，超时保留进程身份/操作范围/阻塞记录；重进核对旧进程，远端动作保持 unknown，不盲重试。
- [ ] 写 `pending_record_is_durable_before_dispatch`、`crash_after_remote_acceptance_reconciles_without_recreate`：未决记录写失败时副作用次数为零；记录后未派发、远端已接收但未保存结果、已知结果但 manifest 未写三处强杀，清空普通缓存后重进仍先查询/核实旧进程，不自动重做或提前解除阻塞。可控远端替身保存自身事实，断言实际创建次数为一；不可查询时保持人工待办。
- [ ] 增加生成阶段两个 CLI 进程的隔离场景：第二个不改 active request/候选/授权；host pending 保存后释放锁，回传复核 runId 再续跑。删除普通候选缓存后未决写进程仍阻止第二次 apply，不把未知远端动作重做；永久状态也不可用则列人工核对。
- [ ] 写完整多进程 host 恢复：analyze 待回传 → artifact-plan 待回传 → 首个正文接受、第二个待回传 → 新进程续跑 → 预览/安装。每次暂停退出 3 且项目字节不变，最后不重复已接受 job/响应，累计预算/本次授权不重置，变更绑定上下文拒绝旧响应。只读准备与副作用执行按同一 CLI 主线衔接。
- [ ] 覆盖外部操作与候选重叠、执行前已有目标变化及执行后摘要不符，不提交虚假基线；保留旧资产不丢所有权。完整 apply 中项目测试失败仍提交成功接线的 manifest/基线并退出 1，二次运行不重复安装；初始化失败/未知则停止依赖动作并对账。
- [ ] 增加 `cached_generation_still_detects_managed_edits_and_deletes`：在研究指纹不变、生成缓存命中时修改/删除托管项，断言进入三方合并或删除冲突；预览后再修改托管块必须拒绝 apply。
- [ ] 增加 `unchanged_update_reuses_candidates_after_install`：接真实 Analyzer/Generator/Installer 完成安装，保留缓存连续两次 update，断言无重复 backend 调用/生成差异/安装副作用。覆盖合并保留 L 后接线验证失败时安装次数为零，以及选中项目检查破坏已写接线时不提交虚假成功基线；正常项目检查红仍保存成功接线。
- [ ] 运行 `npm test -- test/installer.test.ts test/recovery.test.ts`；Expected: 上述恢复与保护断言 RED。
- [ ] 实现目标/输入/选项/版本前置复核与整轮单目录执行锁；固定顺序为明确安装/Git 初始化 → 配置和 skills → 工具初始化 → 分列接入验证/项目检查 → 独立新 baseline（保留旧项旧 B）→ manifest 原子替换。外部操作按 Installer 3.1 的写入前置和执行后证据校验，副作用前的持久登记/终结按其第 4 节；提交基线前复核最终接线，仅项目检查失败仍保存成功接线并返回 1。写前备份到私有缓存，逐项记录实际状态，安装/初始化失败或未知停止依赖动作。锁冲突不自动夺锁；Ctrl+C 有界终止/退出 130，写进程确认退出及本地写入结束前不开放下次执行，未决信息保存在用户应用状态目录，不随普通缓存清除。
- [ ] 增加 `preflight_collects_missing_inputs_before_research`、`continuous_run_never_prompts_after_start`、`preview_outside_consent_stops_without_writes`、`review_mode_waits_only_when_selected`：启动前缺必需输入不调用研究后端；收齐后移除 stdin，连续模式仍自动预览校验/安装；新副作用、输入变更或冲突不被预授权放行；异常集中报告退出。
- [ ] 接通 init/update/--dry-run：展示具体差异与副作用，按用户选项执行；无源码/Git 状态不隐式初始化。恢复先核对真实结果，在准备阶段集中确认本次范围，再重新预览；宿主同次技术往返保留仍匹配的有界授权，不重复问业务偏好；工具升级和明确退役才触发对应操作。host 请求未完成返回待续跑而非安装成功。
- [ ] 接通 host 更新当前宿主：先研究/响应，再退出待改会话并从独立终端续跑；自动回传仍在待改会话内则保存候选、退出 3 并给准确续跑命令，不弹问或热更新。以用户确认/既有自动化约束为准，不建设会话 lease；同次技术交接仍复核当前执行条件与预览。
- [ ] 运行同一任务测试与 `npm run typecheck`；Expected: 全通过，初始化重试与普通 update 不产生重复资源。
- [ ] 提交 `feat: apply and resume rigup installations with protected updates`。

## Task 8: 工程反馈接线、GitLab 与 doctor

**Files:** 创建 `src/integrations/tools/quality.ts`、`src/integrations/gitlab/{ci,customer}.ts`、`src/installer/doctor.ts`、`templates/scripts/{check-snapshot,openwiki-ci-update}.mjs`、`test/hooks.test.ts`、`test/gitlab.test.ts`、`test/doctor.test.ts`；修改 `src/cli.ts`、Task 4 注册表。

**Interfaces:** `doctor(root: string, options: DoctorOptions): Promise<InstallReport>` 默认只读；`DoctorOptions.runChecks` 显式选择已有命令。质量 prepare 返回所选 hooks、已有检查命令和 GitLab include；客户配置仅声明工单/MR/CI/部署/反馈所需命令或 MCP/environment references，不承载可执行安装插件。

- [ ] 写 `precommit_checks_index_not_worktree`、`prepush_checks_pushed_commits`：构造部分暂存“坏提交/好工作区”、跨多个 commit、删除和新增文件；断言检查看到正确快照、失败阻断、工作区/index 不变。已有 hook 不覆盖；无法安全串联的自定义 hook 报人工待办。
- [ ] 写 `ci_preserves_exit_status_and_reports`、`wiki_update_has_no_self_trigger_loop`、`gitlab_include_preserves_existing_jobs`、`missing_secrets_are_pending`、`doctor_separates_config_environment_tests_and_eval`、`doctor_does_not_initialize_or_repair_business`。使用本地 GitLab job runner/命令替身验退出码和产物，CI 语法另用真实 GitLab lint；没有环境/权限则明确未验证。
- [ ] 写 `reports_bind_checks_to_actual_commit_environment_and_time`、`stale_result_does_not_validate_new_input`：指南记录命令与前置条件，真实执行才记录结果，模型生成正文不得提供安装/检查成功状态；结果分列并保留未知项。
- [ ] 运行 `npm test -- test/hooks.test.ts test/gitlab.test.ts test/doctor.test.ts`；Expected: 上述具体断言 RED。
- [ ] 实现独立快照检查脚本：不 stash/reset；pre-commit 使用 index，pre-push 解析 hook 输入的实际推送范围并检查相应 commit，删除推送跳过。已有依赖不可用于快照时明确失败/所需配置，不退回错误工作区。通用静态工具按选择接入，业务测试/eval/环境只复用已有命令。
- [ ] 实现 GitLab CI include 合并、OpenWiki 更新的凭据引用/触发条件/防循环和报告；客户部署有明确目标、授权及恢复 runbook 才提供 release 绑定。doctor 分别报告 configured/available/initialized/reload-required 与检查结果；缺项 pending，项目测试红不改为安装失败，也不改业务代码。
- [ ] 运行同一任务测试和 `npm run typecheck`；Expected: 全通过，安装生成的 hooks/CI 脚本不依赖 rigup 包或本机源码。
- [ ] 提交 `feat: wire existing engineering feedback and diagnose integration status`。

## Task 9: 整体交付与真实兼容验收

**Files:** 创建 `test/e2e.test.ts`、`test/live-compatibility.test.ts`、`test/live-generation.test.ts`、`README.md`；维护 `docs/compatibility/verification.md`，完善 `src/cli.ts`、`package.json` 和 lockfile。

**Interfaces:** 最终用户入口 `rigup init|update|doctor`、`--dry-run`、`--backend native|host`、`--request/--response` 宿主往返参数、`--json` 机器报告；选项名称在 help/README/测试一致。host response 仍调用同一主线，不维护第二套安装逻辑。

- [ ] 按 CLI 设计覆盖自动化价值：无额外禁止提问或统一同意开关，直接调用 init/update 复用明确配置即正常运行，--json 仅选择机器输出；可探测事实和安全默认值无需重填，可选缺口不阻止任务；只有无法取得的必需凭据/目标/授权才预检报告，TTY 则在启动前集中补问。
- [ ] 增加长流程交互验收：记录 prompt 调用时间，断言 continuous 模式最后一次用户输入早于首个语义研究请求，之后生成/预览/安装/验证无 prompt；已知凭据缺失在预检集中处理，运行期预算耗尽/冲突/远端结果未知输出汇总后退出，无等待输入；显式 review 模式允许生成后审阅。
- [ ] 写 `deterministic_only_setup_does_not_require_model_credentials`、`doctor_and_apply_do_not_call_backend`、`unresolved_semantic_requirements_are_reported_without_placeholder_success`：断言配置中本次不含语义任务时无模型请求/无无关凭据阻塞；需要语义理解却缺后端时准确报告，不把仅文件存在当复用完成。
- [ ] 写 `onboarding_routes_conditions_and_existing_choices`、`host_roundtrip_binds_current_consent_and_context`、`resume_reconfirms_after_cancellation_or_failure`：使用 TTY 输入脚本验证条件问题/只问新增必需值、返回修改/EOF、已有 skill 来源去重及多轮 host；技术性往返沿用仍匹配的本次范围，新一轮取消/失败恢复在启动前一次确认，不沿用旧 preview 放行新副作用。
- [ ] 写端到端：空项目首次配置、完全无 AI 的旧项目、多 agent、已有配置、源码变更后 update、用户改/删资产后的冲突、取消能力的明确移除、宿主往返、无 SDD/自定义 skill、缺凭据。断言实际项目树、报告分类、二次安装零重复和新旧项目不同文档，不只匹配 stdout。
- [ ] 加入修订的完整链路：外部初始化不能覆盖已有资产；重规划漏项/改名/新反例不留下活跃旧规则或丢 ownership；host 各阶段跨进程暂停恢复不重置预算或串响应；本地客户模板真实进入 skill 消费、变更走三方保护，客户 MCP 登记/连接状态分开。再覆盖真实工具初始化后的重复 update、远端规范变更/不可读缓存失效、普通缓存丢失仍阻止未决写进程、远端接受后强杀仍对账不重复、无文本冲突但最终引用断开仍阻止安装，以及先响应/停会话/独立终端 apply 的 host-update。
- [ ] 增加文档端到端/真实生成断言：空项目、单服务、monorepo、已有 SDD/OpenWiki、多 agent 和源码变更的 fixture，覆盖三类开发文档的职责与按需生成标准、文档标准变更拒绝旧缓存/宿主响应、复用权威正文、模块 cwd、导航可达、事实引用、规则—检查对应、无假 ADR/批准/测试结果；至少人工抽核代表性事实、约定和缺口，记录预算/版本和复核结论。静态测试不得宣称语义与真实生成已验收。
- [ ] 写 `installed_assets_work_without_cli`：打包安装到临时消费目录，完成 setup 后移除 rigup 的 bin/依赖，在声明的真实工具依赖可用时运行 hooks/脚本并核对 agent 可发现 skills/MCP 配置；缺真实宿主时不得以静态解析冒充已发现。
- [ ] 运行 `npm test -- test/e2e.test.ts`；Expected: 未完成的主线断言 RED。
- [ ] 增加 `progress_explains_current_and_next_steps`、`quiet_task_emits_liveness_without_fake_completion`、`retry_and_manual_wait_update_eta`、`replan_explains_denominator_change`、`json_stdout_is_not_polluted_by_progress`。用可注入时钟/事件模拟验证：阶段编号与本次实际阶段一致、子任务计数来自完成事件、TTY 10 秒/纯文本 30 秒静默反馈、60 秒无进展说明等待对象而不提问、重试受原上限约束、人工等待不倒计时、恢复显示复用项、失败不变成 100%、dry-run 的完成状态明确尚未安装。测试不真实 sleep。
- [ ] 主线完成后再完善有依据的 ETA/整体估计：无可比样本明确待估算；有样本展示来源和区间，失去依据撤回，未知必需阶段不显示完整总 ETA。不为固定权重/阈值建设单独统计模块；采用的算法用可注入时钟验证即可。
- [ ] 完成 CLI 错误码（0 完成、1 失败/冲突、2 输入错误、3 待外部输入/待续跑）、进度和摘要；README 说明初始化/更新/宿主往返、授权范围、退出状态、密钥引用、冲突恢复和开发者待补项。默认日志不打印源码请求全文、密钥或完整会话。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run build`、`npm pack --dry-run`；Expected: 本地全通过，发布包包含模板和独立脚本，无缓存/客户数据。
- [ ] 在临时真实宿主/工具环境运行 `npm run test:live`：四宿主分别验证 skill 发现和 MCP 连接，三 SDD 验证原生入口与包装 gates，OpenWiki 初始化/恢复及 GitLab 更新、指定 CodeGraph 建索引/查询。每条记录精确版本、命令、时间、结果和证据位置；4×3 组合逐项标 passed/failed/unsupported/pending，不由单宿主成功推定其他组合。无运行条件写明 pending 与所需条件，首版完整验收保持未完成，不能改成 mock 通过。
- [ ] 在真实宿主核对固定技能读取项目 references/客户模板后的 gate 行为，并验证 host-update 的会话退出交接；各工具初始化后的输入指纹及无变化 update 用真实输出验证，不能只用空目录替身。记录客户 MCP 至少一个真实连接案例与模板实际消费者行为，仍不把单宿主结果推广到其他组合。
- [ ] 真实复用/接入验收：已有完整规范、仅部分主题有规范、完全无规范三组 fixture，native/host 分别观察原文复用及补缺研究；从实际 agent/skills 入口定位并使用正确范围的规则，检查无重复正文/无接管原文件、等效接入不重复、来源更新/移动/删除后的重规划，以及文字指导与真实自动检查状态分开。
- [ ] 真实模式识别验收：为单服务/monorepo fixture 预先人工标注独立模式样例、反例、局部/跨模块范围和显式规则冲突；native/host 各自识别并提炼可操作指引。逐项核对支持/反例、分类、范围和新增同类实现的参考价值，记录漏识别/误概括/无依据断言；引用伪造、局部泛化或建议冒充规范不得判通过。源码修改引入新反例后 update 必须收窄/降级相应结论，用户文档修改保护继续生效。不以两项目文案不同、JSON 合法或链接存在代替识别质量。
- [ ] 将 `test/live-generation.test.ts` 纳入 `npm run test:live`，使用不含真实客户秘密的单服务和 monorepo 固定项目，分别经真实独立模型及宿主往返完成 analyze → artifact-plan → artifact-content → preview/apply → 源码变化后的 update。核查两项目的模块/产物差异、引用路径/行号/可见摘要、空白或未覆盖区域的 unknowns、必需正文完整性、更新反映新事实及保护用户修改；按语义断言和人工核查证据验收，不固定逐字输出。真实宿主请求及真实模型请求沿用读取边界，不能以 mock 代替。
- [ ] 在现有 docs/compatibility/verification.md 按其字段逐项维护四个独立结论：实现与本地检查、真实动态生成、真实宿主与工具兼容、首版完整验收；每项 pending 写缺失条件，unsupported 写已核实限制且保留需求缺口。四宿主的无 SDD 场景及 4×3 组合、两工具 MCP、独立运行均逐项留证，不由一个结果推定其他结果。
- [ ] 在 verification.md 分开记录“真实动态生成”和“宿主/工具兼容”：每种后端与项目记录模型/宿主、prompt/模板/读取策略版本、fixture commit、实际命令、时间、预算、结果及脱敏证据位置。缺 API key、模型权限或宿主运行条件时相应条目 pending，并保留首版完整验收未完成；宿主连接成功不能推定模型研究已通过。这是脚手架产品验收，不生成客户 Agent eval 数据集或平台。
- [ ] 提交 `feat: deliver end-to-end rigup setup and compatibility evidence`，仅在真实证据满足时才声明对应兼容能力和动态生成能力已验收。

## 执行与收尾

计划审阅后创建/复用隔离工作区，按 executing-plans 的 `sdd-workspace`、`task-start`、`task-done` 记录每任务 RED/GREEN、commit 和裁决。按以上顺序连续执行，不逐任务要求人确认；真实外部授权或缺失凭据只阻断依赖操作，继续可独立完成的实现和本地验证。

本轮文档收口已将 CLI 第 8 节补入任务；上游版本与真实运行仍按兼容证据规范执行，不将文档审阅当成产品验证。

全部实现后按技能要求做一次 fresh-context 全分支评审，重点复核 Review Focus；重要问题补失败测试后修复并运行全套，次要问题列明。最终报告区分实现完成、本地检查、真实宿主/工具验收和外部待办。未经用户授权不合并主分支、不推送、不发布。

## 计划自检

- 四模块分别由 Tasks 2–3、5、6–7、4/8 实现；CLI 和整体验收由 Tasks 1/9 承担。原需求中的新旧项目、动态文档、四 agent、三 SDD、两工具、客户 skill、反馈和维护均有任务。
- Task 5 包含安装后流程的授权、证据、恢复和反馈约束；不把 setup 与研发 skill 混为入口，不要求新研发状态存储。
- Review Focus 的八类风险已分配具体行为测试；普通配置凭据覆盖导出边界，研究投影与目标保护分别验证，Task 9 真实动态生成与兼容性分别留证，均不以本地替身代替。
- 仅有三份主要持久数据，preview/job 为内部缓存；共享接口、返回状态和任务依赖保持一致。未添加热更新、通用插件平台或客户测试体系。
