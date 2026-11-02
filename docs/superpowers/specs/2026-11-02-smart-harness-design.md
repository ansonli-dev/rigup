# 智能 Harness 脚手架设计

日期：2026-11-02。状态：待用户审阅；本文是产品与架构设计，不代表相关接入已实现或验证。

## 1. 产品定位与已确认需求

一个面向新老项目的智能 CLI，理解项目现状，按用户选择引入 coding agent 配置、知识工具、SDD 框架、流程 skills 和客户环境扩展。CLI 负责首次接入、重新分析与增量更新；持续研发由安装到项目中的 skills 驱动。

用户已确认：

- 新项目按默认体系起步；老项目从代码分析现状，形成代码规范与文档体系。
- 接入 OpenWiki 承载 as-is，配置 agent 的 OpenWiki MCP，并支持 GitLab 流水线自动更新。
- 接入指定的 [CodeGraph](https://github.com/colbymchenry/codegraph)，初始化项目索引并配置 MCP。
- 兼容 Claude Code、Codex、OpenCode、Oh My Pi 等 coding agent。“多 agent”指兼容多种工具，不是多 agent 并行协作。
- 首批支持 Superpowers、OpenSpec、Spec Kit，包装层主要串联原生能力和客户适配。
- 提供内置流程 skills，例如 spec-gen、code-gen、deploy；根据框架动态绑定原生 skill 或命令。
- 内置流程按需启用，用户也可以用自己的 skill；首版不建设流程模板编辑系统。
- core 与扩展分离；既有默认扩展，也允许用户通过自定义 skill 扩展。扩展可附带脚本、模板与 MCP 配置。
- 分析执行方式参考 OpenWiki，支持独立 CLI 与宿主 coding agent 两种入口。

以下具体技术、命令与默认策略是设计建议，尚非用户已确认的实现选择。

## 2. 范围与默认决策

建议使用 TypeScript / Node.js 实现 CLI 与 MCP，共享 core。外部工具仍使用自身运行环境；例如选择 Spec Kit 时按其受支持版本检查 Python / uv，不能假定所有依赖都能通过 npm 安装。

首版以单个 Git 仓库为安装与状态边界，识别 monorepo 中的模块；跨仓库编排后续再做。支持本机 CLI 与 GitLab CI 使用的无交互入口，优先验证 macOS / Linux，Windows 不在首版完整兼容承诺中。

每个项目选择一个主 SDD 框架，也可不选；允许同时配置多个 coding agent。切换框架重新生成绑定，不自动迁移在途规格；存在在途工作时先提示保留与迁移方案。

默认项目级配置。仅当目标 agent 或工具不支持所需项目级能力时，计划中明确列出所需用户级变更。不因安装一个项目的 harness 而默认配置所有已检测的 agent。

不建设自有 SDD 方法论、研发流程执行引擎、通用项目代码生成器或插件市场。新项目 setup 生成 harness 基础设施与明确标记的默认规范，不凭空声称有已实现架构；应用代码脚手架不属于本产品首版。

## 3. 执行方式与架构边界

### 3.1 两种入口共享一个安装生命周期

独立 CLI 通过可配置模型运行时完成语义分析和生成；模型凭据来自显式配置或环境引用。宿主模式安装 setup/update skill 与 MCP，由当前 coding agent 用自己的模型会话和仓库工具完成语义工作。

两种模式共享：项目画像 schema、选项解析、安装计划、持久化任务、产物校验、文件合并、适配器、更新与收尾。不能让独立 CLI 与 MCP 各自实现一套安装逻辑。独立运行不等同于必须再启动一个外部 coding agent 进程；具体模型运行时库由实现阶段选择。

MCP 在这里负责 setup/update 的受控生命周期与确定性操作。日常 spec-gen、code-gen、deploy 由 agent 阅读和执行安装后的 skills，不通过本产品 MCP 推进每个研发阶段。

### 3.2 Core

Core 负责仓库定位、结构化项目画像、用户选项、能力与依赖解析、版本锁定、计划生成与校验、任务状态、安装写入、冲突处理、增量更新与安装报告。

Core 不理解 GitLab、某个 agent 配置语法或某个 SDD 命令的全部细节，通过下列独立接缝调用：

- Agent adapter：检测目标 agent、读取已有入口、渲染 skills / MCP 注册方式、验证宿主能力。
- SDD adapter：安装受支持版本，发现原生能力，提供流程环节到真实 skill / 命令及原生产物的映射。
- Tool adapter：安装和验证 OpenWiki、CodeGraph 等项目工具，提供初始化和维护动作。
- Environment extension：项目管理、代码托管、流水线、CR 等客户系统接入方案。
- Analysis runtime：独立模型或宿主 agent，产出带代码证据的项目分析与候选内容。

适配器实现属于产品内部代码边界。用户自定义 skill 不需要实现 TypeScript 接口。

### 3.3 事实与决策分离

ProjectProfile 记录可观察事实及证据：技术栈、模块边界、构建/测试入口、格式与检查配置、CI、文档、agent 配置、规范候选、未知项。

HarnessConfig 记录用户选择：目标 agents、主 SDD 框架、工具、启用的流程入口、客户扩展、运行模式与安装范围。

BindingPlan 将二者转换成具体动作与产物。模型可建议，不能自行改变用户已选择的框架、目标 agent 或写入范围。

每个分析结论记录代码路径/范围、置信程度与分类：配置明文规定、代码普遍惯例、局部差异、建议改进。已有 formatter/linter 等明确配置优先；不把反模式或少量历史代码自动升级为团队规范。模块差异写到模块规范，证据不足标为待确认。

## 4. CLI 与安装生命周期

建议命令名暂用 harness：

```text
harness init [path]         # 新老项目首次接入，交互选择
harness analyze [path]      # 只读分析，生成可查看的分析结果
harness plan [path]         # 生成/刷新安装或更新计划，展示差异
harness apply --plan <id>   # 执行已确定的计划
harness update [path]       # 重分析并生成增量更新计划
harness status [path]       # 查看安装、任务与待处理项
harness doctor [path]       # 检查配置、依赖、索引与能力绑定
harness resume [path]       # 恢复未完成的安装/更新
harness mcp                # 宿主模式的 MCP 服务
```

init 为方便入口，完成发现、交互选择、分析、计划展示和安装；plan/apply 允许分步使用。无交互执行接受显式配置与结构化输出，缺少必填选项时返回明确错误，不挂起等待输入。命令名、参数细节可由实现者调整，产品语义需保持。

状态：discovered → analyzing → planned → applying → verifying → complete。任务可进入 blocked、failed 或 conflict，记录原因与恢复动作；不能因为文件已生成就宣称安装完成。

MCP 提供 begin、submit-analysis、submit-plan、next-task、complete-task、finish 等同等语义的操作；这是建议接口，不复用 OpenWiki 的命名空间。宿主提交候选事实、计划和内容，core 校验写入范围后落盘。工具安装/初始化通过持久任务执行，先检查后置条件再重试，避免重复副作用。

计划携带输入摘要、工具版本、目标文件摘要与动作清单。分析结束后源代码或目标配置发生变化，受影响动作失效，要求重新分析/合并后继续。每仓库同一时间仅有一个写入 run，读操作可并行。恢复须校验摘要，不能盲目重放旧任务。

## 5. 项目内产物与文档体系

建议的规范源目录为 .harness/：

```text
.harness/
  config.yaml                 # 用户选择，不含密钥
  lock.json                   # 工具、框架、适配器、模板版本与来源
  project-profile.json        # 项目事实、证据、未知项
  skills/                     # 本产品生成的规范 skill 来源
  extensions/                 # 用户导入的本地扩展
  state/                      # 本地 run、写入清单、上次生成基线；不入库
docs/harness/
  overview.md                 # harness 使用说明、入口与责任边界
  conventions.md              # 全局规范与模块规范索引
  integrations.md             # 客户系统接入与运维说明
```

入口文件和宿主原生 skills 目录由 Agent adapter 生成；路径不能硬编码为所有工具共用。OpenWiki、CodeGraph、SDD 框架继续拥有各自原生目录和状态。本产品记录调用与安装结果，不直接改写它们的内部数据库、元数据或运行状态。

OpenWiki 承载代码现状、架构、模块与操作事实；所选 SDD 框架承载目标需求、变更规格和任务；docs/harness 承载协作规范与接入说明。入口文档保持简短，以链接和执行入口为主，避免复制三份架构正文。

新项目允许 OpenWiki / CodeGraph 显示等待源码的明确状态；生成基础文档骨架，但不编造 as-is。用户选中的工具需要源码才能完成的步骤列为 deferred，安装报告显式展示，不能宣称已经完成代码知识构建。

## 6. SDD 包装与流程 skills

内置 spec-gen、code-gen、deploy 的模板是生成输入，安装后的 SKILL.md 是 agent 实际执行的产物。用户可全部不用，可选部分，也可把入口显式绑定到自己的 skill；不做模板设计器或通用 DAG 执行器。

模板包含目的、输入、前置条件、项目上下文、原生能力调用、客户扩展接入点、产物与完成条件。生成依赖项目证据和已选项，不能只做 skill 名称的文本替换。

SDD adapter 将语义环节映射成一项或多项原生能力。缺失环节不得伪造命令：可由内置包装补充普通操作，或明确显示不支持；涉及原生规格语义时必须保留框架约束。

- Superpowers：围绕其澄清、计划、实现、测试与评审 skills 串联；尊重原生设计确认等前置条件。
- OpenSpec：围绕所选版本的探索、提案、实现、归档能力串联，保留 openspec 原生变更结构。
- Spec Kit：围绕所选版本的项目原则、规格、计划、任务、实现与验证能力串联，保留其原生产物。

以上是映射意图，不是跨版本调用契约。安装时锁定受支持版本，发现实际 skill / command 和宿主调用语法；不存在的绑定让计划失败，不生成表面可用的 skill。

spec-gen 引入 as-is、代码关系与客户需求来源，调用原生规格能力。code-gen 接收原生产物，按项目规范实现并运行实际测试。deploy 调用客户代码托管/CI 扩展，支持提交、查看流水线与 AI CR、修复有依据的问题并重新验证。deploy 的名称不意味着默认拥有生产发布或自动合并权限；执行范围由客户配置、当前授权和平台规则决定。

包装 skill 引用原生能力，不复制上游整套正文。框架切换、能力签名变化或关键版本升级都需重新解析绑定。

## 7. 默认扩展与自定义 skills

建议首批内置 OpenWiki、CodeGraph 工具接入，以及 GitLab 仓库/流水线/CR 接入方案。项目管理先提供通用接入点与自定义 skill 示例；尚未指定 Jira、飞书等具体平台，不在首版默认承诺全部实现。

用户可导入一个标准 skill 目录，包括 SKILL.md，以及可选的 scripts、references、assets。无额外元数据时作为独立 skill 安装即可，不强行自动接入流程。

需要被流程引用时，用轻量扩展描述文件或交互配置声明：稳定 id、用途、输入/输出、所需配置、MCP/命令依赖、可提供的能力和引用入口。例如 customer-requirements、pipeline-submit、pipeline-status、review-fetch。名称冲突时要求显式绑定，不按目录扫描顺序覆盖。

用户通过“能力 → skill”配置选择覆盖内置实现。Core 只解析绑定和验证依赖；实际接入逻辑可保留在客户 skill 和脚本中。第一版支持本地目录导入，不建设远程市场、自动安装传递依赖或任意代码插件运行机制。

凭据使用环境变量/宿主配置引用，不写入可提交文档或 skill。所需变量缺失时标记接入未就绪；模板生成与接入验证分别报告。

## 8. OpenWiki、CodeGraph 与 GitLab

OpenWiki 通过官方安装和生命周期接入，复用它已有的知识生成、更新和持久化机制。不要再生成第二套与 OpenWiki 争夺 as-is 所有权的系统。

CodeGraph 的 CLI 安装、agent MCP 注册、项目索引初始化是独立动作。使用受支持的目标参数限定用户选择的 agent，初始化后验证索引状态与 MCP 握手。Oh My Pi 不能因为 CodeGraph 支持 Pi 就被认定原生支持；如无直接安装目标，由 Oh My Pi adapter 按其实际扩展/MCP 能力接入同一个服务，或明确返回兼容性未就绪。

GitLab 扩展生成独立的 OpenWiki 更新 job / include，按现有流水线结构合并，避免重写根 CI 文件。默认在目标分支代码变化后更新，产出文档 MR；过滤纯生成文档变化，避免自触发循环。同一分支串行更新，推送前检查源 revision，发生变化时重新生成。

CI 是全新环境，需要安装锁定工具并配置独立模型凭据；不能依赖开发者交互式 agent 登录。项目配置指定 OpenWiki 原生非交互运行或受支持宿主的无头模式；适配器需实际验证入口。仅生成 YAML 不能算流水线已验证，未提供真实 GitLab 环境时报告“本地配置检查通过、远端执行待验证”。

不把 CodeGraph 本地索引默认提交进 Git；本地通过自身机制维护，CI 如有需要独立构建，不共享开发者机器的运行状态。

## 9. 增量更新、文件归属与失败恢复

每项产物记录 owner、生成版本、来源、输入摘要、目标摘要和上次生成基线，区分本产品管理、上游工具管理与用户管理。

- 全量托管文件：基线未被用户修改时更新；已修改则三方合并，冲突保留用户内容并输出候选差异。
- 混合文件：只合并本产品拥有的标记块或结构键，保留其他配置及第三方标记块。
- 用户自定义 skill：默认只校验引用和依赖，不重写内容。
- 上游工具状态：仅调用官方接口，不越权覆盖。

本地 state 缺失时从实际安装与锁文件重建清单，无法证明所有权的已有文件视为外部文件，禁止直接接管覆盖。单文件原子写入；多文件变更有执行日志与备份。外部安装、远端调用不能承诺整体事务回滚，恢复报告需列明已完成副作用与剩余工作。

重复 apply 在输入不变时不产生重复配置；update 无实际变化时为 noop。工具升级只在明确更新工具版本的计划中发生，常规项目重分析不顺便升级所有依赖。

## 10. 验收场景与交付分层

最终首版覆盖上述四种 agent 和三种框架。开发顺序可先贯通一条纵向链路，再补齐兼容矩阵；阶段性实现不能被宣称为完整首版。

必要验收：

1. 空项目生成明确的默认 harness；没有源码时不生成虚假现状。
2. 未接入 AI 的老项目提炼有证据的规范，引入选定工具并分别验证安装、初始化与 agent 可用性。
3. 已有入口、skills、MCP、CI 的项目接入后保留原有内容。
4. 所选四种 agent / 三种 SDD 组合要么有可验证绑定，要么安装前给出具体不支持项；完整首版发布不以静默降级冒充兼容。
5. 同项目多个 agent 共享事实和选择，分别生成合法配置；一个 agent 的安装不覆盖另一个的配置。
6. spec-gen / code-gen / deploy 指向真实原生能力和客户扩展，可按用户选择关闭或替代。
7. 重复安装无重复项；修改生成文件后 update 保留修改或报告冲突；源码变化后仅更新受影响项。
8. 中断后从已验证后置条件恢复；并发写入被阻止，旧计划在输入变化后不盲目执行。
9. GitLab 更新闭环验证无凭据泄漏、无文档触发循环、能产生可审阅文档变更；没有真实环境时明确未验证范围。

测试以文件合并、任务恢复、绑定解析和真实工具集成为重点。外部 agent 与模型的兼容性需契约测试及受支持版本的冒烟验证，不能仅靠 mock 证明安装成功。

## 11. 上游依据与待实施验证

2026-11-02 查阅，以下支持接入方向，不代表已执行安装：

- [OpenWiki README](https://github.com/langchain-ai/openwiki)：独立 CLI 和宿主 agent 两种入口。
- [OpenWiki 架构](https://github.com/langchain-ai/openwiki/blob/main/openwiki/architecture/overview.md)：宿主语义研究与持久队列/校验/收尾分离。
- [CodeGraph README](https://github.com/colbymchenry/codegraph)：install 配置 agent，init 建索引，serve --mcp 提供服务；未据 Pi 支持推断 Oh My Pi 支持。
- [Superpowers README](https://github.com/obra/superpowers)：可组合 skills 和分宿主安装方式。
- [OpenSpec README](https://github.com/Fission-AI/OpenSpec)：原生提案、实施、归档工作流。
- [Spec Kit README](https://github.com/github/spec-kit)：SDD 流程与宿主相关调用语法。

实施前需要锁定各上游的具体版本，并核实四种宿主的项目级 skills、MCP、无交互能力与受支持调用方式；不在设计阶段凭经验固定未经核实的配置路径。实现者可自行选择内部包结构、模型运行时库、schema 库、CLI 交互库和测试工具，但不得改变本文的产品边界与归属原则。
