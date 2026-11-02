# OpenWiki 源码研究：项目分析与动态生成

日期：2026-11-02。研究范围：官方仓库 [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki)，固定提交 [b290e6915349c985dc1ea210ac4e8a6f6f7db5ef](https://github.com/langchain-ai/openwiki/commit/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef)，该提交 package.json 版本为 0.7.3。本次只阅读源码和测试，未运行 OpenWiki 或测试，也未验证实际模型效果。

本文区分上游已证实机制和本产品设计建议。重点是“如何研究后决定产物，并受控生成”，不将 OpenWiki 的知识产品生命周期移入脚手架。下文的设计差距指本轮源码学习前的版本；已采纳的修订以模块设计文档为准。

后续复杂度评审已将脚手架收敛为项目分析、配置生成、安装更新、工具集成四个模块。本文第 7 节中的 M1—M6 是当时的旧编号，保留用于说明研究过程，不代表当前仍需这些独立模块或完整协议；现行方案见[简化架构](../superpowers/specs/2026-11-02-smart-harness-design.md)。

## 1. 主要结论

OpenWiki 的动态生成不是从目录名直接套固定 Markdown 模板。它先让 planner 研究真实系统并提出产物结构，再把语义计划规范化为持久 PageJob；每个 worker 围绕自己的主题继续研究、编写和提交，确定性核心接受提交、维护证据与状态，最后执行确定性收尾。[规划提示词](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-prompts.ts#L62-L104)、[计划规范化](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/page-jobs.ts#L123-L224)、[执行主线](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L363-L416)。

对本项目最有价值的是建立显式的“研究 → 动态产物计划 → 按任务生成 → 提交接受”协议。当前 M2 只有整体 AnalysisResult/DocumentDraft，M4 主要是确定性模板编译，缺少这段协议。建议在 M2 中补足，M4 保持纯组装，客户文件的最终安装仍经过 M5/M6。

## 2. 已证实：先研究系统，再决定页面结构

planner 被要求先阅读 manifests、主要目录、入口和公共表面，再追踪有代表性的端到端控制/数据流，包括调用者、状态、失败、配置和集成，最后用相关测试和邻近实现核实。停止条件是主要系统/行为/关系已有证据，而不是穷举每个文件；信息架构围绕系统职责与跨系统流程，而不是照抄源码树。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-prompts.ts#L68-L104)。

每个提议页面提供 path、title、purpose、seedPaths、relatedPages 和 instructions。seedPaths 是研究起点，不是阅读边界；只有与该页有关的全局要求进入其 instructions。init 需要 quickstart，导航由确定性生成的 index 辅助；quickstart 被排序到领域页面之后生成。[计划字段](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/page-jobs.ts#L23-L55)、[规范化及排序](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/page-jobs.ts#L123-L224)。

这是一份模型提出、程序校验的产物计划，不是让模型直接决定任意安装命令。重复路径、生成/删除同一路径、init 删除和删除 quickstart 都会被拒绝；update 会补入必须处理的 Claims 或语言重写任务。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/page-jobs.ts#L129-L189)。

## 3. 已证实：任务上下文和写入权限有明确边界

页 worker 获得自己的 purpose、seedPaths、相邻页面、相关 instructions、目标语言、已有页面状态，以及当前需要处理的 Claims；更新先读原文并保留未受影响的准确内容，研究可沿调用关系和测试扩展。只有 quickstart 获得完整页面地图用于导航汇总。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-prompts.ts#L138-L209)。

原生 runner 为 planner 和 page worker 分别创建受限 agent，禁用委派；planner 只有规划完成工具，页 worker 有 Claims 查询和提交工具。页 worker 的 backend 明确设置 writableWikiPages 为当前 job.path，同时做 docs-only 与 ignore 限制，而不只在 prompt 中说“别改代码”。[planner](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L512-L541)、[worker 写入范围](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L934-L951)、[page worker](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L998-L1046)、[backend](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/docs-only-backend.ts#L579-L600)。

因此，生成任务的可控性来自“定界上下文 + 可写范围 + 提交协议”，不是单靠一个宽泛的总提示词。

## 4. 已证实：提交接受后才算完成

submitRepositoryPlan 先规范化并写持久状态，再更新内存；相同语义的重复计划可重试，不允许悄悄替换已经持久化的不同计划。nextRepositoryPage 只派发 pending job，并只附需要注意的 Claims，完整 Claims 按需查询。[计划提交](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L957-L999)、[派发](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L1067-L1103)。

submitRepositoryPage 要求页面可读，修复/校验 frontmatter，再在串行 mutation 中 reconciles Claims、落盘并证明该页证据状态 durable，记录页面完成 manifest，最后推进队列 checkpoint。已完成 job 的重复提交是幂等的。其他 pending 页不会被当前页的 finalize 改写为中间态。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L1288-L1428)。

测试实际注入 Claims 写入失败，断言内存与磁盘 job 都仍为 pending，重试成功后才完成；另有 page-manifest/checkpoint 失败及并发提交测试。这些是协议持久性测试，不是模型输出快照。[失败与重试测试](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/test/generation/repository-run.test.ts#L1287-L1351)、[并发测试](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/test/generation/repository-run.test.ts#L1593-L1687)。

原生页 worker 未成功提交时会恢复原始页/Claims 快照，再有限重试；仍失败可跳过并保留以后更新的机会。不能把“agent 已写出正文”直接视为完成。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L884-L921)。

finish 拒绝尚有 pending 的队列；跳过页必须提供原快照。最终执行删除、索引/frontmatter/Claims 等确定性收尾，最后才删运行状态。源码漂移或跳过工作会保留 interrupted 更新元数据，因此 finish 的 complete 不应被理解成所有页面都已覆盖最新源码。[finish 条件](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L1618-L1655)、[收尾顺序](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L1665-L1759)。

## 5. 已证实：增量关注证据与页面自己的进度

源码 fingerprint 不只是 HEAD：它纳入 tracked、可见 untracked、Git 状态和实际源内容，并排除生成区与 ignore 路径；读取失败是正确性错误，不直接当作内容消失。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/utils.ts#L309-L390)。测试覆盖 staged/unstaged、删除、untracked、symlink 和生成区排除。[测试](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/test/agent/repository-source-fingerprint.test.ts#L201-L425)。

Claims preflight 重新解析已有证据：缺失/无法解析标为 unresolved，版本变化标为 stale。clean Git 状态不足以 noop，必须没有 Claims 问题且具有完整基线覆盖。[preflight](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/claims/brains/code/preflight.ts#L40-L107)、[noop 条件](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L475-L525)、[对应测试](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/test/generation/repository-run.test.ts#L586-L681)。

稀疏 reconciliation 自动保留未受影响的当前 Claims；每个 stale/unresolved 必须明确确认、修订或撤回，不能省略；相同声明不会被模型无意义重写。整页最终至少保有一条实质 Claim。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/page-jobs.ts#L402-L518)、[稀疏更新测试](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/test/generation/page-jobs.test.ts#L264-L357)。

每页有自己的 committed baseline，planner 获得分组 update windows。基线提交在浅克隆中不可读时 fullReview=true，不冒充“没有变化”；测试确认原基线不会被快进覆盖。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L877-L947)、[浅克隆测试](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/test/generation/repository-run.test.ts#L983-L1036)。

需要特别区分：**恢复活动 run 时，发现源码 fingerprint 变化，上游删除整个 plan 并回 planning**；不是逐 job 自动选择性保留旧计划。细粒度 update windows/Claims 与活动 run 的保守失效属于不同层。[源码](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/generation/repository-run.ts#L634-L705)。

## 6. 已证实：原生与宿主共用核心，但能力不完全相同

原生 runner 与 HostSessionManager 都调用 beginRepositoryRun、submitRepositoryPlan、nextRepositoryPage、submitRepositoryPage 和 finishRepositoryRun。宿主使用自己的研究/文件工具；核心负责持久队列、校验与收尾。[原生入口](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L363-L416)、[宿主桥](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/integrations/core/session-manager.ts#L128-L215)。

原生 runner 有受限并发页 worker 池和限流后降并发；宿主 session manager 每次只允许一个 lifecycle operation，并验证 active runId。共用协议不意味着共用并发运行方式；宿主 begin 也没有传入原生的 planningContext 字段。[原生池](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/agent/repository-runner.ts#L633-L790)、[宿主保护](https://github.com/langchain-ai/openwiki/blob/b290e6915349c985dc1ea210ac4e8a6f6f7db5ef/src/integrations/core/session-manager.ts#L278-L315)。

## 7. 对本项目的设计建议（不是上游既有功能）

### 7.1 M1 保留确定性 Discovery，研究范围由 M2 主动扩展

M1 的文件索引、快照和 EvidenceReader 合理，应作为研究工具底座。M2 不应只依赖 M1 的目录/manifest 事实来一次生成所有规范；应明确代表性调用链、失败路径、状态与相关测试的研究任务和停止条件。

### 7.2 M2 拆成两次语义活动

第一阶段研究并形成 facts、unknowns 和待选择事项，供 M3 解析能力。M3 版本/能力绑定完成后，第二阶段动态提出产物地图并逐 ArtifactJob 生成。建议任务包括 logicalId、kind、purpose、seedPaths、relatedArtifacts、instructions、inputDigest、验收条件和已有内容引用。

固定机器配置仍由 Adapter/模板产生；规范、模块说明、项目专属 references 和选定流程的上下文由语义 worker 按计划定制。动态不等于随意增加公开 skill 或创造未绑定命令。

### 7.3 M4 保持确定性，但输入应是已接受的语义产物

当前 M4 只编译 AnalysisResult/模板，可能退化为“描述动态，实际填模板”。建议它读取已接受的 ArtifactSet；只做能力替换、路径/引用校验、宿主投影和封包。模型不直接写客户项目，可写 installer 私有 staging，由 M5/M6 执行最终合并安装。

### 7.4 增量用事实依赖，先保守处理运行中漂移

建议记录 Finding/Artifact 对源证据、模板、adapter、用户配置的依赖；显式 update 中定位需要重研究/生成的内容，未受影响产物可复用。源码变化不应触发模型改写所有准确内容。

这属于本产品建议，不是上游活动 run 的逐任务失效机制。首版可先在 run 中漂移时保守重规划，只有证明依赖完整后再做安全的细粒度复用；不能宣称七模块已有一个尚未设计的精确影响图。

### 7.5 生成协议与安装协议分离

ArtifactJob 的完成是“候选内容和依据已验证并持久接受”，不表示已经安装。M6 的 journal/activation 仍只处理客户环境副作用。模型输出不能直接认领文件所有权、产生远端动作、删除旧产物或改变客户政策。

宿主/独立模型共用这套分析和生成协议，但仍属于脚手架安装会话；脚手架退出后，交付 skills 独立运行，不引入永久 setup MCP。

## 8. 不应直接照搬与研究限制

- Claims 是事实知识页的专用结构，不适合把全部 CLI 配置、skill 指令和客户策略逐条套入事实 ledger。先采用有限的证据/依赖记录，别先建设完整知识平台。
- 上游 worker 实际直接写受限 wiki 页；本产品应继续使用私有候选区和 installer 合并，不能照搬为直接覆盖 AGENTS.md、hooks 或客户配置。
- 不把上游 native 并发池复制为多 agent 产品要求。宿主兼容与并发调度是两回事，首版可串行生成并先证明提交/恢复正确。
- 不照搬目录 taxonomy、quickstart 必选或文档完成状态码；本产品产物和成功语义不同。
- 本次读取了关键实现与测试断言，但未执行测试、模型任务或安装；源码链接说明机制，不证明现实生成质量和兼容矩阵。
