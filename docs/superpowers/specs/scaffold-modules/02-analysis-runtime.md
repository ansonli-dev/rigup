# M2 Analysis Runtime：语义分析

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 提供带证据的解释与内容候选，不决定最终选择或执行安装。

## 1. Interface

```typescript
analyze(request: AnalysisRequest): Promise<Result<AnalysisResult>>
exportRequest(request: AnalysisRequest): AnalysisExchange
acceptResult(exchangeId: string, result: ProviderResult): Result<AnalysisResult>
```

AnalysisRequest 包含快照引用、已归一化的分析范围、内容语言及预算。依赖 EvidenceReader、AnalysisProvider 和私有 ResultStore。export/accept 是宿主回传方式，不是安装后的公开 skill。

## 2. 内部结构

- ResearchPlanner：按本次选择确定研究主题，例如规范、文档结构、现有接入条件，避免分析无关系统。
- EvidenceBroker：对模型的路径读取请求做作用域、预算和快照摘要校验。
- ProviderSession：运行独立模型，或导出结构化任务等待宿主返回。
- ResultNormalizer：把自由文本整理成 Finding、DocumentDraft、Unknown 和 provenance。
- EvidenceValidator：校验引用存在、摘要匹配和字段完整性；不会自动证明语义结论正确。

独立模型和宿主 agent 都实现同一个分析协议；二者产生的结果进入相同校验，不因“来自当前会话”而跳过验证。

## 3. 调用协议

1. 根据 snapshotDigest、分析范围、prompt 版本和 provider 配置建立 requestId。
2. 优先读取 manifest、明确规范、入口和代表性调用/测试，再按实际问题扩展研究。
3. 每个新增读取通过 EvidenceBroker，登记实际内容与预算。
4. 输出结构化候选，不允许用模型正文充当安装命令或控制流程的返回值。
5. 校验所有引用及结果 schema；可修复格式错误在预算内重试，语义未知保留 Unknown。
6. 重新检查参与结论的输入，漂移时废弃受影响结论或重跑，不接受混合时间的“完整快照”。

宿主交换包含 exchangeId、snapshotDigest、目标问题、证据访问约束和结果 schema。等待宿主不是后台常驻服务；会话关闭后可从安装私有存储恢复 request/result。

## 4. 输出分类

Finding 必须分为 explicit-config、common-practice、local-pattern、proposal，附 evidence、confidence 和受影响模块。显式配置冲突不自动合并为一条“统一规范”。

DocumentDraft 是候选规范/说明内容，附事实引用和未决项；不是客户业务规格或测试。M3 只将有明确政策来源的项目约束用于门禁解析，不能把一个高 confidence 建议当成授权。

缺少测试、环境、文档或权限时输出缺口及所需输入，不生成项目测试体系或模拟一个已有运行环境。

## 5. 缓存、预算与错误

缓存键包含输入摘要、研究范围、模型/provider、prompt/schema 版本；同键的历史结果可复用，但重新运行模型不承诺相同正文。Compiler 的可重现性建立在固定 AnalysisResult 上。

预算包含读取量、调用量、总耗时和重试次数。耗尽返回 partial 与未解决主题，不报告分析完整。凭据缺失返回 missing-prerequisite，不自动换用未经选择的外部模型。

原始结果和调用诊断保存到 installer 私有存储，默认不写项目；日志不包含密钥或完整宿主会话。客户源码是证据，不获得指挥安装器的权限。

## 6. 测试面

使用可控 Provider 验证：越界读取被拒绝，引用不存在/摘要不匹配被识别，乱序/重复宿主结果不会覆盖已封存结果，预算中止仍保留未知项，建议不能直接变成安装动作。真实 Provider 另做少量契约验证；不以模型措辞逐字相同作为正确性条件。
