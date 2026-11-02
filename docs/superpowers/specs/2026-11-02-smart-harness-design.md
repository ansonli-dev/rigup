# 智能 Harness 脚手架：安装与更新设计

日期：2026-11-02。状态：待评审，未进入产品实现。

本文只设计脚手架本身：按项目现状和用户选择，生成、安装、验证和更新 harness。一次 setup/update 完成后进程退出，日常研发不依赖脚手架。

相关文档：

- [需求与约束基线](../../requirements/2026-11-02-smart-harness-requirements.md)
- [安装后的研发 skills 设计](2026-11-02-installed-skills-design.md)

安装后的 skills、hooks、检查配置、MCP 集成及辅助脚本是交付产物；它们运行在项目和 coding agent 中，拥有自己的使用与维护生命周期。本文不把它们的研发阶段当作 CLI 功能。

## 1. 生命周期与职责

### 1.1 生命周期分离

明确区分两条生命周期：

- 脚手架：发现项目 → 分析 → 选择 → 生成计划 → 安装 → 验证 → 退出。需要变更 harness 时再执行 update。
- 安装产物：被 coding agent、Git、项目工具和客户流水线加载，随实际需求持续使用。研发任务开始、暂停、恢复和完成均不要求启动脚手架。

两者通过版本化 HarnessBundle 和安装清单连接。脚手架生成交付包，不拥有运行中的研发任务；研发 skills 使用交付包，不调用本产品的 setup/update 能力。所选 SDD、OpenWiki、CodeGraph 等工具自己的 CLI/MCP 仍可作为产物依赖，它们不等同于本脚手架。

### 1.2 参考与设计取舍

- Anthropic 的长任务研究使用结构化交接及生成/评估分工，并在后续实验中删减不再必要的流程结构。本方案采用可恢复产物、显式完成标准和按需独立评估，不固定采用三 agent、sprint 或高频全量评审。[研究原文](https://www.anthropic.com/research/harness-design-long-running-apps)
- Harness Engineering 将事前引导和事后检测放在一起讨论。本方案让项目规范与真实检查相互关联，快速反馈嵌入研发循环，长期策略修改另行审阅。[文章原文](https://martinfowler.com/articles/harness-engineering.html)
- AI-native SDLC playbook 强调可衔接的产物、自动交接和必要的人类决策。本方案合并流程步骤，以审批和业务判断确定停顿点，并声明每项产物的权威来源。[Playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)

以下模块、skill 数量、状态模型与审批合并算法是针对本产品的设计，不是三篇资料给出的标准实现。

### 1.3 职责与默认值

脚手架自动化安装配置和已有能力接线。它不建设客户测试体系、不制定架构和业务规则、不替客户作发布决策。

生成的研发 skill 可以在开发者发起且授权的任务内修改业务代码、编写相应测试；这不扩大 setup/update 的职责。

本设计默认建议：TypeScript 实现、单 Git 仓库状态边界、项目级安装优先、每项目一个主 SDD 框架、macOS/Linux 先行。同项目可安装多种 agent。上述默认值仍待确认；跨仓库和 Windows 完整兼容不纳入首版承诺。

## 2. 安装 Core 与生成机制

### 2.1 Module 与 Interface

调用顺序：

```text
脚手架 CLI
  → Project Discovery
  → Analysis Runtime
  → Resolver + Bundle Compiler
  → Install Plan
  → Plan Executor
  → Bundle Manifest + Installation Report
  → 退出

项目内已安装产物
  → coding agent / Git hooks / 客户 CI
  → 原生 SDD、工具 MCP、项目检查与客户系统
```

Project Discovery 的 Interface 为 scan(root) → ProjectSnapshot。确定 Git 根、模块、已有配置、输入摘要与忽略范围，不调用模型、不改项目。

Analysis Runtime 的 Interface 为 analyze(snapshot, questions) → AnalysisResult。独立模式用模型运行时；宿主模式使用当前 agent 完成安装期分析。返回证据和候选内容，不直接安装。

Resolver/Bundle Compiler 的 Interface 为 compile(snapshot, analysis, selection, registry) → Compilation。解析宿主、SDD、工具和扩展差异，返回交付包与安装计划输入，无安装副作用。

Plan Executor 的 Interface 为 apply(planId) → InstallationReport。执行计划内的配置合并、安装、初始化和验证，管理幂等、冲突与恢复。

脚手架的安装状态只记录这一次安装/更新。研发技能的 Flow State、run lease、审批记录与发布候选由安装产物维护，详见另一份设计，不放入 CLI Core。

安装期可以复用宿主 agent 分析，使用结构化任务导出/结果提交，或宿主支持的临时安装会话 MCP 作为传输方式；它们调用同一 Core。会话结束后关闭，不作为日常研发的常驻依赖，也不注册配置用研发 skill。

### 2.2 分析与选项契约

以下为设计层类型，实际 schema 需要版本化：

```typescript
type ProjectSnapshot = {
  schemaVersion: number;
  repoId: string;
  root: string;
  head: string | null;
  inputDigest: string;       // 包含本次读取的未提交内容
  modules: ModuleFacts[];
  existing: ArtifactRef[];
  checks: CheckBinding[];
};

type AnalysisResult = {
  snapshotDigest: string;
  findings: {
    kind: "explicit-config" | "common-practice" | "local-pattern" | "proposal";
    statement: string;
    evidence: SourceRef[];
    confidence: "high" | "medium" | "low";
  }[];
  unknowns: string[];
};

type Selection = {
  agents: string[];
  framework: string | null;
  tools: string[];
  flows: string[];
  extensions: ExtensionBinding[];
  sourcesOfTruth: Record<string, SourceBinding>;
  policyRef: ArtifactRef;
};

type HarnessBundle = {
  bundleId: string;
  schemaVersion: number;
  bindings: ResolvedBinding[];
  files: GeneratedArtifact[];
  requiredRuntime: RuntimeDependency[];
};

type Compilation = {
  inputDigest: string;
  bundle: HarnessBundle;
  actions: InstallAction[];
  unresolved: Requirement[];
};
```

inputDigest 根据实际读取的源码/配置内容及选项计算，不能只用 HEAD。生成目录、本地运行日志、被忽略的大文件和凭据不进入语义分析输入。源码引用以仓库相对路径和必要范围表示。

事实与政策分开。已有显式配置优先；普遍惯例可形成规范候选，局部历史模式和建议改进不能自动成为阻断规则。

sourcesOfTruth 按需求、规格、实现计划和审批分别声明权威来源。仓库文件可以是正文或客户系统的工作副本，必须记录外部 id、版本和读取时间；源记录变更时重新检查，不能保留两个互不关联的“最终版本”。

### 2.3 安装期 Adapter

Agent adapter 提供 probe、render 和 validate：返回 skills 发现方式、入口文档、MCP 注册方式、项目/用户级范围、非交互运行和独立评估能力。Claude Code、Codex、OpenCode、Oh My Pi 分别实现；同项目共用事实和模板，分别渲染。

SDD adapter 提供 resolveCapabilities(version) 和 resolveArtifacts(change)：将语义动作映射为真实 skill、宿主命令或 CLI 操作，同时返回前置条件、原生产物和必须保留的人工决策点。

Tool adapter 提供 planInstall、planInitialize 和 verify；将安装程序、MCP 配置与项目初始化分成独立动作。OpenWiki 和 CodeGraph 不共用一个假设相同的初始化流程。

Environment extension 提供能力描述和入口，例如需求读取、MR 提交、CI 状态、评审意见、部署、状态查询和回退。每项声明读写效果、所需配置、作用环境、幂等键和结果格式。只有真实提供的能力才允许绑定。

Quality recipe 将用户选择的通用工具和既有检查生成对应配置，不实现业务检测语义。

适配器负责差异，Core 负责协议。不要求客户 skill 实现 TypeScript Interface。客户可导入普通 SKILL.md；需要流程调用时补充轻量能力描述并显式绑定。没有描述时只安装为独立 skill，不自动把它接入有副作用的阶段。

SDD 的最小内部能力集合为 draft-spec、plan-work、implement-work、verify-work、close-change。manifest 可将一个能力映射到多个原生调用，也可将多个能力合并到同一次原生操作；verify/close 等能力不存在时按具体 flow 的必需性报告 unresolved 或使用明确绑定的项目检查，不能发明上游命令。每个映射附产物角色、必需 gate 和受支持版本范围。

framework 为 null 时仍可安装知识工具、hooks 和独立客户 skill。脚手架自身 init/update 不依赖 SDD。change-prepare/change-deliver 需要所选框架或用户显式提供的兼容能力绑定，否则不安装这两个可执行入口；不隐式生成一套自有 SDD。change-release 可读取符合交付契约的外部候选，但仍需真实部署能力及动作授权。

### 2.4 研发产物的编译

内置 FlowSpec 是有序工作段及条件分支的模板，不是供用户编辑的 DAG 平台。它包含：

- 输入和产物角色；
- 内部步骤与所需能力；
- 执行范围、检查、循环预算；
- 人类决策条件及恢复入口；
- 对宿主能力的要求。

编译顺序固定：

1. 选择内置 flow，解析项目上下文和权威来源。
2. 解析所选 SDD 的版本、真实能力和原生产物。
3. 绑定客户系统、检查与部署能力。
4. 合成客户政策、平台限制和上游必需 gate。
5. 计算有效决策点，合并可以一起审阅的决策。
6. 渲染 SKILL.md、references、配置和必要 helper。
7. 校验无悬空引用、未绑定副作用、缺失必需能力或矛盾政策。
8. 输出安装计划和差异，不在编译中直接安装。

原生 skill 调用保留其必须遵守的约束。能通过上游支持的 preset/配置调整的行为由 adapter 显式适配；不可调整的原生 gate 在同一公开 skill 内暂停，不擅自跳过，也不因此新增公开入口。安装报告展示实际 gate 集合。

### 2.5 安装计划与事务

每个 InstallAction 至少包含 id、kind、dependsOn、目标、beforeDigest、desiredDigest、参数、验证方式和 idempotencyKey。kind 限定为文件合并、工具安装、项目初始化、明确的远端配置和验证。

文件先生成候选内容，再按所有权合并。全量托管文件三方合并，混合文件只改拥有的结构键/标记块，用户 skill 默认只读校验；工具内部状态只能通过官方接口维护。

每仓库在 Git common dir 的 harness/installer/ 下使用独立的安装写入锁。执行前校验输入和目标摘要，动作完成后记录后置条件。恢复先检查实际效果，尤其是包已安装、MCP 已注册或远端资源已创建的情况，避免重复副作用。

单文件原子替换，多文件使用日志和备份。外部调用不承诺整体回滚，失败报告列出已完成效果。无法证明所有权的文件不自动接管；缺失本地 state 时从锁文件、实际安装和远端状态重建。

## 3. CLI 安装生命周期

### 3.1 命令入口

脚手架入口是 CLI 命令，不是安装到项目的研发 skills：

```text
harness init [path]         # 首次接入
harness analyze [path]      # 分析现状
harness plan [path]         # 展示安装/更新计划
harness apply --plan <id>   # 执行计划
harness update [path]       # 更新 harness 配置及产物
harness doctor [path]       # 检查安装和集成状态
harness status [path]       # 查看安装任务
harness resume [path]       # 恢复中断的安装任务
```

status/resume 只针对安装任务，不查看或推进研发变更。init 串起分析、选择、计划和安装；update 重新分析后生成差异。配置好后无需继续运行 CLI。

### 3.2 执行过程与输入输出

输入：仓库、init/update 模式、目标 agents、框架、工具、所选研发 skills、扩展和已有用户配置。

连续执行：发现 → 分析 → 选项补齐 → 编译 → 差异计划 → 安装 → 工具初始化 → 接入验证。

输出：ProjectProfile、用户配置、版本锁、HarnessBundle、安装清单、宿主集成配置、检查接线、安装报告和开发者待办。业务代码、项目测试体系和研发任务状态不属于输出。

缺少影响结果的选择/凭据、配置冲突或超出授权的写入时询问用户；已有明确授权的同范围操作不逐项确认。无交互模式接受显式配置，缺少必填项时返回错误。

独立 CLI 的模型分析与宿主 agent 的分析是安装时的执行方式选择；不为此创建一个与日常研发入口同级的配置 skill，也不要求先安装完整研发环境才能初始化。

## 4. 交付包与更新契约

### 4.1 HarnessBundle

HarnessBundle 是两条生命周期之间唯一的交付契约。至少包含 bundleId、schemaVersion、模板/adapter/上游版本、文件摘要、已解析能力、所需运行依赖、检查绑定、技能入口和兼容性信息。

```text
.harness/
  config.yaml                  # 安装选择、默认 bundle 指针
  lock.json                    # 版本和来源
  project-profile.json         # 分析结果
  bundles/<bundleId>/
    manifest.json              # 交付契约和文件摘要
    skills/                    # 研发 skill 正文及 references
    runtime/                   # 需要时携带的独立辅助脚本
    bindings/                  # SDD、检查和客户能力绑定
  changes/<changeId>/           # 研发产物所有，不归安装清单管理
docs/harness/                  # 生成的使用说明和规范索引
```

宿主原生目录中的技能入口指向已安装的 bundle。新任务使用默认 bundle；续跑任务按 ChangeRecord.bundleId 加载已绑定版本。技能正文、辅助脚本和声明的依赖足以运行，不 import 脚手架安装包，不调用 harness 二进制或安装会话 MCP。

OpenWiki、CodeGraph、SDD 及客户系统保留各自目录和状态。本产品只管理已声明拥有的配置块和交付文件，不能将 .harness/changes、运行 lease、项目源码或测试纳入“可重新生成并覆盖”的安装产物。

### 4.2 更新、所有权与独立维护

一次 update 生成新 bundle、展示差异、验证后切换默认指针；保持旧 bundle 供在途任务续跑，不原地替换其运行中的 skill/脚本。活动任务仍需遵守最新权威平台政策，版本固定不等于冻结审批和权限规则。

manifest 同时声明上游原生 skills、SDD CLI、工具/MCP 及其他共享依赖的兼容约束。update 可以只读在途 bundle 的依赖引用来做影响检查，不读取并推进研发任务。共享依赖升级、原生 skill 覆盖和 MCP 配置修改必须验证兼容性；不兼容则使用项目隔离/并行版本，无法并行则延后该项更新。全局变更的影响范围无法可靠发现时，不推断为兼容或强制覆盖；只保留旧 bundle 不能作为共享依赖仍可用的证明。

安装清单只记录脚手架拥有的文件和配置块。用户修改执行三方合并；自定义 skill 默认保留。分析快照、工具安装与配置状态可以重新发现，研发审批、候选和进度不能由 installer 重建或重置。

主动迁移在途任务到新 bundle 属于单独的项目操作，需要兼容性检查和明确选择；update 不自动迁移。旧 bundle 的清理在确认没有在途引用后执行。

卸载本机脚手架 CLI 不删除已安装产物或其依赖。用户可直接维护项目文件和自定义 skills；重新使用脚手架时按所有权和差异合并，不能将这些变更当作可丢弃的临时状态。

## 5. 工具与反馈配置的安装

### 5.1 上游及客户能力

OpenWiki：安装与 MCP 注册后使用官方生命周期生成/更新 as-is，不改写其内部 Claims、索引或运行状态。GitLab include 调用已验证的非交互入口，使用独立凭据，过滤纯生成文档变化并串行更新，产出文档 MR。

CodeGraph：分别执行工具安装、目标 agent 注册和项目初始化，验证索引状态及 MCP 握手。本地索引不默认提交；无源码时记录 deferred。Pi 与 Oh My Pi 不混同，缺少原生安装目标时由实际宿主能力适配，无法满足则报告不支持。

SDD：以版本化 capability manifest 声明真实调用、产物角色和 gate。Superpowers、OpenSpec、Spec Kit 各自映射到同一组内部工作意图，但不假定它们拥有同名 skill、相同目录或等价审批约束。

客户扩展：读需求、提交 MR、查询 CI/CR、部署/回退分别可选。没有部署扩展时不安装可执行发布入口；没有工单集成仍可用人工输入。自定义 skill 的普通安装与有副作用能力绑定分开。

### 5.2 Hooks 与静态检查配置

安装先读取原 hook manager、core.hooksPath、现有 hook、包管理器和安装脚本。优先合并已有方案，避免重复管理器和覆盖原 hook；新工具仅按用户选择安装。

pre-commit 调用已选的暂存格式/lint 等快速检查；pre-push 调用既有模块类型检查、构建和快速测试；commit-msg 仅按客户消息政策接入。参考预算为 10/60 秒，超出则明确调整阶段，不把超时当通过。

检查对象必须正确：

- pre-commit 针对暂存快照，保留部分暂存与未暂存修改，覆盖删除、重命名和特殊路径。
- pre-push 根据真实 ref 更新确定范围，检查实际待推送内容；工作区不匹配时使用隔离快照，处理新分支和多 ref。
- hooks 可绕过，不能作为唯一远端门禁；每 clone 的安装与启用由 doctor 单独验证。

通用 formatter/linter、类型/编译、安全扫描可以接入现有配置或所选预设；专属架构检查只绑定开发者提供的命令。项目级类型检查不传入 lint-staged 自动追加的文件参数，不默认全仓库自动修复。

### 5.3 既有测试与 CI 接线

setup 只发现既有 runner、命令、环境要求和报告，并接入 hooks/CI/skills。缺失测试时报告输入要求，不创建测试目录、runner、fixtures 或测试环境。新项目同样遵守。

change-deliver 可按该需求已确认的范围新增/修复测试，属于研发，不是 setup 补齐测试体系。验收依据仍由开发者和项目政策提供。

同一 CheckBinding 定义 id、命令参数、cwd、环境引用、输入范围、阶段、超时、是否必需和报告解析器。执行时保留原始退出码，输出 pass、fail、error、skipped、not-applicable，后者需适用性证据。缺结果、零测试或全 skipped 不当作行为验证成功。

本地和 CI 引用相同真实项目入口。CI 为既有命令及所选通用检查生成 include，保留失败报告，不用 || true 或错误 allow_failure 吃掉失败。JUnit 上传不自动决定 job 状态；MR 合并条件由客户已确定政策和远端配置实施。

安装完成报告至少分别列出：配置生成、工具安装、hook 启用、命令调用验证、项目检查结果、远端门禁验证和开发者待办。业务测试失败不触发 installer 修改业务代码。

## 6. 脚手架的验收

### 6.1 安装与生命周期隔离

- 相同输入产生稳定 bundle，变更输入或版本后摘要变化。
- 四宿主/三框架的真实能力、额外 gate 和不可满足项在安装计划中可见。
- 工具安装、项目初始化、MCP 注册和可用性分别验证。
- 原有入口、skills、hooks、CI 和用户定制合并后保留；重复安装无重复项。
- 中断的安装可恢复；状态漂移导致受影响动作重新规划，安装锁防止并发写入。
- CLI 不在 PATH、安装会话 MCP 已关闭时，已安装研发 skills、辅助脚本及 hooks 仍可运行。
- update 切换新任务默认 bundle，但不修改在途任务状态和其已固定版本。
- 安装清单不拥有研发进度、审批和发布记录；不能通过更新恢复初始化它们。
- 项目缺少测试时只报告待办；项目检查失败与接入失败分别报告。

### 6.2 实施顺序

脚手架自己的测试使用隔离仓库和 fixtures，验证合并、绑定、状态、暂存区、退出码及报告，不向客户业务代码注入缺陷。客户测试用例和验收策略由开发者提供。

建议实施顺序是先贯通一个宿主、一个 SDD、一个 GitLab 接入的纵向链路，验证生成到恢复；再补四宿主/三框架矩阵和可选发布适配。完整首版仍按四种宿主与三种框架验收，不能将阶段演示宣称为全部兼容。

实现前锁定上游版本并验证实际路径、skill 调用、非交互能力和审批约束；库选择和内部文件拆分可以调整，不改变本设计的模块 Interface、产物协议和职责。

## 附录：参考与兼容性依据

- [Anthropic：Harness design for long-running application development](https://www.anthropic.com/research/harness-design-long-running-apps)
- [Birgitta Böckeler：Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)
- [Anthropic：The AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)
- [OpenWiki](https://github.com/langchain-ai/openwiki)、[CodeGraph](https://github.com/colbymchenry/codegraph)
- [Superpowers](https://github.com/obra/superpowers)、[OpenSpec](https://github.com/Fission-AI/OpenSpec)、[Spec Kit](https://github.com/github/spec-kit)
- [Git hooks](https://git-scm.com/docs/githooks)、[lint-staged](https://github.com/lint-staged/lint-staged)、[pre-commit](https://pre-commit.com/)、[Husky](https://typicode.github.io/husky/get-started.html)
- [GitLab unit test reports](https://docs.gitlab.com/ci/testing/unit_test_reports/)

本设计不把参考资料里的示例技术栈、角色数量和审批流程直接作为本产品默认值，也不把兼容性方向当作已验证的工具版本支持。
