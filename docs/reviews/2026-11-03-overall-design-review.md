# Rigup 当前设计与实施方案整体评审

日期：2026-11-03 首评，同日按用户要求修订，并再次完整评审、修复和复核。对象：当前工作目录中的现行文件，包含未提交修改与未跟踪文档；不是 Git HEAD 或差异评审。产品尚未实现。

## 当前开工判断与修订复核

**当前具备按九任务计划开工的条件，没有剩余应在设计期解决的实质矛盾或开工阻碍。** 初评 R1–R4 的修订继续有效；本次再次完整评审并直接修订 R5–R7，末次全量重读与 fresh-context builder-check 未发现重要遗留项。四宿主、三 SDD、两工具的范围保持不变，未增加模式平台、事务引擎或产品实现。此结论只针对方案和计划，不等于功能或兼容验收通过。

- **R1 已修订：** [Installer 外部写入保护](../superpowers/specs/scaffold-modules/03-rigup-installer.md) 将外部写入纳入同一所有权、候选预览和执行前后保护；声明路径不授权覆盖。
- **R2 已修订：** [Generator 旧库存规则](../superpowers/specs/scaffold-modules/02-rigup-generator.md) 逐项交代旧库存去向；[Installer 库存核对](../superpowers/specs/scaffold-modules/03-rigup-installer.md) 保留 ownership/可信旧 B，遗漏不授权注销，已知失效的活跃规则阻止完成。
- **R3 已修订：** [共享接口](../superpowers/specs/2026-11-02-rigup-design.md) 贯通 backend/analyze/generate 的 StepResult；同一 run 保存节点、已接受候选、累计预算和授权，pending-host 不生成部分可安装计划。
- **R4 已修订：** [Integrations 客户扩展](../superpowers/specs/scaffold-modules/04-integrations.md) 的显式本地标量模板与结构化 MCP 输入有消费者、摘要和三方保护，固定流程/gates 不被替换。

### 本轮完整评审 → 直接修订（第二轮）

- **R5 · P1，副作用与未决记录的崩溃窗口。** 原规则明确取消/阻塞位置，未要求派发前持久登记。远端接受后、本地记结果前被强杀，可能在普通缓存丢失后盲重试。[Installer 未决记录](../superpowers/specs/scaffold-modules/03-rigup-installer.md) 现在要求先持久记录再派发，已知结果先落持久终态，关联清单/进度对齐后才清理；无查询依据或写进程状态不明继续阻塞。[Task 7 故障注入](../superpowers/plans/2026-11-02-rigup-implementation.md) 覆盖登记失败、登记后未派发、已接收未记结果、已知结果未写 manifest，包含强杀后清空普通缓存。权威执行规则只放 Installer 第 4 节，总设计/CLI/兼容规则引用。
- **R6 · P2，候选通过不证明合并后的接线可用。** N=B 保留 L 或无文本冲突的 diff3 仍可留下缺失入口、断开的 reference 或绑定。[Installer 最终合并核验](../superpowers/specs/scaffold-modules/03-rigup-installer.md) 现在对最终虚拟项目及已核验的确定产出依赖做预览检查，保留 L 并报告具体阻塞；普通局部修改继续保留，不全仓重审，也不在 preview/apply 调模型。实际执行后提交基线前再检查接线，项目检查红与破坏接线分开。[Task 6 行为验收](../superpowers/plans/2026-11-02-rigup-implementation.md) 覆盖保留/合并死链、正常本地改动和待安装的确定产出；Task 7/9 接完整链路。此检查不声称证明宿主已加载或语义 gates 已实际遵守。
- **R7 · P2，局部测试提前依赖后续业务模块。** Task 3 原有多 job/CLI 恢复与 Task 5 安装后 update 的测试描述跨过尚未实现的 Generator/Installer；Task 4 也混淆 prepare 契约与执行前保护。[任务顺序约束](../superpowers/plans/2026-11-02-rigup-implementation.md) 明确前置任务只测自身契约，[完整 host 恢复](../superpowers/plans/2026-11-02-rigup-implementation.md) 和安装后连续 update 放 Task 7，真实输出及宿主验收放 Task 9；recipe 早期冒烟只在可丢弃测试环境，不调用不存在的产品安装器。

**本轮验证：** 末次由未继承本轮上下文的 reviewer 完整重读两份评审背景与全部 12 份现行需求/方案/计划/兼容文档，交叉推演后返回 “nothing important left”；当前会话另核对修订内容、共享契约、任务依赖与文件范围。静态检查覆盖 15 份现行文档的 142 个本地链接、锚点、引用行号范围、代码块和空白，检查通过；共享接口、九任务顺序和四个 pending 结论一致。报告开头的当前落点逐一核对到对应正文，历史行号仅保留为初评记录。未运行产品、真实模型、宿主或工具验收，四个独立结论继续 [pending](../compatibility/verification.md)。

本轮相对开始时的文件快照仅修改 10 份 Markdown：总设计、Generator、Installer、CLI、文档标准、实施计划、两份兼容文档及两份评审/交接文档；无新增或删除文件，原需求与其他既有资产保留。未写产品代码、脚手架初始化、安装依赖、执行上游/客户检查、暂存/提交/推送、回退/清理或新建 worktree。

## 本轮需求与契约核对

- 新旧项目、四宿主/三 SDD/两工具及客户扩展：Tasks 2–5/7/9 有实现与独立真实验收落点；无支持证据不能执行未知 recipe，unsupported 仍是原需求缺口。
- 确定性骨架、已有规范优先和模式补缺：总设计 1.1、Analyzer 2.0/2.1 与 Tasks 3/5/9 一致。原文不重写、不接管，范围/反例/不确定性保留，规则真正进入 agent、prepare、deliver、评审及已有检查。
- OpenWiki 流程与职责：初步研究足以规划即可，逐项补证/接受/恢复共用 backend/reader/预算；AS-IS 完全归 OpenWiki，不增备用生成器或 Claims 平台。
- 执行/维护：前置集中选择、host 同 run 多轮、语义缓存与完整目标摘要分开、整轮锁、停会话交接、旧库存逐项处置及三方保护均有任务；R5/R6 补的是崩溃窗口与最终合并接线。
- 安装后研发与工程反馈：原生 SDD 产物/gates、CLI 独立运行、实际提交/推送快照、GitLab 报告/防循环、客户部署条件和真实证据保持原范围。项目缺测试/环境不被伪装成验证完成。
- 计划顺序：九任务主线保留；前置纯契约不依赖后续业务，完整本地链路与真实兼容/生成分别记录。文档检查、实现与本地检查、真实动态生成、真实兼容、首版完整验收不互相替代。

## 初次评审结论（修订前，保留历史）

本节及以下原评审记录保留初评的问题描述、影响、建议和当时检查范围；其中行号属于初评工作目录快照，链接只导航文件，不再指向已变化的行。不能作为修订后现状判断；现行判断与准确修订落点见报告开头。

**有条件可开工。四模块和研究主线可以保留，但不建议按当前九任务计划未经收口就连续实施到底。** 本次发现 1 项 P1、3 项 P2 契约缺口。应在相关共享契约、Generator 和 Installer 业务实现前完成下列四项最小修订；Task 1–2 中不依赖这些裁决的 CLI、配置校验、只读 reader 和证据基础可以先开始。

必要前置修订是：把外部初始化写入纳入所有权保护；让重规划对旧托管资产逐项交代去向；明确 host 待回传如何穿过模块调用链；收口需求中“自定义模板”的支持含义和消费入口。它们不要求增加模块、Claims 系统、通用任务平台或新的主要持久协议。

四宿主、三 SDD、真实模型效果尚未核验，本身不阻止基础实施。它们必须按现有证据规则在对应接入实现和最终验收时逐项验证，不能把本次文档评审当成支持证明。

## 开工前需要收口的发现

### R1 · [P1] 外部 setup 的文件写入没有明确经过同一套所有权与差异保护

**位置：** [Installer:24](../superpowers/specs/scaffold-modules/03-rigup-installer.md)、[Installer:32](../superpowers/specs/scaffold-modules/03-rigup-installer.md)（32–42 行）；[实施计划:106](../superpowers/plans/2026-11-02-rigup-implementation.md)、[实施计划:162](../superpowers/plans/2026-11-02-rigup-implementation.md)。

现有 B/L/N 和配置范围编辑保护的是 Installer 写出的候选；外部 setup 则作为已声明写入范围的命令直接执行，出现在配置写入之前及工具初始化阶段。文档要求它不写未声明位置，却没有规定：**已声明位置内存在用户文件时，外部命令也必须服从所有权和当前摘要裁决。** 声明目录、锁定版本和获得初始化授权，均不能代替对已有内容的合并保护。

例如某初始化操作会写 agent 入口或项目配置：即使路径在 declaredWrites 内，直接调用仍可能绕过预览覆盖非托管内容；若它在 Installer 写入后再修改同一文件，还会使实际结果偏离已确认候选及新 baseline。这是现有执行契约允许的缺口，不是断言某个尚未核验的上游命令一定会覆盖文件。

**最小修订：** 在 recipe 规则和 Installer 执行规则中补一条统一约束。会生成项目文本的初始化优先由 prepare 产出候选，经过同一 preview/merge；无法预先取得内容的操作，只能在已确认的新空目标或已核验不会覆盖客户内容的范围执行。涉及已有受保护文件且不能安全拆分时，停止该操作，提供复用或人工接入方式。外部操作与候选目标重叠时明确顺序及执行后复核，不能只验证“文件存在”。不需要给每个上游建设通用沙箱或事务平台。

**修订落点与证明：** Task 4 的 operation 契约、Task 6 的预览、Task 7 的执行。用一个会在允许目录内覆盖已有用户文件的可控初始化命令，证明它在执行前被拒绝或转为安全候选；另覆盖初始化改写候选目标的情况。备份存在或执行后发现覆盖，不能算保护通过。

### R2 · [P2] 重规划只约束新清单，旧托管资产可能被遗漏后继续生效

**位置：** [Generator:34](../superpowers/specs/scaffold-modules/02-rigup-generator.md)（34–39 行）、[Generator:49](../superpowers/specs/scaffold-modules/02-rigup-generator.md)、[Generator:63](../superpowers/specs/scaffold-modules/02-rigup-generator.md)；[实施计划:51](../superpowers/plans/2026-11-02-rigup-implementation.md)（51–52 行）、[实施计划:122](../superpowers/plans/2026-11-02-rigup-implementation.md)。

输入变化会重建动态清单；校验关注新清单的重复、范围和必需项。同时正确规定“省略不授权删除”，但没有要求本次计划对 manifest 中旧的文档、入口块和 references 逐项作出处置，也未明确未被新清单提及的 ownership 必须保留。

因此，源码新增反例后，模型可能换了主题粒度或 logicalId，未再规划原先那份约定。旧文件既不能自动删除，也没有被要求重新核实，仍可能通过已有引用或宿主的目录规则加载而指导开发。若保存 manifest 时只记录本次候选，还可能丢失其托管记录。这会绕过“更新后结论应收窄/降级”的验收目标。

**最小修订：** 将旧 manifest 的托管资产清单作为更新上下文与最终完整性检查的输入；它是旧产物库存，不是独立规范证据。每个旧项必须明确继续维护、更新、提出退役，或因未知而保留并报告待处理。未明确退役不得删除，未处理也不得悄悄丢失 ownership。对已知失效且仍会自动加载或从本次入口到达的规则，先修正接入或阻止相关更新宣称完成。无需逐事实依赖图；全量核对已有托管项即可。

**修订落点与证明：** Task 5 与 Task 7。覆盖新清单漏掉旧项、logicalId/路径变化、已有引用仍指旧规则、旧项被用户修改四种情形；证明失效规则不会作为已完成更新的一部分继续生效，保留资产也不会失去后续保护。

### R3 · [P2] host 的 pending-host 结果没有可贯穿调用链的返回契约

**位置：** [总设计:91](../superpowers/specs/2026-11-02-rigup-design.md)（91–96 行）；[实施计划:55](../superpowers/plans/2026-11-02-rigup-implementation.md)、[实施计划:90](../superpowers/plans/2026-11-02-rigup-implementation.md)；[CLI:280](../superpowers/specs/2026-11-03-cli-interaction-design.md)、[CLI:288](../superpowers/specs/2026-11-03-cli-interaction-design.md)。

模块接口承诺 analyze 返回完整 ProjectProfile、generate 返回可安装 SetupPlan；Task 3 又要求 backend 在 host 模式返回 pending-host。缺少的不是请求摘要字段，而是它如何从 analyze 或某个尚未完成的 artifact-content 向上传到 CLI，且不被误装成部分成功画像、占位候选或普通失败。

宿主多轮会退出进程并在下次命令继续。只有 requestId 校验还不能确定哪些已完成阶段、当前 job、本轮剩余预算及仍有效的授权应该恢复。若各模块自行临时解释 pending，会在 Tasks 3、5、7 形成多套续跑逻辑。

**最小修订：** 选定一种内部暂停方式并同步几个接口：例如完成/待宿主的可区分返回，或由统一编排层捕获的专用暂停结果。名称和字段不必照此保留。规定待回传不产生可 apply 的计划；当前阶段/job、已接受候选、预算用量和本轮授权关联沿用现有私有缓存保存。重新入进程从该节点继续，同上下文复用，变更上下文失效；取消/失败后的新一轮仍按现有恢复授权规则处理。保持一个编排主线，不增加常驻服务。

**修订落点与证明：** 先同步 Task 1/3 共享接口，再由 Task 5/7 接通。至少走通“analyze 待回传 → artifact-plan 待回传 → 第一个正文已接受、第二个待回传 → 新进程续跑 → 预览安装”；断言退出 3、未写项目、未重复已接受任务、预算未重置及旧响应不能串到另一轮。

### R4 · [P2] 需求中的自定义模板尚无明确的支持含义和消费路径

**位置：** [需求基线:16](../requirements/2026-11-02-rigup-requirements.md)；[Integrations:48](../superpowers/specs/scaffold-modules/04-integrations.md)（48–54 行）；[实施计划:49](../superpowers/plans/2026-11-02-rigup-implementation.md)、[实施计划:104](../superpowers/plans/2026-11-02-rigup-implementation.md)、[实施计划:172](../superpowers/plans/2026-11-02-rigup-implementation.md)。

需求允许客户通过自定义 skill、脚本、模板和 MCP 配置接入环境。现方案具体覆盖了本地 skill 及资源复制、明确命令和 MCP/environment 引用；templates 目录却只描述产品内置模板，未说明客户模板由谁读取、在何时使用、如何决定目标和更新所有权。

把模板作为 skill 的 assets 原样复制，与让 setup 使用客户模板生成项目资产，是两种不同能力。九任务的自检目前将客户扩展视为已有覆盖，但未说明承诺哪一种，也没有对应的消费行为验收。“不建设模板编辑系统”不能自动回答这个范围问题。

**最小修订：** 明确一个最小路径。如果需求指随自定义 skill 携带、由该 skill 消费的模板，就写明支持边界并验证资源引用可用；如果指 setup 的客户产物模板，则补本地显式模板输入、受限参数/目标映射，仍走同一候选、所有权和三方更新。无需模板编辑器、远端市场或客户 JS/TS 安装插件，也不能允许模板替换固定 gates。相同地，客户 MCP 配置应在 Task 4/8 展示一次真实配置输入到宿主合并的例子，避免只留下文字“引用”。

**修订落点与证明：** 在共享选项和 Task 4/5 的扩展范围中明确采用哪条路径；给出客户模板被实际消费者使用的场景，而非仅断言文件复制成功。若选择暂不支持某种已要求的含义，应保留需求缺口并交由用户裁决，不能自行从基线删掉。

## 实施期必须核验，当前不要求另行扩建设计

以下是现有要求的实施检查点，不计入上述四项契约发现，也不要求在基础开工前取得全部外部证据。

1. **安装后缓存是否真的稳定。** [Analyzer:100](../superpowers/specs/scaffold-modules/01-project-analyzer.md) 与 [Generator:49](../superpowers/specs/scaffold-modules/02-rigup-generator.md) 已区分研究投影和完整目标摘要。Task 5/9 应把实际 SDD、OpenWiki、CodeGraph 初始化产生的文件也放入重复 update 场景，验证它们不会因遗漏生成区识别而让同项目不断重研究；排除目录又不能掩盖其中真实用户输入。对可读取的远端规范，缓存复用前仍须遵守 [文档标准:76](../superpowers/specs/2026-11-03-documentation-system-design.md) 的版本/新鲜度要求，本地指纹未变不能独自证明远端未变。

2. **验证失败与安装完成的提交点。** [Installer:35](../superpowers/specs/scaffold-modules/03-rigup-installer.md) 将验证放在 manifest 之前，通用失败规则又要求停止；[CLI:282](../superpowers/specs/2026-11-03-cli-interaction-design.md) 则明确选中的项目检查失败可以 installStatus=complete、退出 1。实现须按后者区分：配置/初始化失败或未知，和已完成接线后的项目测试失败。用完整 apply 场景验证测试红仍保存正确安装基线、返回检查失败，下一次不重复安装；不能只测报告渲染。

3. **host 更新当前宿主时的停会话时点。** [CLI:90](../superpowers/specs/2026-11-03-cli-interaction-design.md) 允许当前宿主多轮处理，[CLI:252](../superpowers/specs/2026-11-03-cli-interaction-design.md) 要求更新前结束相关会话。真实 host-update 冒烟必须说明先完成只读研究/响应、再结束会加载待改资产的会话、最后 apply/重载的操作顺序；若自动回传做不到，就作为该路径的明确待办。不能要求预检时结束宿主，随后又依赖同一已结束会话完成研究，也不能为了连续执行变成隐式热更新。不需要研发 lease。

4. **取消、锁与多进程缓存。** [CLI:286](../superpowers/specs/2026-11-03-cli-interaction-design.md) 已要求写进程退出前不释放锁。Task 7 的故障注入应真实验证子进程仍存活时第二次 apply 被阻止，远端 unknown 不重试。另核对两个进程在取得安装锁之前导出 host 请求或生成候选时，不能覆盖彼此的当前请求、已接受候选或授权关联；可以采用现有 runId 下的独立缓存或明确拒绝第二轮，不必增加通用调度器。普通生成缓存丢失不能被当作解除未决写进程阻塞的依据。

5. **语义质量与固定流程都要用行为证明。** [Analyzer:114](../superpowers/specs/scaffold-modules/01-project-analyzer.md)、[实施计划:201](../superpowers/plans/2026-11-02-rigup-implementation.md)（201–205 行）已有完整/部分/无规范、支持/反例、局部范围和真实 native/host 的验收要求，应照此执行。模型自报“已搜索反例”及同一模型复评不替代人工预标注事实复核。固定 skill 流程的测试还应输入含矛盾步骤或“跳过 gate”内容的语义候选，检查其实际组装与读取方式；只断言固定段落仍存在，不能证明消费者不会受到相反指令影响。必要时把可变正文收在被明确标注用途的 references 中。文字 skill 本身仍是引导，不声称成为宿主外部的权限强制器。

6. **上游可行性尽早验证，支持状态继续独立。** [兼容规则:9](../compatibility/README.md) 已允许基础工作先行，未核验 recipe 禁止执行；[验收状态:39](../compatibility/verification.md)（39–45 行）保留无 SDD 和 4×3 的逐组合核验。Task 4 宜先验证最小真实安装、skill 发现及 MCP 路径，再扩充模板内容，以尽早暴露框架/宿主不支持的组合。缺环境时继续独立本地工作，记录 pending；已证实不支持时报告原需求缺口，不自行缩减矩阵后宣布首版完成。此评审没有替这些项目填写版本或 passed。

## 非阻碍建议

**进度估算可以更轻。** [CLI:311](../superpowers/specs/2026-11-03-cli-interaction-design.md)（311–325 行）和 [实施计划:68](../superpowers/plans/2026-11-02-rigup-implementation.md) 对权重、采样和历史计时规定较细。准确计数、阶段、已用时间、等待对象、后续动作和是否需人处理才是首要可用性。无可比样本时显示“待估算”已满足真实性要求；可将完整历史估算留在同一任务的后段，避免阻塞核心研究/安装链路。25/40 等权重、三个样本、具体字段名和测试名都可调整，不属于用户必须保留的产品需求。

**不需要再加模式分析平台。** 当前支持/反例/范围等信息直接作为研究任务的提示、证据和接受要求，复杂度与问题相称。实现时可合并重复字段、让同一证据被复用；不应为保留所有设计术语而增加公开 schema 层级。R2 所需的旧资产核对也只使用已有 manifest，不要求恢复已移除的 Claims ledger。

## 整体一致性检查结果

- **确定性与 agent 边界：** 总设计 1.1 与四模块一致。CLI、静态发现、recipes、机器格式、脚本、固定 skill 流程、更新保护和执行结果归代码/模板；语义理解、缺口调查和受限正文归 backend。自定义 skill 原样复制，不由模型改写。主要待补的是 R1 对外部写入的具体执行约束。
- **规范优先复用且真正接入：** Analyzer 2.0、文档标准第 4 节、Generator 与 skills 均要求保留原来源/作用域，分别进入 agent、prepare、deliver、评审和已有检查。未把“文件存在”当成已理解，也未要求显式规范先得到多数代码支持。三条路径都有行为验收；R2 补的是后续更新遗漏旧接入的问题。
- **模式识别：** 比较同角色实现、排除机械复制、主动搜索反例、缩小范围、保留竞争模式与未知，和显式规范/惯例/局部参考/建议的分类相互一致。两个独立支持是候选下限，不被当成统计证明；不需要把它升级成固定产品阈值。真实识别正确性仍未验证。
- **研究方式与 AS-IS：** 初步研究足以规划即停止，逐 ArtifactJob 补证并接受私有候选，汇总最后进行；没有要求全仓研究先完成，也没有新增独立模式挖掘运行时。OpenWiki 是流程参考，非规范研究的必装内部 API 依赖；AS-IS 全归 OpenWiki，不可用也不生成备用 context/现状百科。
- **文档及研发生命周期：** 三类用途不强迫三个目录；setup 只补开发指南和所选 skills/必要 references，真实变更沿用原生 SDD/工单。安装后不依赖 Rigup CLI，不新增研发状态引擎。release 只在真实部署适配存在时生成，客户及上游 gates 保留。
- **CLI 与保护：** 前置集中选择、默认连续、可选审阅、真实 preview 绑定、JSON/TTY 分离、源输入变化与目标变化分开、取消后对账和不盲重试远端动作已有明确规则。缺口是 R3 的跨模块暂停契约；以上实施期检查验证这些文字约束能否实际同时成立。
- **计划与完成定义：** 九任务可覆盖主要主线，阶段依赖大体合理；Task 4 是接入版本证据的门槛，Task 5 不直接写项目，Task 6–7 统一预览/执行，Task 8 只接已有工程反馈。四种独立完成结论已明确，不以 transport mock、静态配置或模型连通性代替生成/宿主验收。R4 是目前未能从需求追到明确消费行为的扩展项。

## 检查范围与未验证项

初评先读取了 [本轮修改交接](2026-11-03-design-change-summary.md)，随后逐份完整阅读以下 12 份现行文档（初评快照共 1,412 行，修订后行数已变化），未以交接摘要或 Git HEAD 替代：

- [需求基线](../requirements/2026-11-02-rigup-requirements.md)。
- [总设计](../superpowers/specs/2026-11-02-rigup-design.md)、[安装后 skills](../superpowers/specs/2026-11-02-installed-skills-design.md)、[CLI 交互](../superpowers/specs/2026-11-03-cli-interaction-design.md)、[文档标准](../superpowers/specs/2026-11-03-documentation-system-design.md)。
- 四模块完整文档：[Analyzer](../superpowers/specs/scaffold-modules/01-project-analyzer.md)、[Generator](../superpowers/specs/scaffold-modules/02-rigup-generator.md)、[Installer](../superpowers/specs/scaffold-modules/03-rigup-installer.md)、[Integrations](../superpowers/specs/scaffold-modules/04-integrations.md)。
- [实施计划](../superpowers/plans/2026-11-02-rigup-implementation.md)、[上游核验规则](../compatibility/README.md)、[独立验收状态](../compatibility/verification.md)。

另完整读取了三份本地研究笔记（OpenWiki、CLI onboarding、mattpocock/skills）及既有 AI Native 设计审稿，用于区分历史建议与现行约束。检视了当前文件清单及 Git 状态，确认重命名目标和新增目录中的真实文件已纳入；未恢复已删除的旧命名文档。未发现本仓库及其祖先目录中有适用的 AGENTS.md/CLAUDE.md。

本次是静态设计评审。未开始产品实现，未安装依赖，未运行模型、宿主、MCP、初始化、GitLab 或产品测试；仓库当前没有可据以执行上述验收的产品代码。没有重新联网核验上游当前版本、接口或研究笔记所述机制，故不对这些外部事实作新增支持承诺。也未验证实际生成质量、真实耗时、兼容矩阵和用户修改保护的运行效果。

初评轮次唯一新增资产为本报告。用户随后授权修复问题，本轮修改了总设计、四模块、CLI、skills、文档标准、实施计划、兼容规则/验收清单与交接说明，并在本报告记录修订复核；没有修改原需求基线、安装依赖、实现产品、暂存、提交、推送、回退或撤销其他资产。当前开工判断见报告开头；真实生成、兼容与首版完整验收继续保持 pending。
