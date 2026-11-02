# M4 Bundle Compiler：交付包编译

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 把已解决的意图变为内容，不判断当前文件可否覆盖。

## 1. Interface

```typescript
compile(input: CompileInput): Result<DesiredHarness>
```

CompileInput 包含封存的 Resolution、AnalysisResult、AcceptedArtifactSet、模板版本和输出语言。依赖 TemplateCatalog、各宿主 Renderer 及内容 schema；不依赖客户 WriteWorkspace、安装命令或模型。启用产物的必需候选未 accepted 时拒绝编译，不用模板占位文字补成成功。

DesiredHarness 包含版本化 bundle、宿主 overlay 意图、资源意图和验证意图。InstallAction 由 M5 产生，不属于 bundle。

对 Resolution 中显式关闭的能力，输出 RetirementIntent，按 owner/group/scope 描述需要退役的旧注册项，不猜测具体删除路径。M5 结合旧安装清单展开；unresolved 或未生成的内容不隐含 retirement。

动态产物地图中的 retireProposals 仅能引用旧托管语义产物，经种类/范围检查后转为待审阅退役意图；不等于功能关闭，也不能移除机器配置、必需 slot 或客户文件。M5 仍执行所有权和用户修改检查。

## 2. 内部编译阶段

1. ContextBuilder：将已确认事实、已接受的语义候选、所选能力和权威来源投影为模板上下文；校验候选与本次 Resolution/源指纹相符。
2. FlowAssembler：展开内置 flow 的有序工作段，注入 SDD 原生调用和客户接入点。
3. ConstraintEmitter：附上有效 gate、检查和恢复约定，不抹去上游前置条件。
4. AssetRenderer：将语义正文/上下文片段组装进 skill/references 和说明文档；机器配置、命令、检查绑定及 helper 仍从已解析字段和受保护模板生成。
5. HostProjector：通过宿主 Renderer 产生 agent 入口、skills 发现/MCP 配置的 overlay 意图。
6. BundleValidator：检查引用、声明和内容完整性，拒绝悬空命令与缺失必需依赖。
7. BundleSealer：规范化、排序、计算摘要，输出不可变目标内容。

内部 FlowSpec 由产品内置，客户可替换 skill 入口，不建设通用流程编辑器。研发技能的详细执行协议见独立设计，Compiler 仅实现该协议的模板生成。

项目专属内容和文档粒度在 M2 动态规划/生成；本 Module 不负责模型研究。由 relatedArtifacts 生成允许相互引用的导航关系；派发顺序只取决于 M2 的 dependsOn。封包时校验逻辑引用可解析，对缺失可选邻居按模板声明省略导航或报告 unresolved，不能保留悬空链接。只把固定模板换几个变量不构成这里定义的动态生成。

## 3. ArtifactIntent 契约

每项内容带 logicalId、owner、scope、target、content/patch、mergeStrategy、sensitivity 和输入 provenance。scope 为 project、选中的 user scope 或 bundle-relative；不接受模型直接给出的任意绝对写入路径。

overlay 可声明 replace、managed-block 或结构 selector 等合并意图；当前文件是否属于本产品、是否需要冲突处理由 Planner 决定。Renderer 不能读取当前文件后自己落盘。

规范正文与可执行约束分开。没有项目测试入口时生成缺口说明，不生成 runner、业务测试或虚构脚本。CodeGraph 关系信息不编译成未经开发者定义的架构规则。

## 4. 摘要与路径

bundle 内部使用相对引用，不将自身 bundleId 写回待计算摘要的内容。先对规范 manifest（排除 id/时间）和相对路径内容计算 bundleId，再生成外部宿主入口对该 id 的引用，避免自引用摘要循环。

目标路径统一规范化，禁止越出已选择根或覆盖客户源码。路径冲突、重复 logicalId 和相同 selector 不同内容是编译错误，不按模板顺序覆盖。

使用固定换行和排序；运行日志、模型费用和生成时间不进入身份摘要。给定同一 CompileInput 和 Renderer 版本，输出字节和 bundleId 一致。

将 GenerationIndex 随安装 provenance 交给 M5/M6：每个已安装语义产物关联候选摘要、来源/finding、模板、adapter 和选项版本。复用必须能读取相符的旧候选 blob，私有缓存丢失时可以重新生成，不能从用户已修改正文倒推“原始生成基线”。

## 5. 独立运行约束

manifest 声明 helper、工具和宿主依赖。生成脚本不能 import installer 包、调用 harness CLI 或依赖安装会话 MCP。上游 SDD/工具本身的 CLI/MCP 可以依赖，但必须已解析并锁定。

本产品生成的公开研发入口仅负责项目研发；setup/update 不混入该清单。客户未选或能力未满足的入口不作为可执行成功产物输出。

## 6. 测试面

固定输入进行快照/结构测试，验证不同宿主投影、不同 SDD 能力组合、未绑定引用、相对路径、gate 保留、非英文内容和稳定摘要。对生成脚本做独立依赖检查，并在无 installer 的隔离环境执行其最小协议；不靠文本包含几个 skill 名称证明流程可用。

增加已接受候选丢失/过期、必需 slot 未完成、相关产物引用断开、错误 Resolution、动态语义正文与固定机器字段分离及退役建议范围测试。
