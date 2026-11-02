# M1 Project Discovery：项目发现

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 只观察，不生成规范、不运行项目检查、不安装工具。

## 1. Interface 与依赖

```typescript
scan(request: ScanRequest): Promise<Result<ProjectSnapshot>>
read(ref: SourceRef, snapshotId: string): Promise<Result<EvidenceChunk>>
```

ScanRequest 包含目标目录、允许读取的配置作用域、排除规则、扫描预算及本次目的。依赖 ReadWorkspace、GitRead、ManifestDetector；不依赖模型、Compiler 或 Executor。

ProjectSnapshot 包含 RepoIdentity、文件索引、模块事实、已有检查入口、配置引用、inputDigest 和 coverage。文件内容按需由 EvidenceReader 读取，不把整个仓库一次塞给模型。

## 2. 内部结构与处理顺序

1. RootLocator：规范化路径，解析实际 worktree、Git common dir、HEAD；区分 .git 目录、worktree 的 .git 文件和无 Git 目录。
2. InventoryBuilder：枚举 tracked 和允许的 untracked 文件，合并显式配置探测路径；应用排除规则，不遍历依赖缓存、二进制和本产品生成区。
3. ManifestDetector：读取包/构建 manifest、工作空间配置、CI 和已有 agent 入口，形成模块与工具链候选。
4. CheckExtractor：只提取已有脚本/构建任务的名字、argv/入口及来源，不在 scan 中执行它们。
5. EvidenceIndexer：登记每次实际读取的路径、字节摘要和范围，形成可重查的证据集。
6. SnapshotSealer：排序并规范化事实，计算摘要，记录预算截断与访问失败。

隐藏目录不能一概排除，否则会漏掉 agent、hooks 和 CI 配置；必须使用明确规则。对选中的用户级集成，只读取允许的已知配置位置，不扫描整个用户目录；敏感字段只留下引用或脱敏后的存在性事实。

## 3. 新项目与非 Git 状态

空 Git 仓库是正常输入，head 为 null。尚无 Git 的目录可以分析，repo 状态为 uninitialized，commonGitDir 暂空；安装需要 Git 时由用户选择初始化，Planner 才产生显式 git.init 动作。

不存在的目标目录以“拟创建目录”描述，读取仅限可验证的祖先路径，不提前 mkdir。目录创建与 Git 初始化都属于 Executor。选择不初始化 Git 时可输出分析和计划，首版依赖 Git 的持久安装被标为缺少前置条件。

## 4. 证据与快照规则

Git 路径、工具/检查入口和文件内容分别记录。HEAD 不代表未提交内容；同一 HEAD 下配置变化必须改变对应摘要。

增量扫描可复用未变内容，但 mtime/size 只用于加速，计划前置条件仍使用内容摘要。SourceRef 指向仓库相对路径、内容摘要和可选行范围；行号只定位，不替代内容身份。

coverage 至少区分 complete、budget-limited、access-limited，列出未扫描区域及原因。未读取的模块不能得到“无测试”“无规范”等确定性结论。未知文件类型保留索引事实，不伪装成已理解。

## 5. 失败与恢复

根目录无法定位返回 invalid-input；用户要求作用域外路径返回 scope-denied；单文件不可读是局部诊断，可继续其他观察。关键 manifest 读取失败时下游必须收到 unknown，不能回退到猜测。

每次 read 校验快照中的内容摘要，漂移则返回 source-drift，由应用层重新扫描受影响部分。扫描缓存可丢弃，不拥有客户文件和研发状态。

## 6. 测试面

隔离 fixture 覆盖空仓库、无 Git 目录、worktree、monorepo、未提交配置、隐藏配置、符号链接越界、预算截断和不可读文件。验证扫描前后客户文件一致，脚本未执行，同输入规范化摘要稳定，源文件变化会拒绝旧证据读取。
