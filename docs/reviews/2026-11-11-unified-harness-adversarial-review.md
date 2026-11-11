# Unified Harness 首版方案对抗审查

审查日期 2026-11-11。对象是[实施计划](../superpowers/plans/2026-11-11-unified-harness-v1-implementation.md)及其[设计规格](../superpowers/specs/2026-11-11-greenfield-harness-design.md)，尚未实现的功能不能据此宣称通过运行验收。

## 本地技能盘点与选择

| 技能 | 本地位置 | 适用范围 |
| --- | --- | --- |
| code-review | `/Users/yuan.li/.agents/skills/code-review/SKILL.md` | 固定 Git 基线的 Standards/Spec 双轴审查 |
| review | `/Users/yuan.li/.agents/skills/review/SKILL.md` | 在 Bugbot 与 Security 两种审查之间路由 |
| review-bugbot | `/Users/yuan.li/.agents/skills/review-bugbot/SKILL.md` | 指定 Bugbot 代理检查代码变更 |
| review-security | `/Users/yuan.li/.agents/skills/review-security/SKILL.md` | 指定 Security 代理检查安全问题 |
| superpowers:requesting-code-review | `/Users/yuan.li/.codex/plugins/cache/openai-curated-remote/superpowers/7.0.1/skills/requesting-code-review/SKILL.md` | 独立 reviewer 检查需求、质量、架构、测试及迁移，核实并处理发现 |
| superpowers:receiving-code-review | 同一 Superpowers 包的 `receiving-code-review/SKILL.md` | 核实反馈，排除误报，避免机械采纳 |
| ponytail 核心技能 | `/Users/yuan.li/.codex/skills/ponytail/SKILL.md` | 复用现有能力、控制复杂度；本地未安装独立 ponytail-review/audit 技能 |

另有 grilling/grill-me/grill-with-docs，偏向方案访谈。Superpowers 7.0.0 的同名技能也存在，本次选 7.0.1。

本次采用 requesting-code-review 的完整 reviewer 模板，使用无会话历史的独立代理，只读审查文档和相关源码。协调者核实反例后修改方案，下一轮使用新快照与新 reviewer。没有调用 Bugbot/Security 专用代理，也不将普通代理冒称为它们。

文档未提交，审查直接固定文件快照，避免空 Git diff 漏审。源码参考 v0.3.5 commit `be0ca645f9c99c6890adedb9bc7141e3ea720ab2`，本地参考 checkout HEAD `5b2448833dc167b39d070ea7178c6b10ed98c635` 的 src/test/templates/package.json 与该发布提交一致。

## 第一轮

实施计划快照 SHA-256 `3afb31952c503a055c5d83a852658109f4726052b6bd364bc454804859da0f9c`。两位独立 reviewer 分别审需求/范围和安装/恢复，合并重复项后得到 5 个 Important，Critical 为 0。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R1-1 | legacy 的同主题 reusable 会拒绝或抑制 new 模块的有效 convention | `src/analyzer/backend.ts:88`；`src/generator/project-rules.ts:135` | Task 2 修改完整验证/生成链的范围匹配，加入同主题跨范围及父子范围测试 |
| R1-2 | scope 仅选 services/api，生成在 docs/rigup 的客户页确认后仍不进入 reader | `src/analyzer/repository.ts:52`、`:134` | Task 3 明确登记页/显式 source 的受控额外读取，安装快照也覆盖；测试实际 options.scope |
| R1-3 | seed 写入后中断，客户删除，旧 before/after 恢复会重建 | `src/installer/apply.ts:148`、`:189` | Task 3 增加持久创建进度；歧义窗口对账，采用已有 exclusive 写入保护并发目标 |
| R1-4 | 客户页退回 draft 或删除后，仅更新新导航段无法撤销旧规则索引的引用 | `src/generator/project-rules.ts:206`；`src/generator/generate.ts:55`；`src/installer/preview.ts:152` | 新约定页只由独立导航段承载；旧引用另作迁移/失效处理，不能无条件恢复 ready |
| R1-5 | 删除客户页后改变 context，路径收据无法识别同一主题，出现复活 | `src/generator/generate.ts:63`；`test/generator.test.ts:365` | Task 3 按 topicId/canonicalScope 记创建身份并保存原 target，增加目录迁移测试 |

协调者同时核实了 scope 元数据被正文 projection 隐藏的影响，要求在分析/规划前传入可信范围约束，并在接受模型输出时校验，不能只修改最后的摘要。该补充与 R1-2 一起进入第二轮复核。

## 第二轮

修订计划快照 SHA-256 `950f8b1162d4a3490bb2835d6a0e3ed06af5acec7a008d5760899e873e44378c`。两位新的 reviewer 分别检查数据合同/调用链和创建恢复/读取保护，确认 4 个 Important，Critical 为 0。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R2-1 | 约定在 knowledge/api-errors.md，reader 虽能读取，但 analyze 的路径采样及 plan 白名单投影丢掉正文/授权范围；host/provider/MCP 不能只靠内存 Map 获得约束 | `src/analyzer/stage-context.ts:34`、`:113`；`src/analyzer/provider-loop.ts:82`；`src/research/mcp-workflow.ts:184` | Task 4 补齐可序列化 sourceGuidance、各阶段导出与缓存/job identity；按真实 backend 验证正文及范围 |
| R2-2 | 全仓安装后只更新 API，按当前摘要重建共享入口会删掉未扫描 web 的导航 | `src/generator/render.ts:43`、`:86`、`:89` | Task 4 按可信基线中的 topicId/scope 身份合并，只撤销本次完整核实的条目；加入 root→API→web→root 测试 |
| R2-3 | apply 初始检查后、运行检查期间撤销客户确认，仍可能提交旧来源的 ready 结果 | `src/installer/apply.ts:133`、`:202`、`:209` | Task 3 操作/检查后及 manifest 提交前复验来源；提交后恢复如遇变化，完成对账但报告需要重新 review |
| R2-4 | 根主题 api-errors 的文件路径，会成为文件 scope api-errors.md 下另一主题目标的父路径，写到一半才发现冲突 | `src/installer/preview.ts:56`、`:74`；`src/installer/ownership.ts:76` | Task 3 改为 topicId 与 scope 完整摘要组成的扁平文件名，并在 preview 检查所有文件目标的祖先冲突；Spec 同步 |

## 第三轮

计划快照 SHA-256 `e731f5d9414aa41f6a2a8cd7c44b8b928fd57b54fddfaff86c1feea56bceddbd`；设计规格快照 SHA-256 `e805b6b8cbd7e83ad0ffc77104d64577fc2fc31fdb99c96a5826bf9369b08898`。另两位无历史上下文的 reviewer 分别复核端到端调用链与升级/恢复合同。前者无新增发现，后者确认 1 个 Important，Critical 为 0。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R3-1 | API-only 确认页被当作 web observation 的 counterEvidence，支持证据及 sourceRef 校验虽通过，web 仍被错误转为 needs-decision | `src/analyzer/backend.ts:108`；`src/generator/project-rules.ts:169` | Task 4 对 sourceRef、supportingEvidence、counterEvidence 使用同一授权范围检查；增加跨范围反证拒绝与范围内反证保留的用例 |

协调者按上述调用链核实该反例后补齐合同。修订后的计划 SHA-256 为 `1636fc9c39c3da5891e1ed9a9353b809d8dd6e2ee16beaf42a32252af3151d6c`。提出问题的 reviewer 已核对该快照，确认范围合同与正反测试闭合，关闭发现；没有剩余发现，结论为可进入实施。

## 前三轮收敛结果

三轮共 6 位独立 reviewer，去重后确认 10 个 Important、0 个 Critical，均已回写实施计划并指定验证用例。仍采用原五任务、原安装生命周期和现有测试入口，没有增加第二套 greenfield 实现或通用 Harness 框架。

本轮文档校验确认本地链接有效、代码围栏配对，计划内引用的现有源码/测试路径存在；三个尚不存在的源码/测试文件均明确列为新增。参考 checkout 与 v0.3.5 的 src/test/templates/package.json 差异为空。

## 未验证范围

本次是方案及源码调用链审查，没有执行新的产品实现、真实旧版本升级、故障注入、远端 GitLab runner 或跨平台安装。review 通过只表示方案可进入实现，不能替代计划中的测试和发布验收。

远端 CI include 展开、新框架 detector 和 GitLab runner 执行已明确留在首版范围之外；本次没有因 review 扩展这些能力。事务安全、B/L/N 合并、backend 实际传输和 Linux/Windows 行为必须在任务 3–5 实现后验证。

## 第四轮（追加第一轮）

按用户要求追加三轮审查。每轮继续采用新的无历史上下文 reviewer 和固定文档快照。第四轮计划 SHA-256 `1636fc9c39c3da5891e1ed9a9353b809d8dd6e2ee16beaf42a32252af3151d6c`；源码基线再次核实不变。

两位 reviewer 分别检查来源权威/范围/缓存和安装生命周期。前者无新增发现，后者确认 1 个 Important（P2）。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R4-1 | after-manifest 撤销确认，resume 虽报告失效，后续 doctor 仍照抄已提交 manifest 的 ready；客户页不在 managed assets 中，资产校验也发现不了 | `src/installer/doctor.ts:58`、`:67`、`:72`；`src/installer/apply.ts:47` | Task 3 使用现有完成事务的 report 持久保存规则 pending；doctor 按 installId 读取，加入变更→恢复→新进程 doctor→新 review/apply 的用例 |

协调者核实 doctor 只检查 prepared 事务及 managed 资产，采纳该发现。修订没有增加状态枚举或独立状态文件，交给下一轮复核。

## 第五轮（追加第二轮）

计划快照 SHA-256 `0384a1c6340c7ea3affa4980d3a8da87d62961ad9e849bfa266d4844f74cd9a4`。两位新 reviewer 分别检查发现/配置/验收入口和状态恢复/诊断一致性，确认 1 个 Important（P2）。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R5-1 | root 安装 API+web 的 build，随后只更新 API；局部命令集重建整份 GitLab 资产，B/L/N 无冲突地删除 web 的检查 | `src/integrations/tools/quality.ts:40`；`src/integrations/gitlab/ci.ts:25`、`:41`；`src/generator/generate.ts:55` | Task 1 在不能完整复核全局接线时保留旧 GitLab 资产；未扫描 selector 不伪报 missing；Task 5 增加 root→API→root 的命令列表与字节断言 |

状态 reviewer 确认 R4-1 的新合同足以覆盖目标恢复序列，无新增发现。它检查了无改动快捷路径和新事务替换旧记录：实现必须遵守“新 review/apply 验证成功前保留失效结论”，这已在合同与验收中要求，不另报成新问题。发现/验收 reviewer 核实 live runner 的参数顺序及开启条件；未纳入目录的自定义 npm 脚本只能标为 unavailable，首版不承诺全面识别，不扩展为额外需求。

## 第六轮（追加第三轮）

计划快照 SHA-256 `a78b0c12f210caf19da8db08807edafaf96ea64dac4d9d91de4ffb6ed4255afd`。两位新的 reviewer 分别进行整体合同复核和范围/接线/诊断边界检查，独立指出同一处状态接续问题，合并为 1 个 Important（P2）。两者未发现其他需要修改的合同，包括第五轮补充的全局 CI 保留规则。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R6-1 | 失效安装 A 的 pending 只在 completed report 中；启动 B 后同一日志被 prepared B 替换，B 中断使 A 的有效状态丢失。来源恢复原字节时，noChanges 又可能跳过状态收敛 | `src/installer/apply.ts:98`、`:141`、`:146`；`src/installer/preview.ts:37`、`:186`；`src/lifecycle.ts:199` | Task 3 把有效 pending 带入继任 prepared 日志并明确安装身份；有效状态参与批准和无改动判断；补充继任中断、局部更新及无文件差异时的收敛测试 |

本轮将第五轮曾讨论的实现边界具体化为“旧 completed 报告被替换后，按原规定无法再匹配”的反例。协调者核对源码后补齐状态接续合同，继续使用现有事务报告，不新增独立状态文件。修订计划 SHA-256 `1e5e26112863dab17915d74f30767d566a4856dc1666f045896c3bd4d02b1246`；两位提出问题的 reviewer 均已核对该快照并定向复核，确认发现关闭。

## 前六轮结果

本次追加三轮使用 6 位新 reviewer，确认 3 个 Important（P2），没有 Critical；加上前三轮，累计 13 个 Important。所有发现均已写入实施计划及对应验收用例，最终定向复核无剩余发现。结论是方案可以进入实施，不代表产品实现已经通过测试。

本次只修改实施计划和本审查记录，仍保留五个实施任务。再次检查文档本地链接、代码围栏、源码与测试路径，并确认最终文件与 reviewer 核对的快照一致。没有运行产品功能、故障注入、真实升级或跨平台测试；这些验证仍按计划实施。

## 持续审查的停止条件

按用户要求继续循环，直到同一最终快照经过一轮完整独立审查，无需要修改的具体问题。每轮由新的无历史上下文 reviewer 审阅完整方案并分别深入证据合同、恢复/状态、兼容/验收；协调者核实反例后修订，再启动下一轮完整审查。单独补丁复核通过不能替代完整零发现轮；不为维持轮次制造问题，不把范围外能力或未来运行证据缺失当作新增缺陷。

## 第七轮

计划快照 SHA-256 `1e5e26112863dab17915d74f30767d566a4856dc1666f045896c3bd4d02b1246`。三位新 reviewer 完整审阅方案和设计规格，确认 1 个 Important（P2）；兼容/验收与安装恢复两位 reviewer 没有额外发现。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R7-1 | MCP 安装失效后来源恢复原字节，manifest/fingerprint 再次匹配旧结果，rigup_begin/rigup_finish 在进入 lifecycle 前返回 noop，绕过 durable pending 与重新批准 | `src/research/mcp-workflow.ts:133`、`:136`、`:147`；`test/research-mcp.test.ts:65` | Task 3 将 MCP 的 noop、缓存结果、previewStillCurrent 纳入同一有效状态与批准身份；增加真实 MCP 失效→恢复原文→新预览/apply→noop 的回归 |

协调者核实此分支在 lifecycle 前返回，采纳发现并补齐文件及测试入口。恢复 reviewer 当轮未接受提交前 draft 隔离的疑点，认为研究入口会被未完成安装阻止；第八轮进一步核实发现普通 CLI 新研究并不在原拦截分支内，纠正该判断，见 R8-1。

## 第八轮

计划快照 SHA-256 `3f53704c3d7cf55657ea8ac6818009adf8ec323e0bc35d3cfb0a24b127d43ce9`。三位新 reviewer 完整审阅；来源/规则及交付/验收两位为零发现，恢复 reviewer 确认 1 个 Important（P2），在协调者核实中补全同一未提交 seed 身份遗漏的第二种后果。

| ID | 反例与后果 | 代码依据（v0.3.5） | 已写入计划的处理 |
| --- | --- | --- | --- |
| R8-1 | A 创建 seed 后未提交 manifest；换用 B 恢复会归档丢弃 A 的 seedProgress，客户删除的页可复活。同阶段移除 frontmatter，普通 CLI 新研究也可能把未确认正文当普通文档读取 | `src/installer/apply.ts:97`、`:98`、`:146`；`src/lifecycle.ts:76`、`:99`；`src/installer/operations.ts:63`；`src/analyzer/repository.ts:72`、`:182` | Task 3 在含 seedProgress 的 prepared 事务对账前阻止新研究/新预览及不同 preview 的 apply；检查在扫描和日志替换前，保留原 preview 恢复和 managed-only 行为 |

协调者核实了普通 CLI 与 MCP/continuation 分支的差异；不同预览恢复与研究暴露共用该限定检查，不引入新的跨事务 seed 历史框架。新增两组回归覆盖已保存 B、不同 context、原地去除标识及普通 provider 入口。其余判定保持原边界：基础研究待接续与显式 apply 的原退出语义不混用，未来运行结果仍待实施验证。

## 第九轮：完整零发现轮

最终计划 SHA-256 `6d90c50f9d1f2bd0685b59bfa7725e66dafad13000a38a09f415490b6e6e8fa6`；设计规格 SHA-256 `e805b6b8cbd7e83ad0ffc77104d64577fc2fc31fdb99c96a5826bf9369b08898`。三位新的无历史上下文 reviewer 均阅读完整计划与规格，再分别深入对应源码；这不是只复核上一轮补丁。

| reviewer 范围 | 完整审查结论 |
| --- | --- |
| 规则与来源：config、reader、backend、stage evidence、generator、MCP | Critical/Important/Minor 均为 0，可进入实施 |
| 状态与恢复：seed、事务身份、来源快照、CLI/MCP/doctor、共享资产 | Critical/Important/Minor 均为 0，可进入实施 |
| 兼容与交付：模块依赖、npm/GitLab、旧安装、批准、测试入口与退出码 | Critical/Important/Minor 均为 0，可进入实施 |

校准记录：跨主题共享 source 的匹配仍须满足明确的 topic/scope 约束，不能把路径级缓存当作全部授权合同；旧版本中断事务须先用旧二进制恢复，该较窄约束也适用于替换旧事务的分支。二者属于已有合同的实现要求，没有形成新的缺失或矛盾。客户在不确定的中断窗口修改 seed 时仍需手工对账，不扩建自动恢复能力。

## 最终收敛结果

已达到本次停止条件：同一最终快照经过三位独立 reviewer 的完整审查，无待修问题。持续循环的第七、八轮新增 2 组 Important（P2），分别为 MCP 有效状态遗漏、未提交 seed 身份保护遗漏，已修订并通过第九轮全量复审。累计九轮确认 15 组 Important，保留五个实施任务。

最终校验核对计划与第九轮快照完全一致，文档本地链接与代码围栏有效，现有源码/测试引用路径存在，新增文件均明确列出。本次修改仅限实施计划和审查记录，没有实现产品代码或执行运行验收。

该结论只表示在本次首版范围和源码基线下未再发现可成立的方案问题，不证明不存在未知问题。实际功能、旧版本升级、故障注入、Linux/Windows 和原生宿主行为，仍须执行计划中的测试与发布门禁。
