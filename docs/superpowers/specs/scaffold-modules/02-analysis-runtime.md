# M2 Analysis Runtime：项目研究与受控语义生成

所属：[总架构](../2026-11-02-smart-harness-design.md)。设计依据：[OpenWiki 源码研究](../../../research/2026-11-02-openwiki-analysis-generation.md)。

本 Module 在安装期研究项目、动态规划语义产物并逐项生成候选。它不执行安装、不写客户文件，也不在项目中保留常驻分析服务。M4 继续确定性编译，M5/M6 才规划和产生客户环境变更。

## 1. Interface 与两次语义活动

```typescript
analyze(request: AnalysisRequest): Promise<Result<AnalysisResult>>
generate(input: GenerationInput): Promise<Result<AcceptedArtifactSet>>

beginGeneration(input: GenerationInput): Promise<Result<GenerationRun>>
submitGenerationPlan(runId: string, proposal: ProposedArtifactPlan): Promise<Result<GenerationPlan>>
nextArtifact(runId: string): Promise<Result<ArtifactJob | GenerationQueueDrained>>
submitCandidate(runId: string, submission: CandidateSubmission): Promise<Result<AcceptedCandidate>>
finishGeneration(runId: string): Promise<Result<AcceptedArtifactSet>>
```

第一阶段 analyze 研究项目，供 M3 解析选择和能力。第二阶段在 Resolution 封存后运行：提出产物计划、逐项生成、提交接受。这样项目专属内容能引用真实 SDD、宿主和客户能力，而不是在绑定之前猜测命令。

AnalysisRequest 包含快照、归一化研究范围、语言/预算及可选的旧 GenerationIndex、SourceChangeSet。GenerationInput 还包含已封存 Resolution、AnalysisResult、可验证的旧候选引用及模板约束。应用层从已有安装清单取得这些只读输入，不要求 M2 读取并解释研发任务状态。

独立模型和宿主 agent 都使用这组生命周期语义。export/accept 可作为传输方式，但不能绕过计划、候选和持久化校验；两种模式不需要同样的工具或并发实现。

依赖 EvidenceReader、AnalysisProvider、GenerationStore、SchemaValidator。模型调用和结果属于本 Module；M4/Planner 不隐含调用模型。

内部 GenerationSessionCore 实现生命周期校验与持久化，NativeGenerationRunner 的 generate 串起模型规划、逐项生成和有限重试，HostExchange 只传递同一协议；CLI 不自行实现 job 选择/接受规则。队列 drained 不等于 finish 已成功。

## 2. 第一阶段：主动研究项目

1. 基于快照、选择范围、语言、prompt/provider 版本建立 researchId。
2. 先阅读 manifest、主要入口、明确规范，再追踪代表性端到端流程，核实调用关系、状态、失败、配置和集成。
3. 阅读相关测试及邻近实现，区分显式配置、普遍惯例、局部历史模式与建议。
4. 通过 EvidenceBroker 按需扩展读取，记录覆盖和预算；目录名或一个代表文件不等于理解整个系统。
5. 主要职责、行为和关系有证据后停止，不做穷举式全仓库阅读。
6. 返回 findings、unknowns 和 provenance；内容候选移到第二阶段，不由一次 AnalysisResult 包办。

EvidenceBroker 校验读取作用域、快照摘要、预算和 ignore。种子路径是起点，不是研究边界。无现成 OpenWiki/CodeGraph 时仍用原生代码读取完成研究，不能依赖尚未由脚手架安装的工具。

Finding 有稳定 id、分类、证据范围/版本及置信程度。没有证据或有矛盾的内容记为 unknown，不升级为已授权政策。缺少测试时报告缺口，不补项目测试体系。

## 3. 第二阶段：动态产物地图

M3 提供 artifactSlots、allowedSemanticKinds、绑定和限制。程序决定必需配置/流程段，模型在范围内决定项目专属内容的组织方式。

ProposedArtifactPlan 的每项至少包含：

- logicalId、kind、purpose 和所属必需/可选 slot；
- moduleScope、seedPaths、relatedArtifacts 和 dependsOn；
- 相关 findingIds、instructions 和允许引用的 capabilityIds；
- 内容 schema、完成条件、旧候选引用及生成预算。

固定机器产物（MCP 结构、宿主发现路径、工具参数、gate 结构）由 Adapter/模板生成；模型不重新发明。语义产物包括全局/模块规范、项目专属 references、流程上下文和客户接入说明。

例如，同一选择在单服务项目中可能只有全局规范和少量流程上下文；在 monorepo 中可增加订单模块、前端等有独立证据的规范片段。不是每个目录都生成一页，也不因动态计划增加新的公开研发 skill。

提交计划时检查 id/slot 唯一、必需 slot 覆盖、dependsOn 无环、种类和能力合法、产物范围受限。模型不决定任意绝对写入路径；M4 根据 kind/logicalId 分配可管理目标。

relatedArtifacts 是知识/导航关系，允许成环，不控制派发；尚未生成的邻居仅提供逻辑引用或明确标记的旧内容，不作为已验证证据。dependsOn 是需要当前正文的生成前置关系，必须无环，只有前置候选 accepted 后才能派发。汇总入口需要其他正文时显式列 dependsOn，不把所有邻居都转成前置任务。

已有语义产物需退役时必须提交显式 retireProposals，引用旧产物 id；遗漏不等于删除。它们只是候选意图，仍经 M4/M5 的范围、所有权、用户修改和计划审阅检查，不能删除原生配置或客户文件。

## 4. ArtifactJob 上下文与执行

已接受的 GenerationPlan 封存为持久 ArtifactJob 队列。计划在接收后不可悄悄替换；相同内容的重复提交幂等，不同内容需要明确新 revision。

每个 worker 只获得：当前 purpose、相关约束/能力、必要 findings、研究起点、相关已接受产物、旧内容及需要复查的证据。它可以继续追踪源码，但所有读取经过 EvidenceBroker，不获得客户目录写权限。

上述受限工具面由独立 Provider 直接实施；宿主已拥有的原生文件权限不能被本协议凭空撤销。宿主交换不提供客户写入操作，只接收结构化候选或私有 staging 引用；客户要求强隔离而宿主无法提供时，应报告该执行模式不满足要求。

候选只写入 installer 私有 staging/content store，或者以结构化正文回传。允许内容由 kind/schema 限定；运行命令、机器配置与强制 gate 使用已解析字段及受保护模板，不由模型自由 shell 生成替代。

首版两种模式都串行派发，每个 run 一次只接受一个生命周期变更。未来独立模型可增加 worker 并发，但不能把多 agent 并发作为兼容四宿主的前提。

job 状态为 pending、generating、accepted 或 blocked；同 run 保留 activeJobId，未完成时重复 next 返回当前 job，不跳过或重复派发。没有 active job 时只选 dependsOn 均已 accepted 的 pending 项，顺序由封存计划稳定决定。恢复时生成中的 job 回到可重试状态，先核对 accepted 记录再决定是否重跑；前置 blocked 不能被当成队列成功结束。

## 5. 候选提交与完成条件

CandidateSubmission 包含 runId、planRevision、jobId、正文、finding/来源引用、内容摘要和输入摘要。提交顺序：

1. 验证当前 job、输入、种类、结构、能力引用及来源版本。
2. 保存不可变候选 blob 和必要证据元数据。
3. 写 accepted candidate 记录，证明 blob/证据可读取。
4. 推进 job checkpoint；最后才返回 accepted。

“模型写好了”不等于 accepted，“accepted”也不等于已安装。重复相同提交返回既有结果；同 job 不同内容不是静默覆盖。提交落盘失败时 job 不完成，恢复时以 durable 记录和 blob 重新对账。

next 和重复 submit 都先对账候选记录、blob 与 checkpoint。若 blob/接受记录已写而队列推进失败，重试应补齐 checkpoint 后再确认完成，不能因发现一条记录就跳过状态收尾。

格式/引用错误在预算内修正。必需候选无法接受时不产生 requiredComplete 的 ArtifactSet；可选项只有按声明的缺失策略处理才可略过，并在报告保留原因。不得生成缺必需段的可执行 flow。

finishGeneration 校验启用产物所需候选完整、引用闭合、输入未漂移，然后封存 AcceptedArtifactSet 供 M4 消费。Schema 与来源校验不证明语义一定正确，仍需候选证据复核及最终计划审阅。

## 6. 增量、漂移与缓存

accepted 记录依赖：源文件/范围版本、相关 findings、Resolution、模板/adapter、选项与 provider/prompt 版本。安装后保留轻量 GenerationIndex，供下一次显式 update 比较。

跨次 update：先比较源与结构变化及配置/版本，复查受影响事实，再决定哪些产物需要研究/重生成。未受影响的候选可引用旧 blob；用户当前文件仍由 M5 合并，模型不把客户正文当作自己的生成基线。

证据变化是“需要复查”，不自动等于事实失效。复查后保留、修订或撤回相关 Finding；不能无意义重述所有未变化结论。只有依赖覆盖可靠且证据仍有效才复用；缺历史、浅克隆或索引不完整时扩大研究，不推断 noop。

活动 GenerationRun 中相关输入摘要变化时，首版保守使整个 GenerationPlan 失效并返回 planning；旧 accepted blob 可作缓存，但必须经新计划重校验，不能继续旧队列。精确到任意 job 的实时选择性失效不是首版承诺。

这一区分借鉴 OpenWiki：跨次更新可以有页面/证据粒度；活动 run 的 source drift 仍可以采用整计划重规划。这里不复制完整 Claims 平台或其 wiki 专用完成语义。

## 7. Provider、预算与恢复

GenerationStore 位于安装私有区，记录 session/run、计划、jobs、accepted refs 和 checkpoint，不归交付后的研发状态系统管理。关闭脚手架后不继续运行；resume 再重建当前安装会话。

预算区分研究、生成、格式/引用修正和总耗时。耗尽保留 accepted 候选与未解决项，不重跑所有成功 job，不将必需失败标为完成。缺凭据不自动切换未经选择的模型。

宿主交换绑定同一 run/plan/job；迟到或旧 revision 结果拒绝。独立模型可以使用受限工具，宿主使用自己的仓库工具，但候选只通过同一提交接受协议进入 ArtifactSet。

## 8. 测试面

除研究和越界读取外，增加：动态 slot 计划、重复 id/依赖环、必需 slot 遗漏、重复计划幂等、相同/不同候选重复提交、blob/证据/checkpoint 各落盘窗口中断、迟到宿主结果、必需失败不能 finish、源码漂移整计划失效、浅克隆/索引缺失回退和未影响候选复用。

相关导航成环应允许，dependsOn 成环应拒绝；前置 blocked 不可派发后继或误报 drained 成功。候选已持久化但 checkpoint 失败时，重试补齐状态而不重复生成或跳过收尾。

这些是协议/持久性测试；模型效果另用真实项目样例评估，不以 prompt 包含“动态生成”或输出几个文件名证明功能成立。
