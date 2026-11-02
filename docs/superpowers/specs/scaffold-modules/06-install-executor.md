# M6 Install Executor：执行、验证与恢复

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 是安装链唯一的客户变更入口，不执行研发任务。

## 1. Interface

```typescript
apply(request: ApplyRequest): Promise<InstallationReport>
resume(runId: string): Promise<InstallationReport>
inspect(runId: string): InstallationRun
```

ApplyRequest 引用不可变 planId 和已确定的作用范围。依赖 InstallStore、WriteWorkspace、ActionDriver、VerificationDriver 和进程控制。调用方不能在 apply 参数中临时追加任意命令。

这里的 InstallRun 从可执行安装计划开始，M2 的 GenerationRun 属于前置候选生成，不混入动作 journal。apply/resume 只读取封存候选/blob，不调用 M2 临时补交付正文；候选不完整或输入过期时退回相应前置阶段。计划中明确声明的 OpenWiki 等原生工具初始化可执行其自己的生成生命周期，与本产品候选生成分开记录。

## 2. 状态与 Journal

run 状态为 preparing、applying、verifying、activating、complete，以及 blocked/conflict/failed；单项动作有 pending、started、succeeded、waiting、failed 和 unknown。

开始副作用前记录 actionId、effectKey、before 状态与意图；完成后记录资源 id、postcondition 和证据。超时不直接等于“动作没发生”，先标 unknown/waiting，恢复时查询。

锁使用 Git common dir 的 installer 命名空间。无 Git 项目的预安装 run 位于平台私有缓存，以规范化目标根加锁；显式 git.init 完成后转入 common dir，迁移前后持有目标根锁。已有 Git 的同一路径也先取目标根锁，worktree 再共用 common-dir 锁。旧缓存仅在迁移提交后标记转移，不删除恢复证据。

## 3. 执行顺序

1. 加锁，加载原 plan，重查输入、目标和资源前置条件。
2. 创建同文件系统 staging 与日志，准备不可变 bundle，尚不切换默认指针。
3. 按依赖顺序执行工具/资源动作和非激活 overlay；每个动作写入前重查其目标。
4. 执行接入验证并记录客户检查结果，整理尚需刷新/环境的项目。
5. 达到 ActivationSpec 的就绪要求后进入激活；否则保留旧默认 bundle 并报告具体原因。
6. 激活后做必要的入口一致性检查，提交最终 journal/report，释放锁并退出。

第一版默认串行执行变更动作；只读独立验证可以受限并发。不因性能需要放松动作依赖或锁范围。

WriteWorkspace 只允许计划列出的目标，原子替换前再检查预期摘要。合作的 installer 受锁约束，外部编辑不受该锁控制；检测到漂移即冲突，不承诺跨所有编辑器的文件系统事务。

初始 inputDigest 在首个副作用前验证；后续前置条件按已完成动作的声明 postimage/结果引用演进。计划内的 mkdir、git.init 和配置修改不会被误判成外部漂移；未声明的源内容变化仍需阻止受影响动作，不能把所有差异都视为自己造成。

## 4. 验证与就绪

VerificationResult 分开标识 integration 和 project-check：

- integration：配置语法、依赖存在、工具初始化、MCP 注册/握手、hook 启用及调用路径。
- project-check：已有 lint、构建、测试的实际结果；失败不授权修改业务代码。

每个选择项声明最低就绪要求 configured 或 operational。需要宿主重启才能握手时记录 refresh-required；最低 configured 的安装可 complete-with-pending，但不得报告 operational。必需 operational 未满足时不激活依赖它的 flow；不能事后降低要求。

模板/接线本身的失败是安装验证失败。已有业务测试失败单独报告，不等同于接线失败。无源码索引、无远端环境、缺凭据等 pending 有明确对象和后续动作，不汇总为全部成功。

## 5. 激活提交与崩溃窗口

先持久化不可变 InstalledManifest，再记录 activation-prepared（旧 active、新 bundleId/manifestId、config 预期摘要），最后原子替换 .harness/config.yaml 的激活 postimage。bundle 和被引用 manifest 必须先存在，config 中 bundleId 与 manifestId 同次发布。

InstalledManifest 写到 .harness/installations/<manifestId>.json。执行结果只能填入计划声明的元数据结果引用；manifestId 计算后据此物化 config 的激活 postimage，其他字段必须与已封存计划一致，不在激活时重新做模板生成或业务选择。

manifest 的规范摘要排除自身 id/时间字段，其配置基线只含非 active 的托管 selector。config 全文件最终摘要只写入激活日志，不反向进入该 manifest；因此可以先封存 manifest，再计算 config 内容，而不存在哈希自引用。

config 是默认版本的权威指针，私有 store 的 current 仅为派生缓存。若崩溃发生在 config 切换后、最终 journal 前，恢复者读取 config 和 manifest 验证已激活，不重复安装。若切换前崩溃，旧指针保持有效。

若激活后入口一致性检查失败，只在 config 和相关托管目标仍等于本次写入结果时执行计划内补偿；存在用户新修改则报告冲突，不强行回滚。旧 bundle 和旧 manifest 保留，便于恢复旧指针。

## 6. 外部动作与补偿

ActionDriver 必须支持 probe/reconcile，不能只提供 run。包已安装、索引已创建或远端资源已存在时验证 desired 状态后复用。远端创建使用 effectKey 和平台版本条件；重复请求先查询实际结果。

自动补偿只作用于本次拥有、仍保持 postimage 的资源。共享全局工具升级、上游生成和远端操作不承诺全量逆操作，报告已完成副作用及人工处理项。

删除/解绑按计划校验旧摘要与所有权，先保留恢复所需基线，完成后验证缺失或解绑状态。恢复不能重复删除一个已被用户重新创建的对象；补偿仅在目标仍保持本次删除/解绑结果时恢复旧内容，发现新内容则冲突而不覆盖。远端删除同样先 reconcile，不猜测重试是否安全。

取消/信号先停发新动作，记录在途状态，向受控子进程传播取消；远端动作可能继续，下一次 resume 必须对账。官方工具需要宿主完成初始化时使用 waiting 和结构化回传，不把它变成研发工作流。

## 7. 测试面

在每个 journal/文件提交窗口注入中断，验证 resume 不重复外部效果、指针不悬空、旧版本可恢复、用户编辑不被补偿覆盖。覆盖 Git 初始化迁移、MCP 刷新、configured/operational 区分、项目检查失败、远端超时但实际完成、锁冲突与损坏 store。
