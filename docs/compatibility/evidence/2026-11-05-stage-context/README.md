# 按阶段选择上下文：真实 Bulletproof React E2E

**完整语义 E2E 通过，保持 12 请求 / 1200000 observed token 预算。** 默认 Codex 实际执行 analyze → plan → content → acceptance，合计 **4 请求 / 341053 token**，较[上一轮仅省略锁文件的 558605 token](../2026-11-05-context-budget/README.md) 再减少 **38.95%**。本轮未修改模型响应、切换模型、禁用 SDD 或重置消费。两轮历史结果（包括最初预算失败）均逐字保留。

## 固定对象与阶段测量

实际使用源码 `e9aa1e4` 的 npm 包、独立消费目录和官方 OpenSpec 1.16.0。上游仍为 [Bulletproof React 的同一提交](https://github.com/alan2207/bulletproof-react/tree/9506629ed003a561c6627735480cce4994244bb4)，应用仍选 `apps/react-vite`。研究 scope、4000/24000000 读取预算、Codex 默认模型、OpenSpec、review 交接及两工具配置全部不变。[包摘要与实际版本](tool-versions.json)、[完整命令/选项/ledger/报告](bulletproof-semantic-e2e.json)、[汇总](summary.json)。默认模型的服务端 ID 未暴露，不作推断。

- **analyze：**178 条库存路径、177 个正文来源、352080 字符；保持原有有界扫描，锁文件正文不发送。请求 426812 字节。
- **plan：**28 个来源、165989 字符，较上一轮少 **52.85%**；请求 254438 字节，少 **45.69%**。使用研究引用与必要指令/原生门禁/清单，保留旧生成库存作为比较上下文，去掉重复 profile.files 和无关后端字段。
- **content：**15 个来源、117902 字符，少 **66.51%**；请求 201459 字节，少 **55.97%**。当前 job 的来源、种子、关联闭包及相关结论、反例、冲突和门禁可见，其他任务/主题不重复发送。
- **acceptance：**15 个来源、117902 字符，少 **66.51%**；请求 206823 字节，少 **55.55%**。独立检查候选与任务、来源、反例及门禁；候选中的有效本地来源链接可补入证据，不能越过读取库存。

后三阶段合计正文从 **1056240** 降至 **401793 字符**，减少 **61.96%**。真实用量依次为 **136166、77006、66346、61535**。所有尝试均为 observed；独立 apply、无变化更新和用户说明保护没有增加模型调用。数字为本次默认模型的实际 input+output 观察值，不重复加计 cached input；输出差异也会影响 token，用量变化不是固定价格或延迟保证。Codex 的已知限制仍是返回后检查用量，单次可能先超额再拒绝。

## 证据与恢复保护

`stage-evidence-v1` 保留完整库存、全局源码指纹和明确的未提供来源列表；库存不是已读正文。精确引用的行号/摘要保留，模型不能从省略推断不存在或声称验证未提供内容。缺失 topic 时按直接来源、范围及门禁处理并披露不完整性，不把所有未命名主题混成一组。相关产物可成环；生成基线仍只用于比较。

原输入摘要及选择摘要绑定请求与接受来源，阶段字段不进入共享 host 运行上下文。Codex adapter 3 的交换记录使用独立版本目录，同一 root/run 的累计 ledger 键保持不变，v1/v2 的已知消费继续累计，未知或耗尽消费仍阻止发送。手工 host 默认不变。选中片段从过滤读取层重新物化并与请求严格比较，自行重算摘要的额外正文也不能混入；这些本地读取仍计入读取预算。

策略回归包括 [初始 RED](context-red.txt)、[缺失阶段](invalid-stage-red.txt)、[缺失 topic](topics-red.txt)、[投影](projection-red.txt)、[实际 Codex prompt 的回退失败](prompt-red.txt) 及 [38 项 GREEN](context-green.txt)。[本地完整回归](local-regressions.txt) 为 **329 项：315 passed、14 opt-in live skipped、0 failed**；类型检查和 [68 文件打包](pack.json) 通过，包中无测试、证据、scratch 或客户状态。

## 真实流程、源码与应用

- review 返回具体预览，再由独立进程 apply；无变化 preview/apply 写入 0 文件，用户添加的 deliver reference 说明保留。CodeGraph 受保护初始化完成；未规划或调用 OpenWiki 初始化，长流程仍由用户独立运行。
- [来源抽核](source-audit.json)与[片段复核](snippet-verification.json)：本轮全部 **177 个唯一片段**重新经实际过滤读取层逐字/摘要验证。534 个原跟踪文件字节不变；AGENTS.md 仅增加托管导航，原正文逐字保留；6 个原生 OpenSpec skill 未改。
- [实际生成正文](generated-api-review.md)为 `docs/rigup/react-vite-api-cache-review.md` 的逐字存档，链接按该原路径解析。抽核覆盖四个 hook 的 distinct invalidation/refetch、刷新开始与完成的区别、未消费的 queryConfig、未知意图和未决规范冲突；建议未升级为普遍惯例。抽核由实现 agent 完成，不代表正式人工语义批准。
- [应用检查](application-checks.json)：构建、**21/21 Vitest、3/3 Chromium**（认证准备、资料、讨论/评论 CRUD）通过，原测试与业务源码不变。沿用 frozen Yarn 依赖和浏览器下载，未运行根 prepare；项目外 [runner](frontend-playwright.config.ts) 只调整端口、命令、worker、报告和 storageState。使用仓库原有 Express/MSW fixture API；Next.js 实现未验收。
- [真实 Codex MCP](frontend-native-mcp.json)发现两工具并调用 CodeGraph 查询 `getDiscussions` 当前源码，没有 turn/start、模型请求或 OpenWiki begin。测试 daemon 经官方按项目核验身份后正常停止，API/WebServer 也已停止，[41751/41752 确认 ECONNREFUSED](cleanup.json)。[doctor](doctor-after-cleanup.json)核验索引 initialized，仍为刻意保留的用户说明和 OpenWiki 独立初始化返回 3，不宣称全部诊断通过。

## 复验

先准备同一固定提交的干净克隆、真实消费包、已登录的默认 Codex 和官方 OpenSpec；复验使用已扩展的 [opt-in 入口](../../../../test/live-github-context.test.ts)：

```sh
RIGUP_LIVE_BULLETPROOF_CONTEXT=1 \
RIGUP_E2E_WORKSPACE=/private/tmp/rigup-context-e2e-CASE \
RIGUP_E2E_CLI=/private/tmp/rigup-context-e2e-CASE/consumer/node_modules/.bin/rigup \
RIGUP_OPENSPEC_BIN=/absolute/path/to/openspec \
RIGUP_E2E_SOURCE_REVISION=SOURCE_COMMIT \
RIGUP_LIVE_EVIDENCE_DIR=docs/compatibility/evidence/2026-11-05-stage-context \
node --import tsx --test test/live-github-context.test.ts
```

同一 CASE 续跑保留 fixture/result 及所有持久消费，不改变 scope/预算、不重复未知调用。本轮从新授权副本运行，未清空旧轮。原始模型结果仅留在私有临时 workspace，仓库归档程序报告和可复核的来源摘要。应用命令见 application-checks.json；其他宿主、模型切换、平台、Next.js、生产部署和正式人工语义批准仍各自待验。
