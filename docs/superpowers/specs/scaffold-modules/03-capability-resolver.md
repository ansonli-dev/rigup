# M3 Selection & Capability Resolver：选项与能力解析

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 产生明确的绑定，不生成最终文件，不执行安装。

## 1. Interface

```typescript
normalize(input: SelectionInput, facts: ProjectSnapshot): Result<NormalizedSelection>
resolve(request: ResolveRequest): Result<Resolution>
```

ResolveRequest 包含 NormalizedSelection、AnalysisResult、ProviderCatalog、只读 Observations 和已有锁定版本。输出 providers、bindings、effectiveGates、资源意图、兼容约束与 unresolved。

Resolution 还提供 artifactSlots（声明必需/可选）、allowedSemanticKinds 和已解析能力约束，供 M2 第二阶段规划/生成。Resolver 不生成正文；候选正文也不能反向改变已经封存的用户选择、版本和 gate。

## 2. 选项归一化

普通选项优先级为：显式 CLI 输入 → 项目配置 → 用户选中的 profile → 产品默认。项目观察和模型建议只是候选，不覆盖明确选择。

平台不可放宽的限制是硬约束，不参与上述覆盖。冲突返回具体 requiredInputs，CLI 负责询问；Resolver 不发起交互。

对 agent、框架、工具和 flows 使用稳定 id；displayName 不用于匹配。重复选择去重，未知 id 报错。未选择 SDD 时仍可安装工具和 hooks；依赖 SDD 的 flow 需显式兼容绑定才能启用。

update 以完整归一化选择为目标；未提供的 CLI 参数沿用项目选择，只有明确关闭/替换才形成 clearedFeatures。编译失败、预算不足或暂未解析不是关闭信号，不得触发旧能力退役。

## 3. 内部结构与解析过程

1. SelectionNormalizer：合并来源，保留每个最终值的 provenance。
2. VersionResolver：使用现有锁定版本或用户明确更新的版本，选择落在支持区间内的 provider。
3. CapabilityBinder：把 flow 的语义需求绑定到真实技能、命令或客户能力。
4. DependencySolver：补齐声明的工具/运行依赖，检测循环、冲突和作用域不兼容。
5. ConstraintComposer：合成客户、宿主和上游的不可取消约束与 gate。
6. CompatibilityChecker：检查在途 bundle 的共享依赖约束，标识需并行或延后更新的项。
7. ResolutionSealer：生成排序稳定、来源可追踪的 Resolution。

同一能力存在多个 provider 时使用显式绑定或所选 profile；没有唯一选择就返回歧义，不按扫描顺序猜。新增传递安装项必须进入计划，不能以“解析成功”为由暗中安装。

## 4. 能力与 gate 规则

能力至少描述 id、provider/version、调用种类、产物角色、前置条件、读写效果和所需 gate。SDD 的 draft-spec、plan-work、implement-work、verify-work、close-change 是内部意图，映射可一对多或多对一。

只合并可由同一负责人、在同一时点、基于已就绪证据共同决定的 gate；不同职责、不同就绪时机或上游强制 gate 保留。安装期只编译这些规则，不执行研发审批。

缺失 required 能力进入 unresolved；optional 能力可明确省略。所选工具因无源码只能 deferred 时，记录它的实际状态；依赖其 operational 状态的 flow 不能谎称 ready。没有 GitLab 时可显式选择 local 交付，不能绕过客户必需远端检查。

## 5. 版本与兼容

常规 update 保持锁定依赖，工具升级是独立选择。已安装版本不支持时返回可选路径：保留该依赖、项目隔离并行、延后相关能力。

只读在途 bundle 的版本/依赖引用，不读取并推进研发状态。全局影响无法确认时不推定兼容；保留旧 bundle 不能补偿已被覆盖的共享工具。

政策与权威来源分别绑定。模型规范候选可进入文档，但只有明确配置、客户决定或已确认政策能产生阻断规则。

## 6. 错误与测试面

错误按对象返回 unsupported-version、ambiguous-provider、dependency-cycle、policy-conflict、missing-capability、incompatible-active-bundle 等具体诊断。解析纯函数不写客户文件、不修改锁。

验证选项优先级、版本固定、依赖循环、多个 provider、硬限制不能覆盖、optional/required 区分、无 SDD/GitLab 路径和共享依赖升级；同输入得到稳定绑定和同一诊断顺序。
