# Bulletproof React 上下文优化与完整语义复验

**本轮完整语义 E2E 通过。** 同一 [上游提交](https://github.com/alan2207/bulletproof-react/tree/9506629ed003a561c6627735480cce4994244bb4)、相同研究范围、Codex 默认模型、OpenSpec 启用，预算仍为 **12 请求 / 1200000 observed token**。实际 analyze → plan → content → acceptance 共 **4 请求 / 558605 token**，较原失败轮减少 **64.29%**。这是用户授权的新一轮；[原失败及其 1564127 token](../2026-11-05-github-projects/frontend-semantic-failure.json) 完整保留，没有归零、提高预算或改写模型响应。

实际使用源码 `67512c6` 打包后安装的 CLI，包摘要、工具和应用实际依赖版本见 [tool-versions.json](tool-versions.json)。没有覆盖默认模型；CLI 未暴露服务端最终模型 ID。隔离 HOME 通过原 CODEX_HOME 正常登录，没有复制凭据。复用前一轮按 unchanged yarn.lock 安装的 node_modules 和浏览器，未运行根 prepare。

## 上下文与预算

Codex 的 `dependency-manifests-v1` 策略省略已知 npm/Yarn/pnpm/Bun 锁文件正文，保留完整库存、指纹、清单、源码与规范，并列明 `omittedEvidence`：精确锁定版本及传递依赖未经本次上下文验证。手工 host 默认不变；请求和已接受结果绑定策略，旧的完整快照不能使锁文件重新进入请求。

四阶段均保留 178 条库存路径，发送 177 份正文，没有 `apps/react-vite/yarn.lock` 正文。每阶段证据 **352080 字符**，较原 **853449** 减少约 **58.75%**；锁文件原有 **501391 字符**。完整请求分别为 analysis 426000、plan 468518、content 457571、acceptance 465274 字节，全部低于测试的 600000 字节上限，计量包含嵌套阶段输入。

实际用量依次为 **136086、145744、140323、136452**；持久 ledger 均为 observed，无未知或遗漏的失败调用。没有换模型、禁用 SDD 或注入替代 backend。[完整命令、选项和报告](bulletproof-semantic-e2e.json)、[汇总](summary.json)。Codex 仍按返回用量核验预算，不构成服务器端硬封顶；token 差异也包含模型输出变化，不是固定价格或普遍性能保证。

## 流程、保护与应用

- 研究、规划、一份 API 审查补充正文和独立验收通过，review 交接后从独立进程 apply。CodeGraph 受保护初始化完成；没有 OpenWiki 初始化操作。
- 无变化 preview/apply 写入 0 文件、增加 0 模型调用；给 deliver reference 添加用户说明后再 dry-run，说明保留且不新增消费。
- [来源抽核](source-audit.json)：534 个原跟踪文件字节不变；第 535 个 AGENTS.md 仅追加托管导航，原正文逐字保留；6 个原生 OpenSpec skill 未改。[生成正文](generated-api-review.md) 是逐字存档，链接按原路径 `docs/rigup/react-vite-api-review.md` 解析。抽核确认三个源码样例、未消费的 queryConfig 反例和未决规范冲突未升级为普遍规则，不代表正式人工语义批准。
- [应用检查](application-checks.json)：React Vite 构建、**21/21 Vitest**、**3/3 Chromium**（认证准备、资料、讨论/评论 CRUD）通过。[原浏览器报告](frontend-browser-e2e.json)。业务源码与原测试未改；项目外 [runner](frontend-playwright.config.ts) 仅调整端口、命令、报告、worker 和绝对 storageState。使用仓库自带 Express/MSW fixture API；两个 Next.js 实现未验收。
- [真实 Codex MCP](frontend-native-mcp.json)：发现两工具并实际查询 `getDiscussions` 当前源码；没有 turn/start、模型调用或 OpenWiki begin。
- API、WebServer 和测试 CodeGraph daemon 已停止，41741/41742 端口关闭。运行中的 socket/写进程曾使保护查询返回 pending；官方按项目核验身份停止 daemon 后，[doctor](doctor-after-cleanup.json) 已核验完整索引。doctor 仍返回 3，保留刻意添加的用户说明和 OpenWiki 独立初始化指引，不写成全绿诊断。

## 复验入口

[opt-in 测试](../../../../test/live-github-context.test.ts) 运行真实已安装 CLI，普通 npm test 显式跳过以免意外消费。先准备同一固定提交的干净克隆、安装消费包和官方 OpenSpec 1.16.0：

```sh
RIGUP_LIVE_BULLETPROOF_CONTEXT=1 \
RIGUP_E2E_WORKSPACE=/private/tmp/rigup-context-e2e-CASE \
RIGUP_E2E_CLI=/private/tmp/rigup-context-e2e-CASE/consumer/node_modules/.bin/rigup \
RIGUP_OPENSPEC_BIN=/absolute/path/to/openspec \
RIGUP_E2E_SOURCE_REVISION=SOURCE_COMMIT \
node --import tsx --test test/live-github-context.test.ts
```

同一 CASE 的重试保留 fixture/result 和全部 durable ledger，不能改变 scope/预算或清掉失败消费。原始模型结果仅存私有临时 workspace；仓库归档脱敏的程序报告。应用命令见 application-checks.json；原生检查 RPC 见 frontend-native-mcp.json。

策略回归 [RED](context-red.txt) / [GREEN](context-green.txt) 已留证。[初次本地回归](local-regressions.txt)：312 项，298 passed、14 opt-in live skipped、0 failed。类型检查、构建和 [67 文件打包清单](pack.json) 通过，包中无测试、证据、scratch 或客户状态。

一次独立审查发现升级恢复问题：适配器 v2 的上下文会与旧 host 预算文件冲突，阻止尚有预算的中断运行继续。修复将 host 交换记录按适配器版本分开存放，同一 root/run 的 Codex 持久 ledger 不变，旧消费不清零。两项回归先失败再通过，覆盖可继续、未知用量、调用数耗尽和 token 耗尽；定向 23/23、[最终完整回归](review-full-tests.txt) **314 项：300 passed、14 skipped、0 failed**，类型检查和 67 文件打包通过。上述真实语义运行明确绑定 `67512c6`；该记账兼容性修复使用本地回归验证，没有追加付费模型请求。[审查、修复与全部裁决](final-review-results.json)。其他宿主、模型切换、平台、部署和正式人工语义批准的既有待办不由本案例代替。
