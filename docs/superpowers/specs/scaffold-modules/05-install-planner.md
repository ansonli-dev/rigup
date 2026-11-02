# M5 Install Planner：差异、所有权与安装计划

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 决定具体要改什么，不执行这些变更。

## 1. Interface

```typescript
plan(input: PlanInput): Result<InstallPlan>
```

输入包括 DesiredHarness、当前 InstallationState、安装清单/基线和所选写入范围。依赖只读安装观察、MergeStrategy 和 provider 的声明式 ActionRecipe。

输出可以含 conflicts 和 requiredInputs；有未解决冲突时计划不可 apply。计划和候选内容由应用层保存在 installer 私有 store，不提前修改客户文件。

## 2. 内部处理顺序

1. StateCollector：读取实际目标、现有 manifest、基线 blob、工具与远端观察。
2. OwnershipResolver：判断文件、selector 和资源归属。
3. MergeEngine：计算目标 postimage，保留用户和第三方内容。
4. EffectPlanner：将资源意图转换为受支持的具体安装操作。
5. DependencyBuilder：形成有限安装动作依赖图，检测循环与不明写入效果。
6. PreconditionsBuilder：封存源内容、目标摘要、资源版本和作用范围。
7. PlanSealer：输出差异、动作、风险、验证与激活规格，计算稳定 planId。

## 3. 合并规则

记 B 为上次生成基线，L 为客户当前内容，N 为新目标：

- L 不存在且无 B：创建。
- L 等于 N：noop。
- L 等于 B：安全更新到 N。
- N 等于 B：保留客户修改 L。
- 三者不同：只合并不相交变更；相交内容返回 conflict。
- B 缺失且 L 已存在：不凭“generated”注释认领，要求明确接管或保留。

混合配置只比较拥有的 selector/标记块，其他键和注释保持。重复键、未知语法、损坏块或无法无损解析时返回冲突，不整文件重排或用正则猜测。自定义 skill 的源目录不被托管重写。

基线 blob 缺失时可从可验证的旧 bundle 找回；找不到就明确报告无法三方合并，不能用新生成内容冒充 B。

新目标没有某个旧对象时，仅在显式 RetirementIntent 覆盖该 owner/group/scope 后处理：L 不存在则 noop；L 等于 B 可计划移除；L 已修改或 B 无法恢复则冲突并保留，等待用户决定。混合文件只删除拥有且未修改的 selector/块，其他内容仍保留；不因只剩空结构就删除无法证明全量归属的文件。

共享工具不随注册项停用自动卸载，旧 bundle 不随入口停用自动清理。仍有在途引用的入口/注册项若会影响续跑，退役需延后或取得明确迁移安排，不能仅保留 bundle 就声称安全。远端资源退役还需可验证的本产品所有权、版本条件和 provider 支持，否则列为人工处理项。

## 4. InstallAction 与前置条件

每项动作有 actionId、provider、operation、resourceKey、dependsOn、effectKey、before/desired 摘要、argv/结构参数、作用范围、验证和补偿描述。禁止执行模型输出的自由 shell 文本。

典型 operation 为文件写入/合并、工具安装、工具初始化、明确远端配置和验证；目录创建、选中的 Git 初始化也是显式前置动作。

update 的文件移除、selector 解绑及受支持远端注册移除也是显式动作，携带原内容/版本、备份引用、删除后验证和补偿条件；不引入“清空所有未生成文件”的操作。

effectKey 绑定稳定资源身份和 desiredDigest，恢复换 runId 不改变它。Plan 前置条件覆盖相关源码、目标文件、工具版本和远端资源版本；只锁住 installer 不能阻止用户编辑，因此 apply 还要重查。

上游安装器若会修改未知位置，不能以“工具官方命令”为由跳过规划；需使用限定 scope 的入口、打印配置/可验证配方或报告该安装方式不支持可审阅变更。

## 5. 更新与激活计划

新 bundle 先准备，宿主 overlay 使用兼容入口，最后切换默认 bundle。config 的选择和 active 引用作为统一激活 postimage 规划，避免选择已变更但默认版本仍旧的半提交。

config 的普通托管 selector 使用三方合并；active 作为专用激活 selector，只按已读取的旧指针和 ActivationSpec 比较更新。安装清单不保存包含自身 manifestId 的 config 全文件 postimage 摘要，也不把 active 纳入配置基线 blob；完整目标摘要仅作本次动作前置条件/日志使用，避免自引用摘要循环。

新 manifest 记录新基线及资源结果；旧版本保留。依赖不兼容时按 Resolution 的隔离/延后策略生成动作，不在 Planner 临时决定升级。

manifestId 和远端新资源 id 可能直到执行后才确定。计划仅允许白名单内的类型化结果引用，把这些值写入安装清单/激活元数据；config 的预期目标以固定结构加该引用表达，执行器不能借此改变选择或动作范围。skill 正文、能力绑定和运行命令若仍缺少实际配置值，应在编译前补齐或重新规划，不能运行时任意拼接新内容。

安装图与研发流程不同：它只包含预先列出的安装动作，没有动态业务分支或 agent 调度。项目测试失败可记录验证事实，但不能产生“修复业务代码”安装节点。

## 6. 测试面

重点覆盖三方合并全部组合、结构 selector/注释保留、无基线接管、未知安装器副作用、重复 effect、循环依赖、路径越界、用户并发编辑前置条件和稳定差异。验证 Planner 执行前后客户环境没有变化。
