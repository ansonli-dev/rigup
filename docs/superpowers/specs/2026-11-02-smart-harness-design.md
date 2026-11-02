# 智能 Harness 脚手架：架构与模块设计

日期：2026-11-02。状态：技术设计提案，尚未实现。
范围：脚手架的 setup/update 生命周期。安装后的研发 skills 是独立产物，其运行设计不在本文展开。

- [需求基线](../../requirements/2026-11-02-smart-harness-requirements.md)
- [安装后的研发 skills 设计](2026-11-02-installed-skills-design.md)
- [OpenWiki 源码研究与设计取舍](../../research/2026-11-02-openwiki-analysis-generation.md)

## 1. 系统边界与架构决策

### 1.1 两条生命周期

脚手架：发现项目 → 分析 → 选择/解析 → 编译 → 规划 → 安装验证 → 退出。只在初始化、检查和更新 harness 时运行。

安装产物：skills、hooks、MCP 配置、脚本和客户 CI 在项目中独立使用，不调用脚手架 CLI，不依赖安装期会话服务。研发任务的进度、审批、候选和执行 lease 不归 installer 管理。

两者通过版本化 HarnessBundle 和安装清单连接。脚手架管理自己拥有的配置与文件；客户源码、测试、原生工具数据库和研发状态不归它覆盖。

### 1.2 关键决定

- 采用单进程分层模块架构，避免为安装任务建设后台服务和消息系统。
- CLI 是应用装配层，负责交互、调用顺序和报告，不实现解析、合并或安装规则。
- 分开“能力解析、内容编译、安装规划”，不把用户选择直接转成写文件命令。
- 所有客户文件/配置变更和外部安装效果由 Executor 执行；模型、Compiler、Planner 不直接写客户环境。
- 内置 adapter 实现随产品发布，客户通过声明式 skill 包扩展；首版不加载任意远程代码插件。
- 安装动作可有固定依赖图，但不因此引入研发工作流执行引擎。
- 建议 TypeScript/Node.js 实现，单 Git 仓库为安装状态边界，macOS/Linux 优先；具体库和上游版本实施前锁定。

## 2. Module 划分与依赖

### 2.1 七个 Module

- M1 [Project Discovery](scaffold-modules/01-project-discovery.md)：读取项目现状，产生带证据和摘要的快照。
- M2 [Analysis Runtime](scaffold-modules/02-analysis-runtime.md)：研究项目，在能力解析后动态规划产物并按任务生成、提交和接受候选。
- M3 [Selection & Capability Resolver](scaffold-modules/03-capability-resolver.md)：归一化用户选项，选择能力提供方、版本、依赖和 gate。
- M4 [Bundle Compiler](scaffold-modules/04-bundle-compiler.md)：将解析结果和分析内容编译成独立可运行的交付资产。
- M5 [Install Planner](scaffold-modules/05-install-planner.md)：比较目标与现状，完成所有权检查、三方合并和安装计划。
- M6 [Install Executor](scaffold-modules/06-install-executor.md)：执行具体动作，验证、恢复并激活交付包。
- M7 [Adapter Platform](scaffold-modules/07-adapter-platform.md)：承载 agent、SDD、工具、质量配方与客户扩展的实际差异。

每个 Module 的内部设计独立成文，Interface、输入输出、不变量及异常语义在文档之间保持一致。

### 2.2 调用顺序

```text
CLI / 安装期宿主分析传输
    │
    ├─ M1 scan → ProjectSnapshot
    ├─ M7 catalog/probe → ProviderCatalog + Observations
    ├─ M3 resolve-selection → NormalizedSelection
    ├─ M2 analyze → AnalysisResult
    ├─ M3 resolve → Resolution
    ├─ M2 plan-generation → GenerationPlan
    ├─ M2 generate / submit / finish → AcceptedArtifactSet
    ├─ M4 compile → DesiredHarness
    ├─ M5 plan → InstallPlan
    └─ M6 apply → InstallationReport → 退出
```

M3 的选项归一化先于语义分析，确定分析范围；最终能力解析在分析后完成。只读 probe 可以按所选能力补充调用，不能隐含安装。

项目研究、产物规划与内容生成分开：模型先理解系统，再根据已解决的能力决定语义内容如何组织，逐项形成候选；机器配置和强制结构仍由确定性模板生成。生成阶段只写安装私有候选区，最终客户文件仍由 M5/M6 合并安装。

### 2.3 依赖方向与副作用

Core Module 依赖共享契约和窄的 Port，不直接 import 具体 agent 或 GitLab 实现。M7 在装配层提供这些 Port 的 Adapter：

- Discovery 使用 ReadWorkspace / GitRead。
- Analysis 使用 EvidenceReader / AnalysisProvider。
- Resolver 使用 ProviderCatalog 的不可变描述。
- Compiler 使用 TemplateCatalog / Renderer。
- Planner 使用 ReadInstallation / MergeStrategy / ActionRecipe。
- Executor 使用 WriteWorkspace / ActionDriver / VerificationDriver / InstallStore。

Adapter 实现只能依赖契约和其所需工具，不反向调用 CLI 或 Core 流程。M7 的 render/recipe 是无客户写入的操作；run 只经 Executor 调用。只读 probe 的外部进程也必须是声明过的只读命令，不运行仓库任意脚本。

安装期间的候选内容、模型结果和日志可以写入 installer 私有存储；它们不等同于修改客户项目，也不能被当作已安装产物。CLI 的异常处理只转换结果，不补偿执行未知命令。

## 3. 共享数据与 Interface

### 3.1 主链契约

以下为设计契约，真实 schema 实施时版本化：

```typescript
type ProjectSnapshot = {
  schemaVersion: number;
  repo: RepoIdentity;
  inputDigest: string;
  files: FileEvidence[];
  modules: ModuleFacts[];
  existingChecks: CheckFact[];
  configRefs: SourceRef[];
  coverage: ScanCoverage;
};

type AnalysisResult = {
  snapshotDigest: string;
  findings: Finding[];
  unknowns: Unknown[];
  provenance: AnalysisProvenance;
};

type Resolution = {
  selection: NormalizedSelection;
  inputDigest: string;
  providers: ProviderPin[];
  bindings: ResolvedBinding[];
  artifactSlots: ArtifactSlot[];
  allowedSemanticKinds: SemanticArtifactKind[];
  effectiveGates: GateRequirement[];
  desiredResources: ResourceIntent[];
  constraints: CompatibilityConstraint[];
  unresolved: Requirement[];
};

type GenerationPlan = {
  planId: string;
  revision: number;
  snapshotDigest: string;
  resolutionDigest: string;
  sourceScope: SourceScope;
  sourceFingerprint: string;
  jobs: ArtifactJob[];
  retireProposals: ArtifactRef[];
};

type AcceptedArtifactSet = {
  generationPlanId: string;
  accepted: AcceptedCandidate[];
  dependencyIndex: GenerationIndex;
  requiredComplete: boolean;
  unresolved: Requirement[];
};

type DesiredHarness = {
  bundle: HarnessBundle;
  overlays: ArtifactIntent[];
  resourceIntents: ResourceIntent[];
  retirements: RetirementIntent[];
  verificationIntents: VerificationIntent[];
};

type InstallPlan = {
  schemaVersion: number;
  planId: string;
  inputDigest: string;
  desiredBundleId: string;
  preconditions: Precondition[];
  actions: InstallAction[];
  conflicts: Conflict[];
  activation: ActivationSpec;
};
```

关系：Snapshot 记录观察，Analysis 记录解释，Resolution 记录已选绑定，GenerationPlan/ArtifactSet 记录计划和已接受语义候选，DesiredHarness 记录组装后的目标内容，InstallPlan 记录具体环境变更。中间结果不复用一个“万能配置对象”。

### 3.2 标识与摘要

RepoIdentity 包括 worktreeRoot、commonGitDir、head 和本地 repoKey。同机 worktrees 的安装写锁使用 commonGitDir；不同 clone 不宣称有共享本地锁。

无 Git 的新目录以 uninitialized 描述，commonGitDir 暂空，分析不创建目录或仓库。用户选择初始化后，Planner 才产生 mkdir/git.init 前置动作；安装前半段使用平台私有缓存和目标根锁，初始化后迁移到 Git common dir，详见 M1/M6。

inputDigest 按实际读取的文件内容、相关配置、选择及证据范围计算，包含未提交修改。工具 probe 的版本与路径单独进入 Resolution/Plan 前置条件，不能仅凭 HEAD 判定计划仍有效。

bundleId 是规范化交付内容、绑定及版本的摘要。planId 是规范化计划的摘要，不含运行时间、日志或创建人显示字段。actionId 在计划内稳定；外部 effectKey 由资源身份与 desiredDigest 派生，不因恢复换 runId 而变化。

任何局部扫描结果携带 coverage；“未观察到”与“确定不存在”分开。模型分析不是确定性函数，其缓存记录模型、prompt、输入和结果摘要；给定相同中间输入时，解析、编译和规划必须可重现。

### 3.3 所有权与安装清单

InstalledManifest 记录：

- 本次安装的 bundle、已知历史 bundle 和各自依赖约束；
- 每个托管文件或配置 selector 的 owner、生成摘要及基线 blob 引用；
- 已创建外部资源的稳定 id、作用域及可验证版本；
- 已安装语义产物的 GenerationIndex：来源/事实、选项、模板和能力版本依赖；
- 配置/工具/宿主刷新要求及上次接入验证证据。

基线内容保存在 installer 私有 content store，用于三方合并；锁文件只存摘要不足以恢复基线。manifest 不记录或拥有研发审批、变更进度和发布候选。

每次激活保存不可变 InstalledManifest，manifestId 由排除自身 id/时间字段的规范内容摘要产生。.harness/config.yaml 的 active 同时引用 bundleId 和 manifestId，是当前版本权威指针；私有 store 的 current 只是派生缓存。active 不作为配置三方合并的基线内容或 manifest 内的配置全文件摘要，避免 manifestId 与 config 摘要循环依赖；它的前后状态由激活日志单独记录。

### 3.4 结果与错误

所有 Module 返回结构化 Result：data、diagnostics、requiredInputs 和 provenance。需要用户补充是显式结果，不让模型或 Adapter 自行打开交互。

诊断至少包含 code、module、subject、evidence、retryable 和 suggestedAction。统一区分 invalid-input、unsupported、conflict、source-drift、missing-prerequisite、provider-failure 和 verification-failure；底层原始错误保留引用，不暴露凭据。

InstallationReport 分开列出配置生成、安装效果、接入验证、客户检查结果与待办。结果可为 complete、complete-with-pending、blocked、failed 或 noop；不能以 complete-with-pending 代表全部能力已经可用。

## 4. 应用层与安装生命周期

### 4.1 CLI 装配

命令仅面向安装：init、analyze、plan、apply、update、doctor、status、resume。status/resume 管理安装 run，不管理研发任务。

init/update 走同一应用用例，区别是是否存在已安装 manifest；analyze 在 M2 的研究阶段后结束，plan 完成必要语义候选生成及 M5 后保存可审阅计划，apply 校验计划后进入 M6，不临时调用模型补正文。doctor 使用只读 probe/verification，不自行修复；修复走新的计划。

独立模型与宿主 agent 是 M2 的两种 AnalysisProvider。宿主可通过结构化 request/result 或支持的安装会话传输回传分析；不安装一个与研发 skills 同级的配置 skill，也不留下日常依赖的脚手架 MCP。

应用层收集一次会话内的选择/授权范围。计划出现新写入目标、冲突或超出选择的动作才请求具体输入；无交互模式缺必填项就返回 requiredInputs。

选择变化或 probe 引入新的读取作用域时，应用层重新执行相关 Discovery/Analysis 并封存新输入；不能将旧分析与新配置拼接成一个已验证计划。

### 4.2 状态与存储

```text
discovered → analyzed → resolved → generation-planned → generating
generating → candidates-accepted → compiled → planned
planned → preparing → applying → verifying → activating → complete
                      └──────── blocked / conflict / failed
```

前半段是带持久 checkpoint 的研究/生成阶段，候选可恢复或重新计算；后半段是带日志的副作用执行。实际客户文件变化只发生在 M6；不能因有候选文件就报告安装成功。

应用层安装 session 只保存当前阶段及 generationRunId/planId/executionRunId 引用。resume 在生成阶段交给 M2，在 apply 后交给 M6；两者分别负责自己的 checkpoint，不能把生成 job 与安装动作混成一套副作用队列。必需候选未 accepted 时不能进入 compiled/可执行计划。

私有存储建议位于 Git common dir 的 harness/installer/，包含 sessions、generation、plans、runs、blobs、locks 和已验证来源记录。可提交的 config/lock/bundle manifest 是项目资产，恢复时要与实际环境对账，而非盲信本地 run 文件。

### 4.3 新老项目与缺失能力

新项目使用用户选择的通用模板，缺源码时知识生成/索引可 deferred；不编造 as-is，不生成业务测试。

老项目优先接线已有工具，提炼证据支持的规范，保留风格与模块差异。已有测试失败作为项目检查事实展示，不由 installer 修业务代码。

必需能力缺失使依赖它的 flow/动作 unresolved，不阻止无关模块产出计划。未启用的能力可以排除；用户选择的可选能力可以明确标记 pending。不得静默将必需能力降级为可选。

## 5. 交付、激活与更新

### 5.1 项目交付契约

```text
.harness/
  config.yaml                    # 用户选择及 active{bundleId, manifestId}
  lock.json                      # 上游和 adapter 版本
  project-profile.json           # 分析事实
  installations/<manifestId>.json # 不可变安装清单
  bundles/<bundleId>/
    manifest.json
    skills/
    runtime/
    bindings/
  changes/<changeId>/             # 研发产物，不属于 installer 所有权
docs/harness/                    # 使用说明与规范索引
```

宿主原生配置由 overlay 合并，引用版本化 bundle。Bundle 的运行依赖在 manifest 声明，脚本不得 import installer 包或调用 harness 二进制。上游工具自己的 CLI/MCP 属于独立依赖。

### 5.2 更新原则

M5 对旧 manifest、基线、当前内容和新目标规划合并；M6 安装并验证新 bundle，最后切换默认指针。运行中的任务保持原 bundle，installer 只读引用/依赖信息，不推进或重写研发状态。

停用能力通过显式 RetirementIntent 退役旧托管文件、selector 或注册项，不能把“本次未生成”直接当删除授权。未修改的对象可计划移除；用户已修改的对象保留并报告冲突。共享工具、旧 bundle 及仍被在途任务引用的入口不随停用自动删除，详见 M5/M6。

旧 bundle 不能独自保障共享依赖兼容。升级原生 skills、SDD CLI、共享 MCP 需验证在途版本约束；不兼容时并行安装，无法并行就延后该项更新。全局影响不明时不能推定为兼容。

主动迁移在途任务是单独项目操作。删除旧 bundle 需确认没有引用；第一版不自动清理无法证明未被引用的版本。

### 5.3 激活与失败

文件和工具动作按计划准备、写入与验证后，再激活新默认 bundle。宿主需要重启/重载时报告 refresh-required，不能用文件存在冒充宿主已加载。

单文件原子替换，多文件/远端效果使用 journal 和补偿；不承诺整体事务。默认指针、manifest 与 journal 的提交顺序及崩溃恢复由 M6 明确实现。安装失败时保留旧默认版本，列出已完成效果与恢复方式。

卸载脚手架 CLI 不删除项目 bundle、工具依赖或运行状态。用户可以自行维护项目资产，后续 update 按所有权与差异重新合并。

## 6. 模块细化与验收路径

内部设计按 M1 → M2 → M3 → M4 → M5 → M6 → M7 的文档顺序展开；其中 M7 是装配依赖，不是流水线末尾才发生的执行阶段。先固定上述 Interface，再实现各 Module，避免在 Adapter 中偷偷重建流程。

验证重点：

- M1/M2：证据、覆盖范围和输入漂移，不把猜测固化成事实。
- M3/M4：真实绑定、版本约束、确定性产物、无 installer 运行依赖。
- M5：所有权、基线、差异、冲突、动作依赖及更新兼容。
- M6：幂等、失败传播、恢复、激活与旧版本可用性。
- M7：四宿主、三框架及工具/客户接入的契约一致性。

采用隔离仓库和 Adapter 契约 fixture 验证脚手架自身。客户业务用例、测试体系和策略仍由开发者负责。所有版本兼容结论需在实施时针对锁定上游验证；本设计不宣称已经实现或测试工具兼容。

完整首版目标仍为四种 agent、三种 SDD 及选定工具接入。可先贯通一条纵向链路，但阶段演示不代表兼容矩阵已完成。
