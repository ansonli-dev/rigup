# Unified Harness V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让新服务、成熟服务和混合仓库共用发现、复用、补缺、预览和更新流程，并安全升级 v0.3.5 已有安装。

**Architecture:** 保留 Analyzer → Generator → Installer，复用现有 npm 检查目录、动态 guidance、诊断结果和安装事务。新增代码集中在缺口规划和客户约定页两个 module，GitLab 发现放回已有 GitLab module。

**Tech Stack:** TypeScript、现有 YAML 解析器、Node test runner、tsx；沿用 Node `^22.19.0 || >=24.2.0`，不引入新的运行时依赖。

**Spec:** [项目 Harness 统一初始化设计](../specs/2026-11-11-greenfield-harness-design.md)。该设计是长期能力范围，本计划实现下面明确列出的首版子集。

**优化依据:** 2026-11-11 按 [Ponytail full](https://github.com/DietrichGebert/ponytail/blob/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/skills/ponytail/SKILL.md) 核对调用链后修订，安装的核心 skill 与该提交一致。

## Global Constraints

- Greenfield/brownfield 只描述范围内的工作背景，不增加必填 `projectType`，不增加两套入口或生命周期。
- 相同范围、输入和选项得到相同接入决策。能力只有适用且有实际消费者时才进入接入计划。
- 保留权威原文。推断规则继续通过现有证据及验收机制，待填内容不进入 `development-rules`。
- 安装状态继续使用 `ProjectRulesStatus = 'pending' | 'ready'`。缺口报告与实际安装阻塞分开。
- 保留读取预算、忽略规则、秘密过滤、路径保护、B/L/N 合并、会话结束门禁和中断恢复。
- 客户拥有约定正文，Rigup 拥有导航和接线。配置发现、连接验证、实际执行结果分别表达。
- 本文是实施计划，当前不修改产品代码、不执行安装、不创建或提交 Git 分支。

## 首版范围与基线

首版交付三个行为。发现并引用已有 npm 检查与可静态核实的 GitLab 作业；按范围展示已有规范和业务缺口；对确实需要填写的约定创建一次客户文档，并在客户确认后更新引用。

十类 Harness 保留在共同分类中。Agent 入口、工作流、工具、权限、运行环境等接入继续使用现有适配器，首版给它们增加统一报告的机会，不承诺十类全部自动发现或自动生成。没有 detector 或未读取的来源显示待核实，不能显示缺失。新增框架 AST、OpenAPI/HTML detector、远端 CI include 展开、部署/回滚自动化和新的 eval runner 留到后续。动态主题继续由现有研究证据及明确计划产生，API/UI 只作为验收样例。

| 原计划 | 本次收敛 | 保留的能力 |
| --- | --- | --- |
| 通用逐文件 Harness detector | npm 直接用 `projectChecks`，GitLab 在已有 module 提取事实 | 按范围发现、复用，未知来源明确报告 |
| 十类统一状态对象和新 verification 枚举 | 摘要组合现有 guidance/checks，执行结果沿用 CheckResult/doctor | 配置发现与真实运行分开 |
| API/UI 配置枚举及专用 detector | 复用动态 topic ID 和原规则研究 | 新增事件、数据等主题无需改枚举 |
| 大文档中的 HTML 分节确认协议 | 每个 topic/scope 一页，YAML 元数据与 Markdown 正文 | 逐项确认，新缺口新建页，保留客户正文 |
| 独立兼容脚本 | 复用已有 live test runner、进程清理和证据目录 | 真实旧版本、旧预览和中断恢复验收 |

首次创建收据、draft 证据隔离和事务保护继续保留。现有 customer template 认领整份文件，且 managed 文件会被研究扫描排除，不能直接替代客户约定页。

实施基线按 **v0.3.5** 核对。代码查看位置为 `/Users/yuan.li/.codex/worktrees/rigup-windows-issues/rigup`，对应源码与 tag `be0ca645f9c99c6890adedb9bc7141e3ea720ab2` 一致。当前 `/Users/yuan.li/Documents/rigup` 是有未提交文档的旧 checkout。执行时从届时确认的主线创建隔离 worktree，携带本计划与 Spec，并先核对以下 interface 是否变化，不直接在旧 checkout 上实现。

## Review Focus

1. 同名 npm 脚本分属不同模块，根流水线不应让新模块继承其他模块的检查或规范。任务 1、2、5 覆盖。
2. 扫描截断、忽略规则、远端 include、健康端点和框架依赖只能证明有限事实，不能变成确定的业务缺口。任务 1、2 覆盖。
3. 客户填写、删除、移动待填页，或在预览后创建同名文件，更新应保留客户内容且不自动复活文档。任务 3、4 覆盖。
4. 创建中断、manifest 提交后中断、旧预览跨版本应用，必须保留原批准内容与恢复记录。任务 3、5 覆盖。
5. 已有 ready 安装进行无 provider 更新，必须保留原规则引用、用户入口正文和显式启用的 GitLab 接线。任务 4、5 覆盖。

---

## 模块与交付顺序

| 任务 | 主要位置 | 可独立验收的交付 | 依赖 |
| --- | --- | --- | --- |
| 1 | repository、check-catalog、gitlab/ci、报告输出 | 已有检查与 CI 的发现摘要 | 无 |
| 2 | config、project-rules、generator/harness | 动态主题对账和待填候选 | 1 |
| 3 | project-conventions、reader、preview/apply/baseline | 创建一次客户页，从创建起隔离 draft | 2 |
| 4 | project-conventions、generate/render、workflow references | 已确认正文被消费，旧导航受保护更新 | 3 |
| 5 | CLI/MCP/E2E/live tests、兼容文档 | 三类仓库与旧安装走同一流程 | 1–4 |

按 1 → 2 → 3 → 4 → 5 提交。每个用例单独完成 RED → 最小实现 → GREEN，再开始下一个。测试 seam 是现有 `scanRepository`、`generateFoundation`/`generate`、`preview`/`apply`、`repositoryReader`、`runCli` 和 MCP 请求，不 mock 私有解析器或断言内部调用次数。

## 共同数据契约

新增摘要在 `src/types.ts` 定义为 `HarnessSummary {guidance:GuidanceBinding[]; checks:SpecializedCheck[]; ci:GitlabJobBinding[]}`。保留原 `GuidanceBinding.scope` 数组、coverageStatus、consumers 和 gaps，npm 检查复用 `projectChecks(profile)` 的类型。执行结果继续使用现有 `CheckResult` 和 doctor，不新增 verification 枚举。

`GitlabJobBinding` 为 `{path:string; job?:string; command?:CommandSpec; coverageStatus:'reusable'|'unavailable'; reason?:string}`，只描述可见配置，不声称实际运行过。新增 `SetupPlan.harness?` 并透传到 Preview/InstallReport/doctor。无当前事实的类别不生成空对象，未核实的适用性通过现有 warnings 表达，只有已适用主题才有 guidance/draft。

`SetupPlan.projectDocuments?: {target:string;content:string}[]`。公开 Preview 另有 `projectDocuments?: {target:string;action:'create'|'preserve';reason:string}[]`，不伪装成 managed asset。所有新增字段可选，旧记录缺省时仍可读取。

## Task 1 — 复用已有检查与 GitLab 发现

**Files:** 修改 `src/types.ts`、`src/analyzer/repository.ts`、`src/integrations/gitlab/ci.ts`、`src/integrations/tools/quality.ts`、`src/generator/generate.ts`、`src/installer/preview.ts`、`src/installer/apply.ts`、`src/installer/doctor.ts`、`src/lifecycle.ts`；测试 `test/repository.test.ts`、`test/generator.test.ts`、`test/preview.test.ts`、`test/doctor.test.ts`、`test/gitlab.test.ts`。

**Interfaces:** 原 `projectChecks(profile)` 提供按 cwd/script 去重的命令。GitLab module 新增 `discoverGitlabJobs(path:string,text:string): GitlabJobBinding[]`，输入来自 inventory 已批准且过滤后的文本；`ProjectProfile.gitlabJobs?` 保存发现结果。inventory 结束后按 npm catalog 核实 command。共享 `setupPlan` 组合摘要，两个生成入口共用。

- [ ] **1. 写失败用例** `harness reuses checks with their original working directories`，扫描两个 package 的真实临时目录。

```ts
assert.deepEqual(summary.checks.map(x => [x.command.cwd, x.command.args[1]]).sort(),
  [['services/api', 'build'], ['web', 'build']]);
assert.deepEqual(installReport.checks, []); // 未运行检查
```

- [ ] **2. 验证 RED**，运行 `node --import tsx --test --test-name-pattern='harness' test/repository.test.ts test/generator.test.ts test/preview.test.ts test/doctor.test.ts test/gitlab.test.ts`。
- [ ] **3. 实现该切片**。npm 直接复用 `projectChecks`；GitLab 复用已有 YAML 解析器，只接受完整 script 条目为 `npm run <script>` 或 `cd <relative-scope> && npm run <script>` 的形态。include、extends、变量目录、前置目录切换或其他无法解释的执行上下文为 unavailable，保留出处；不猜测、不抓远端、不执行 shell。scope 外 package 不进入接线，根 CI 也须在读取策略允许范围内。

已有全局 GitLab 接线不因局部扫描缩减。范围限定或扫描截断，导致无法完整复核旧接线覆盖时，完整 generate 与 foundation 均按旧 inventory 保留 `gitlab:jobs`/`gitlab:include` 的 trusted baseline 和 disposition，不以当前局部命令集重建整份资产，也不因省略候选而自动 retire。客户本地改动继续走现有保护。quality 将未扫描 selector 视为待核实，不伪报命令缺失 blocker；明确已扫描但不存在的必需命令仍按原规则阻塞。需要改变全局接线时报告须进行覆盖完整的 root review，不把保留等同新选择已生效，不扩展 CI 解析器或复制 job 合并框架。
- [ ] **4. 以下用例逐条 RED/GREEN**。

| 用例 | 必须断言 |
| --- | --- |
| `harness correlates GitLab jobs by cwd and script` | api/build 不关联 web；引用不存在脚本时 unavailable |
| `harness preserves unknown coverage` | 截断、忽略、远端 include 和无法解释的 before_script/default 不产生 missing |
| `harness gaps are informational` | 有待填项时 executable=true、blockers=[]；真实 prerequisite 缺失仍阻塞 |
| `harness preserves explicit GitLab selection` | 已选 `.rigup/gitlab-ci.yml` 及 include 保留；未选择时客户 CI 字节不变 |
| `harness preserves global CI during scoped updates` | root 安装 API+web build 后，实际 scope=API 的完整/foundation update 保留 web 命令、既有 include 及客户改动；未扫描 selector 不变成缺失 blocker；root 全量复核后才按新选择更新；重复 update 无写入 |
| `harness separates discovery from execution` | 静态 job 不产生 passed 结果，doctor 使用现有诊断/检查结果 |

- [ ] **5. 运行五个完整测试文件与 `npm run typecheck`**。CLI/MCP 透传摘要，保持原状态与退出码。
- [ ] **6. 提交** `feat: report existing harness checks and CI sources`。

## Task 2 — 统一动态主题与明确计划

**Files:** 新增 `src/generator/harness.ts`；修改 `src/types.ts`、`src/config.ts`、`src/analyzer/backend.ts`、`src/analyzer/prompts.ts`、`src/generator/project-rules.ts`、`src/generator/generate.ts`；测试 `test/config.test.ts`、`test/backend.test.ts`、`test/generator.test.ts`、`test/guidance-normalization.test.ts`。

**Interfaces:** 配置增加可选 `projectConventions.topics?: {id:string;title:string;scope:string[];source?:string}[]`，表示团队明确要求整理的主题。沿用现有 topic 的 48 字符、可移植 slug 和最多 12 项约束；将 ID 校验提取到 `src/types.ts` 的 `validateTopicId(value:unknown):string`，由配置和原规则解析共用。配置绑定按 `(id,scope)` 唯一，同一 ID 可在不同 scope 指定不同 source；原 semantic topic catalog 的 ID 唯一性保持不变。

在 `src/types.ts` 提供共用 `scopeContains(parent:string,child:string):boolean` 与 `scopesOverlap(left:readonly string[],right:readonly string[]):boolean`。根 `.` 包含全仓，其他范围按路径段包含，禁止纯字符串前缀。`validateResearch` 的 derived 匹配和 `prepareProjectRules` 的 covered/unresolved 必须同时加入范围判断，不能只修摘要。互不相交的范围不互相阻止；完整包含才算覆盖；部分重叠要求观察收窄或拆分，不把子范围约定提升到父范围。重叠规范的冲突沿用原例外/待决机制，不自动按更深目录取胜。

新 module 导出 `planHarness(profile:ProjectProfile,options:SetupOptions,guidance:GuidanceBinding[]): {summary:HarnessSummary;drafts:ConventionDraft[]}`。`ConventionDraft` 在 `src/types.ts` 定义为 `{topicId:string;title:string;scope:string;questions:string[]}`，按 topicId/单个 scope 去重和稳定排序。没有有效 topicId 的旧 guidance 只报告问题，不临时发明文件 ID。

- [ ] **1. 写失败用例** `harness plans the same topic differently by scope`。legacy 有可靠规范，new 只有骨架与明确 API 计划。

```ts
assert.deepEqual(drafts.map(x => [x.topicId, x.scope]), [['api-errors', 'services/new']]);
assert.equal(summary.guidance.find(x => x.scope.includes('services/legacy'))?.coverageStatus, 'reusable');
assert.equal(plan.requirements.length, 0);
```

- [ ] **2. 验证 RED**，运行 `node --import tsx --test --test-name-pattern='harness' test/config.test.ts test/backend.test.ts test/generator.test.ts test/guidance-normalization.test.ts`。
- [ ] **3. 实现该切片**。先复用 reusable，仅对 partial 的 gaps 补缺；conflicting/unavailable 保留待决问题。只有适用、存在消费者、缺口已核实或团队明确请求整理时才生成 draft。普通新服务用 profile 声明计划，成熟服务继续使用已有动态 guidance；不新增框架 detector。
- [ ] **4. 以下用例逐条 RED/GREEN**。

| 用例 | 必须断言 |
| --- | --- |
| `harness supports dynamic topic ids` | api-errors、ui-states、event-idempotency 共用算法，无新增枚举；无消费者时无 draft |
| `harness permits disjoint reuse and inference` | 经真实 reader→validateResearch→generate，同一 topicId/topic 的 legacy reusable 与 new 有独立证据的 convention 共存；legacy conflicting 不抑制 new；父子部分重叠需收窄 |
| `harness reuses declared authority` | source 仅支持受 reader 策略约束的仓库相对文件；可读原文被引用，不可读为 unavailable |
| `harness does not infer business gaps from scaffolding` | 仅健康端点/框架依赖、无可靠 guidance 或声明时 draft 数为 0 |
| `harness preserves uncertainty and partial coverage` | 截断不证明缺失，partial 只补未覆盖部分，冲突不按多数实现裁决 |
| `harness validates topics and scopes` | 拒绝非法 ID、重复的 `(id,scope)` 绑定、越界 scope；单条 scope 数组去重，`.` 有效；未覆盖范围无 draft |

source 不能绕过任务 3/4 的逐页确认。明确请求整理且仍有未知来源时，问题表达“请确认是否已有规范”，不能声称仓库已全面检查且没有规范。规则研究得到的业务/UI/事件等证据仍走现有 topic 机制。首版只增加必要的通用声明入口，不为每类主题提供独立开关。

- [ ] **5. 运行四个完整测试文件与 `npm run typecheck`**。foundation 与完整生成都调用 `planHarness`，后者使用现有研究得到的 guidance，保留预算、继续和验收机制。
- [ ] **6. 提交** `feat: reconcile scoped harness topics and gaps`。

## Task 3 — 创建客户页并隔离待填正文

**Files:** 新增 `src/project-conventions.ts`；修改 `src/types.ts`、`src/generator/generate.ts`、`src/analyzer/repository.ts`、`src/analyzer/read-policy.ts`、`src/installer/preview.ts`、`src/installer/apply.ts`、`src/installer/baseline.ts`、`src/installer/doctor.ts`、`src/lifecycle.ts`、`src/research/mcp-workflow.ts`；测试 `test/repository.test.ts`、`test/preview.test.ts`、`test/installer.test.ts`、`test/recovery.test.ts`、`test/ownership-path.test.ts`、`test/doctor.test.ts`、`test/cli.test.ts`、`test/research-mcp.test.ts`。

**Interfaces:** `renderConventionSeed(draft:ConventionDraft): {target:string;content:string}` 生成相对 context 根目录的目标，Generator 采用已配置的 `documentRoutes.context`，默认 `docs/rigup`。单页使用扁平路径 `conventions/<topicId>--<digest(canonicalScope)>.md`，digest 复用现有完整 SHA-256，根 `.` 与文件 scope 使用同一规则。人可读标题和范围保留在正文元数据及导航中，不把原 scope 拼成目录。Preview 对 seed/managed 的全部文件目标一起检查完整别名和路径段祖先冲突，必须在任何操作或写入之前拒绝，不依赖写盘时发现父路径是文件。

使用 YAML frontmatter，初始 Markdown 正文为空，客户在正文填写约定。问题、验证方式和结果位置位于元数据，不作为规则正文。

```md
---
rigup: team-convention
version: 1
topicId: api-errors
title: API 错误语义
scope: services/api
status: draft
questions:
  - 本范围应遵守哪份错误规范，尚需决定哪些约定？
verification: ""
result: ""
---
```

`readConventionDocument(path:string,raw:string,registered?:boolean): {page?:ConventionPage;researchText:string;warnings:string[]}` 复用现有 YAML 解析器，registered 表示该路径有创建收据。`ConventionPage` 在此 module 定义，包含 path、topicId、title、scope、status 和可选 `sourceRef:Evidence`；status 为 draft/confirmed/not-applicable。`ProjectProfile.conventions?:ConventionPage[]` 保存已校验页面元数据，不保存另一份正文。已识别页面的非法、重复 YAML 字段或破损元数据进入 warnings，不能退回普通权威文档。

manifest 增加可选 `seededProjectDocuments?: {topicId:string;scope:string;target:string}[]`，旧值缺省为 `[]`，schemaVersion 仍为 1。创建历史按 `(topicId, canonicalScope)` 唯一，target 记录原路径。改变 context 不能重置创建历史或自动搬移客户页；同一身份已创建但缺失时仅报告，新的身份才允许自动留页。校验 ID、规范化范围、目标路径和唯一性，不认领客户内容。

限定读取合同在 inventory、repositoryReader、scanInstallationSources 一致实现。业务 options.scope 保持原意义；当前配置明确列出的 source，以及可信 manifest 中登记且业务范围与本次 scope 相交的约定页，是额外允许读取的具体文件。只在这两个已授权集合内读取，不因任意文档自称 scope 就扩大搜索；仍受 ignore、预算、秘密过滤及路径保护约束。页面 scope 必须与登记/声明的授权范围一致，变化时报 unavailable 并要求明确重映射。新位置在 scope 外时通过显式 source 纳入；邻模块页面不输出为本次适用规则。额外来源原始内容也进入安装快照，预览后修改会使批准失效。

来源快照在 apply 开始、操作/检查结束和提交 manifest 前复验，复用 installationInput 及同一 approved generatedScopes 排除规则；不能只 verifyFiles。复验失败保留客户文件和 durable transaction，旧 manifest 不切换，resume 同样检查。事务已提交但尚未结束时发现来源变化，不回滚或重写已提交文件，也不报告当前规则仍 ready，应完成安装对账并报告来源已变更、需要新 review；已完成事务的重复 apply 同样不得声称旧证据仍有效。

上述已提交事务的失效结论写入现有 durable `Transaction.report`，使用 `projectRules:'pending'`、现有 warning/nextCommand 和规则待研究的退出语义；事务文件对账完成仍可为 complete。启动后续事务前，先把当前安装的有效 pending 报告带入新的 prepared 事务，再 durable 替换同一日志，不能先丢弃旧 completed 记录。prepared 中保留的报告归属于已批准 preview.oldManifest.installId，complete 报告归属于 tx.installId；doctor 按当前 manifest 对应身份读取两种状态，不能仅检查 completed 或照抄 manifest 的 ready。新事务失败/中断仍保留旧结论；提交后的最终报告替换旧报告，只有受影响来源已充分复核并成功应用才恢复 ready，其他模块的局部更新不能清除它。不新增失效枚举或另一份状态文件。

lifecycle、preview、apply 和 MCP 使用同一有效规则状态。预览记录该状态并纳入批准身份，apply 前复验，不能沿用失效前的 ready 批准。存在待收敛的 pending 时，skipUnchanged/unchangedInstallation 不能仅按文件、manifest 判定完成：即使来源已恢复且没有文件差异，也要保存可批准 preview，经正常 apply 复验并持久写入新报告后才清除。来源仍未核实时保持 pending/research handoff；成功收敛后的再次更新才恢复原无改动快捷路径。MCP 在调用 lifecycle 之前的 lastResultApplied/noop、缓存 result 和 previewStillCurrent 同样使用此状态及批准身份；rigup_begin/rigup_finish 不能因 fingerprint 和 manifest 恢复原值而返回 noop 或复用旧批准。旧研究内容能否复用仍按证据及预算合同判断，不能把复用内容等同重新批准。

- [ ] **1. 写失败用例** `harness seeds customer pages without exposing draft evidence`，通过真实 preview/apply/reader 验证。

```ts
assert.equal(preview.projectDocuments?.[0]?.action, 'create');
assert.equal(manifest.assets.some(x => x.target === target), false);
assert.ok(manifest.seededProjectDocuments.some(x => x.target === target && x.topicId === 'api-errors'));
assert.equal((await reader.search('未确认的测试约定')).length, 0);
```

- [ ] **2. 验证 RED**，运行 `node --import tsx --test --test-name-pattern='harness' test/repository.test.ts test/preview.test.ts test/installer.test.ts test/recovery.test.ts test/ownership-path.test.ts test/doctor.test.ts test/cli.test.ts test/research-mcp.test.ts`。
- [ ] **3. 实现该切片**。seed 进入 allTargets/fileMap/PreviewData.files，不进入 assets/baselines/dispositions。使用现有 atomicProjectWrite 的 exclusive 创建分支，防止最后检查后出现同名文件时被 rename 覆盖。扩展原事务的可选 `seedProgress?:Record<string,'started'|'written'>`，写入前 durable 保存 started，独占创建成功后 durable 保存 written，再继续。生成和最终虚拟树导航验证都看到 seed，创建时不能误报 noChanges。research inventory/read/search/evidencePass 共用 projection，draft 全部置空行；installation snapshot 仍跟踪原始变化。升级 READ_POLICY_VERSION。

恢复不能仅按 before/after 判断 seed。未开始创建的目标才可走首次创建；started/written 的目标若仍等于批准 after，可核实并复用；若缺失、移动或被改写，保留客户现状与事务，停止并提示对账，禁止自动重建。started 后写入前崩溃与写入后被删除无法区分时，同样保守对账。该状态仅用于 seed，旧 managed 资产恢复语义不变。

未完成的 prepared 事务含非空 seedProgress 时，首次创建历史尚未进入 manifest，不能换一份预览绕过。CLI 在新研究/新预览的扫描和 provider 调用前返回原事务对账入口，覆盖普通 update --review、dry-run 及无 provider 路径；MCP 保持同一限制。apply 在额外来源扫描及归档/替换旧日志前拒绝不同 previewId，即使带 --resume 或改变 context 路由也不例外。保留原 preview 的恢复与手工对账路径；原事务完成后凭 manifest 收据正常更新。不读取未提交客户正文来猜测其确认状态，也不自动补造成功收据；seedProgress 缺省或为空的原 managed-only 恢复流程不受影响。
- [ ] **4. 以下用例逐条 RED/GREEN**。

| 用例 | 必须断言 |
| --- | --- |
| `harness preserves existing and edited pages` | 已存在目标 preserve；客户字节不变；不接管同名 managed 资产 |
| `harness does not resurrect deleted pages` | 创建→删除→改 context→update 不重建；移动且保留标识→改 context 不产生第二份；新 topic/scope 才创建新页 |
| `harness rejects stale and unsafe targets` | 预览后同名目标出现时 apply 失败且客户内容不变；symlink、越界、大小写别名、所有权冲突使用既有保护 |
| `harness rejects prospective file ancestor collisions` | `(api-errors,'.')` 与 `(formatting,'api-errors.md')` 得到不同扁平目标；构造 seed/seed、seed/managed 祖先冲突时 preview 即拒绝，零写入、零事务 |
| `harness resumes around manifest commit` | 正常中断恢复恰好一份页面/收据；started/after-file 中断后删除、移动、修改均不重建或覆盖，明确对账；exclusive 写入遇并发同名文件保留对方内容 |
| `harness rejects replacing unresolved seed transactions` | 已安装仓库的 A 仅新增 seed→写入后中断→客户删除→申请或应用 B（含预先保存的 B、--resume、不同 context）被拒绝；A 日志保留、不重建；同一 A 正常恢复可继续，managed-only 替换原用例仍通过 |
| `harness blocks fresh research over uncommitted seeds` | seed 写入后、manifest 前中断→同路径移除 frontmatter 并填未确认正文→普通 provider CLI update --review 返回对账，零研究请求且不导出正文；dry-run/foundation/MCP 同样不能另建预览；不依赖只有 continuation/resume 才执行的检查 |
| `harness reads registered sources under a selected module` | 真正设置 options.scope 为模块/文件/根，确认位于 docs/rigup 的登记页后仍可读；邻模块不生效，ignore 不可绕过；预览后修改该来源使 apply 拒绝 |
| `harness revalidates authority before commit` | after-checks/before-manifest 修改、删除、移动来源时拒绝提交，客户字节不变，resume 仍拒绝过期来源；after-manifest 变化只对账并报告需新 review，不假报 ready |
| `harness doctor preserves recovered authority invalidation` | after-manifest 撤销确认→resume→新进程 doctor 仍为 projectRules pending 并给新 review 入口；重复 apply 不清除；新 review/apply 成功后才清除，旧 installId 报告不污染新安装；已提交文件保持不变 |
| `harness carries invalidation through successor transactions` | 失效安装 A→批准 B→prepared 或 before-manifest 中断→新进程 doctor 仍保持 A 的 pending；B 恢复失败不丢失；无关模块的成功局部更新仍保留待决状态；充分复核并成功提交后才恢复 ready |
| `harness reconciles authority without file changes` | 来源恢复原字节→新 review 仍生成批准预览→apply→doctor 恢复 ready；失效前旧批准被拒绝；不改客户文件，收敛后再次 update 无写入 |
| `harness MCP reconciles effective pending before noop` | 真实 MCP 研究并应用 A→after-manifest 失效并恢复对账→来源恢复原字节→rigup_begin/rigup_finish 不得 noop 或返回旧批准；取得新预览并 apply 后才恢复 noop；覆盖已有缓存 result 的分支，不仅断言 CLI 结果 |
| `harness quarantines draft and malformed pages` | read/search/evidencePass 无未确认正文，破损 frontmatter 不降级为普通文本 |

普通提交与恢复对账使用同一收据合并结果，按身份去重并排序。未提交的创建进度只留在 durable transaction，不能伪装成成功 manifest 收据。收据或专用 frontmatter 标识决定页面身份，移动且保留标识的页面仍识别 draft，但标识本身不授权 scope 外读取。conventions 目录不接管既有普通文档。无收据且未标记的文档沿用原读取行为；移出登记路径并彻底删除标识后，不承诺追踪已主动移除的身份。

- [ ] **5. 运行八个完整测试文件与 `npm run typecheck`**。创建客户页与隔离 draft 在同一任务交付，不能留下中间版本的证据污染。
- [ ] **6. 提交** `feat: seed protected customer convention pages`。

## Task 4 — 消费已确认约定并保留旧导航

**Files:** 修改 `src/project-conventions.ts`、`src/analyzer/backend.ts`、`src/analyzer/repository.ts`、`src/analyzer/analyze.ts`、`src/analyzer/stage-context.ts`、`src/analyzer/host.ts`、`src/analyzer/provider-loop.ts`、`src/research/mcp-workflow.ts`、`src/generator/project-rules.ts`、`src/generator/harness.ts`、`src/generator/generate.ts`、`src/generator/render.ts`、`src/lifecycle.ts`、`templates/skills/change-prepare/references/project.md`、`templates/skills/change-deliver/references/project.md`；测试 `test/repository.test.ts`、`test/backend.test.ts`、`test/generator.test.ts`、`test/managed-input.test.ts`、`test/stage-context.test.ts`、`test/codex-backend.test.ts`、`test/host-context.test.ts`、`test/research-mcp.test.ts`。

**Interfaces:** 延续任务 3 的文档 interface。confirmed 要求正文非空且不是纯 TODO/占位符；not-applicable 要求正文解释理由，但不产生规则。有效 confirmed 正文转为原 `GuidanceBinding` 后继续通过范围/digest/规则验证。页面及显式 source 的绑定必须在 analysis/artifact-plan 前作为约束传入，不能等模型规划后才补摘要。`RepositoryReader` 增加可选只读 `sourceScopes?:ReadonlyMap<string,readonly string[]>`，由已校验扫描结果构造；`validateResearch` 对引用这些来源的 sourceRef、supportingEvidence 和 counterEvidence 统一检查所属 guidance/observation 的范围不得超出授权范围，反证也不能跨范围制造冲突或待决。旧 reader 缺省仍有效；真实 evidence 导出、reader 校验和预算保持原要求，metadata 不能替代已导出的证据。

传输层在 `ResearchRequest` 明确定义可选 `sourceGuidance?:GuidanceBinding[]`，由可信扫描结果按 topic/scope/path/range 稳定排序。analyze、plan、content/acceptance 复核都携带适用绑定；stageContext 的白名单投影保留它，并把其有效 sourceRef 纳入既有预算控制的证据选择，不能依赖文件恰好位于 docs/。provider JSON、host 导出和 MCP job 都携带同一可序列化字段，MCP job identity、研究缓存/consent 包含它。实际正文未导出时不能因为 metadata 存在就接受引用。同步提升受影响的 PROMPT_VERSION、STAGE_EVIDENCE_POLICY 和 backend artifactContextVersion，测试旧 continuation/已接受候选失效且预算不重置。

- [ ] **1. 写失败用例** `harness confirms one scope while another stays draft`。

```ts
assert.equal((await reader.search('API 已确认约定')).length, 1);
assert.equal((await reader.search('UI 未确认约定')).length, 0);
assert.deepEqual(confirmedBinding.scope, ['services/api']);
assert.equal(await readFile(target, 'utf8'), customerEditedText);
```

- [ ] **2. 验证 RED**，运行 `node --import tsx --test --test-name-pattern='harness' test/repository.test.ts test/backend.test.ts test/generator.test.ts test/managed-input.test.ts test/stage-context.test.ts test/codex-backend.test.ts test/host-context.test.ts test/research-mcp.test.ts`。
- [ ] **3. 实现该切片**。confirmed 仅暴露正文，frontmatter 置空以保持行号；topic/scope 作为已校验元数据传入 guidance。不根据文件名或 source 配置跳过确认。inventory fingerprint 同时包含过滤后的正文和校验后的 topic/scope/status 摘要，状态变化即使没有可见正文也会使研究缓存失效。
- [ ] **4. 以下用例逐条 RED/GREEN**。

| 用例 | 必须断言 |
| --- | --- |
| `harness validates confirmation and scope` | 空确认 unavailable，not-applicable 不再补缺；其他模块不继承；状态退回 draft 后旧引用失效 |
| `harness enforces source scopes before planning` | backend 收到有范围的已确认来源；模型将 services/api 正文用作 `.` 或 web 规则被拒绝；CLI/MCP 均不能仅在最终摘要修正 |
| `harness rejects cross-scope counterevidence` | web observation 有两份有效 web 支持，引用 API-only 确认页作为 counterEvidence 并标 needs-decision 时仍拒绝；授权范围内的真实反证保留原待决行为 |
| `harness exports authority across all backends` | confirmed 页在 knowledge/api-errors.md 时，Codex/host/provider/MCP 实际导出包含授权范围与正文；未导出正文的引用仍拒绝；旧 job/cache 不能复用新授权 |
| `harness preserves conflicting confirmed sources` | 同一 topic/scope 有不同确认正文时 conflicting，保留出处，不按目录顺序或时间选赢家 |
| `harness preserves ready navigation without provider` | 完整 generate 的约定链接只进 harness 段，普通旧规则/客户入口正文保留；随后无 provider 删除、移动、降回 draft 能撤销对应导航；无变化或仅新增缺口保持 ready |
| `harness merges navigation against trusted baselines` | 从 trusted baseline 构造候选，客户修改走 B/L/N，缺 baseline 或冲突时不覆盖 |
| `harness handles legacy convention references` | v0.3.5 索引曾引用的普通页升级为结构化约定页后，旧引用也须处理；安全可迁移则 B/L/N，否则明确 pending/需研究，不能假报 ready 或忽略悬空链接 |
| `harness update is stable` | 同一输入再次更新无写入，不重复创建页面或导航 |
| `harness merges scoped navigation without losing neighbors` | root→API→web→root 更新，包含单模块撤销、共享根范围来源及本地修改，只改变已完整核实的身份，未扫描邻模块保留，重复更新无写入 |

受识别客户约定页保持同一 guidance 验证和覆盖决策，但其链接只由 `rigup:harness:start/end` 段承载。prepareProjectRules 与普通 render guidance 输出接收可信 profile 中的约定页路径集合，将这些页排除出旧 development-rules 索引及普通 reused 链接，不能由模型选择豁免。Agent 入口和 prepare/deliver references 都更新该段，读取前检查 scope/status。无 provider 撤销确认时撤销当前导航，不留下第二条旧索引路径。

导航条目在该 managed 段内带稳定 topicId/scope 身份元数据，由 trusted baseline 读取。范围限定 update 按身份合并，仅增改删本次已完整核实的条目，未扫描身份原样保留。范围部分重叠或预算截断导致未输出，不代表撤销；整页授权来源已明确撤销确认则可以撤销该来源身份。无法可靠识别旧条目时保留并报告，不猜测删除；候选合并完成后再走 B/L/N。该规则用于完整 generate 和 foundation 两条路径，不能用当前摘要重建整段并丢掉其他模块。

对升级前已有的旧索引引用另作检查。旧 managed 索引/正文引用现已识别的约定页时，可确定识别的引用从 trusted baseline 移除后走 B/L/N；无法安全确定的旧正文保留并提示需要规则研究，不能宣称引用撤销完成。禁止把客户本地修改提升为新基线。无变化且引用有效时保留 ready；无法证明旧规则仍可消费时沿用 pending/research handoff，lifecycle 不得无条件把结果重新设为 ready。更新 TEMPLATE_VERSION，普通新缺口不变成安装 blocker。

- [ ] **5. 运行本任务八个完整测试文件与 `npm run typecheck`**，确认原 semantic policy 仍拒绝空规则和虚构约定。
- [ ] **6. 提交** `feat: consume confirmed conventions through existing guidance`。

## Task 5 — 验证统一流程与 v0.3.5 升级

**Files:** 修改 `test/helpers.ts`、`test/cli.test.ts`、`test/research-mcp.test.ts`、`test/e2e.test.ts`、`test/installer.test.ts`、`test/recovery.test.ts`；新增 `test/fixtures/unified-harness/` 下 `new-service/`、`mature-service/`、`mixed-repo/` 和 `v035-install/`，以及 `test/live-harness-upgrade.test.ts`；更新 `docs/guides/usage.md`、`docs/compatibility/status.md`、`CHANGELOG.md`，新增 `docs/compatibility/unified-harness-v1.md`。

**Interfaces:** 复用 `runCli(args, dependencies)`、既有临时目录/backend fixture、MCP 工作流入口，以及 `test/live-process-support.ts`、`test/live-support.ts`、`test/run-live-tests.mjs`。新增 fixture helper 只准备输入、隔离 cache/state，不复制规划算法。新安装用 `init --review --json`，已安装用 `update --review --json`，两者此后走同一个审批应用与再次更新序列。

| fixture | 初始依据 | 同一流程的必要结果 |
| --- | --- | --- |
| new-service | package、build、健康端点、根 GitLab build，profile 声明 api-errors，暂无业务实现 | 复用 build/job；一个 API 待填条目；业务规则不虚构；基础安装可执行 |
| mature-service | 已有 API 规范、业务实现与测试、GitLab 作业、AGENTS 自定义正文 | 引用权威来源；不创建重复待填页；原 CI 与客户正文逐字保留 |
| mixed-repo | legacy API 有规范，new API 只有骨架与计划，web 有页面入口及 UI 主题声明；各目录有同名 build/test | 按 scope 分开规划；只给未覆盖的 new/web 待填；root CI 的命令按 cwd 关联；共享来源只有显式 scope 才共享 |
| empty 补充用例 | 无业务/骨架证据、无声明 | 最小基础接线；无虚构业务主题或成批占位页 |

- [ ] **1. 写首个失败 E2E** `unified harness uses one lifecycle for new mature and mixed repositories`，参数化执行三组 fixture，使用真实扫描、生成、预览、安装和更新。先跑一个 fixture 的 RED→GREEN，再增加其余输入。

```ts
assert.equal(review.executable, true);
assert.equal((await loadManifest(root))?.schemaVersion, 1);
for (const [path, expected] of originalCustomerFiles)
  assert.equal(await readFile(join(root, path), 'utf8'), expected);
assert.deepEqual(repeated.written, []);
assert.equal(new Set(drafts.map(x => JSON.stringify([x.topicId, x.scope]))).size, drafts.length);
```

- [ ] **2. 验证 RED**，运行 `node --import tsx --test --test-name-pattern='unified harness|harness upgrade' test/cli.test.ts test/research-mcp.test.ts test/e2e.test.ts test/installer.test.ts test/recovery.test.ts`。
- [ ] **3. 完成三类 fixture 的共同序列**。review → 检查来源/范围/待填和 blockers → `update --apply <previewId> --sessions-ended --json` → `doctor --json` → 客户确认或新增模块 → update/review/apply → 再次 update。断言客户正文保留、无重复写入。pending foundation 保持原 exit 3/research handoff，不要求全程 exit 0。semantic fixture 经真实 reader/validateResearch/generate，不能预填摘要。mixed fixture 增加同一 topic 在 legacy reusable、new 已有可推断实现的变体；模块化运行必须实际设置 options.scope，完成 scope 外登记页确认、变更及批准失效验收。已有 GitLab 接线执行 root→API→root，断言 API 局部更新保留 web 检查和 include，没有因未扫描 selector 产生假 blocker；用准确命令列表及客户字节断言，不能只检查资产存在。
- [ ] **4. 单独循环兼容用例** `harness upgrade preserves v035 installation`、`harness upgrade rejects stale approval`、`harness upgrade preserves interrupted transaction`、`unified harness CLI and MCP produce equivalent scoped plans`。

v0.3.5 fixture 必须由固定 release 二进制或该 tag 构建产出，记录版本、输入配置和生成步骤；不能用新代码伪造旧 manifest。提交可移植的已完成安装 fixture 供普通测试离线读取。旧 preview/中断事务含绝对路径，live 测试在临时目录用 `RIGUP_V035_BIN` 指定的真实 v0.3.5 重新生成，再切换新构建验证；缺失旧二进制时明确失败，不能记为通过。覆盖 legacy/provider 配置、modern pending、modern ready 三种安装，以及一份显式 GitLab/原生工作流配置。对旧 baseline 内容做 byte 比较，对受本次修改的导航使用准确增量断言。验证以下兼容合同。

| 对象 | 升级行为 |
| --- | --- |
| 旧 config/manifest | 无新增字段也能读；保留用户选择、旧 logical IDs、receipts 和不受本次改动影响的 baselines；不自动切换 SDD、host 或 provider |
| 旧 managed 资产 | 继续通过原 disposition 和三方合并；不得把旧生成文档整体转成客户资产 |
| 已有客户文档 | 引用或 preserve；不认领、不覆盖、不自动追加 |
| 旧未应用 preview | 版本变更按现有机制拒绝，重新 review；不能沿用旧批准写新内容 |
| 旧中断 apply | 先以原版本完成既有恢复，再升级。新版本遇到版本不匹配时保留 durable record 并提示恢复，不自动丢弃、改写或跨版本强行续写 |
| 新版本回退到 v0.3.5 | 不承诺旧二进制识别新增 topics 配置；回退需恢复升级前配置和安装快照，不能只替换二进制 |

- [ ] **5. 验证完整门禁并记录结果**。运行上述五个完整测试文件，然后 `npm run check`。发布验收配置 `RIGUP_V035_BIN` 后运行 `npm run test:live -- --test-name-pattern='harness upgrade'`，使用新构建 `dist/cli.js`。默认未开启 live 的 skip 不能记为通过；开启后旧二进制缺失或任一合同失败必须失败。复用既有进程清理与证据目录。在支持子进程和真实锁的环境运行，记录 Node/OS、fixture 版本和命令。至少 Linux 与 Windows 跑路径/安装/恢复回归。选一个原生 workflow fixture 验证 prepare/deliver 都能到达正确来源。静态 GitLab 发现不等同 runner 执行，文档不得把它记为流水线运行通过。
- [ ] **6. 更新使用与兼容文档后提交**，提交信息 `test: verify unified harness lifecycle and v035 upgrades`。

## 完成标准与实施建议

五个任务全部完成后，首版可以发布候选版本。三类仓库只在证据、适用范围和缺口上不同，入口、决策算法、安装事务与更新语义相同。客户能明确看到已有来源、将创建的待填页、真实阻塞和尚未验证的能力；填完约定后，Agent 能在正确范围读取已确认正文。

最大的实现风险集中在任务 3、4，分别涉及事务恢复和规则证据/旧导航保护，建议各自作为独立评审点。任务 1、2 先稳定数据契约，再接文档写入。已有安装不要求重装，迁移入口是正常的 `update --review`。

本轮已安装 Ponytail、核对源码并修订计划，未运行新增功能测试。首版仍保留 CI 静态识别的范围限制，实施时在对应 helper 旁用 `shortcut:` 说明限制及扩展条件。此前 v0.3.5 generator 基线曾通过 42 个测试；当前受限环境的 Node 子进程 `/bin/ps` 调用出现过 `spawn EPERM`，完整 CLI/apply/E2E 验证必须在可执行该锁检查的环境补齐，不能用跳过门禁作为通过证据。
