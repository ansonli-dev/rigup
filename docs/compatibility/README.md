# 上游版本核验与支持声明

日期：2026-11-03。状态：基础实现及首批源码/发行包锁已建立；本地契约和有限组件冒烟已有记录，完整宿主兼容矩阵仍未验收。

本目录是 Rigup 的产品开发证据，不是安装到客户项目的一套新文档。关联：[实施计划](https://github.com/ansonli-dev/rigup/blob/main/docs/superpowers/plans/2026-11-02-rigup-implementation.md)、[验收状态](https://github.com/ansonli-dev/rigup/blob/main/docs/compatibility/verification.md)。

## 1. 实施顺序与支持边界

Tasks 1–3 可先实现 CLI、只读分析和后端协议；Task 3 使用 SDK 前核验官方接口与依赖版本。Task 4 为每项实际接入能力核验并锁定上游，随后才实现和启用该 recipe。无须等待所有上游完成才能开始基础工作，但某项未核验不能用猜测的路径/命令实现可执行安装。

默认集成必须有版本证据才能进入执行预览；未知版本不声称支持。已知格式可做只读识别，缺证据的 setup 标 pending/unsupported 并给出原因。普通 update 使用原锁定版本，不隐式追最新；显式升级重新核验版本、写入和兼容性。

首版的目标仍是四宿主、三 SDD、OpenWiki/CodeGraph 和反馈接线。阶段实现不改变需求范围；只有真实证据覆盖了目标范围，才能宣布相应能力验收或首版完整验收。

## 2. upstream-lock.json 的记录标准

Task 4 创建 `upstream-lock.json` 并用运行时 schema 校验；本轮不创建包含猜测版本的占位锁文件。每项 recipe 的锁定记录包含：

- `integrationId`、`kind`、上游名称和准确仓库/包标识；CodeGraph 固定为用户指定的 https://github.com/colbymchenry/codegraph，不以同名项目替代。
- `version`（精确版本或 commit）和适用范围；安装包记录可获得的完整性摘要，不使用 latest/浮动分支代表锁定版本。
- `sources`：官方文档/上游源码的 URL、相应版本/commit、核验日期与支撑的命令/格式/路径；不只链接首页。网页会变时保留定位、短摘要及版本上下文，不复制整篇文章。
- `runtime`：OS、Node/运行时约束、安装方式及项目/用户级位置；未知项显式记录。
- `entries`：原生 skills/命令、入口和配置格式、MCP 注册方式、SDD 产物路径及不可取消 gates；仅记录该集成实际需要的字段。
- `operations`：detect/prepare/setup/verify 的 CommandSpec、参数、cwd/envRefs、前置条件、声明写入路径、网络/远端副作用、超时及查询/恢复方法；按 Installer 3.1 区分候选项目文本与原生工具状态，记录已有文件保护依据、候选重叠处理和执行后证据；其第 4 节的未决记录须在派发前取得可用对账线索，不能只依赖成功响应中的 id。声明路径不授权覆盖；只读规划不能偷偷安装/初始化。命令文本不由模型自由生成。
- 实际接入需要的生成区/混合目录投影规则：明确哪些是工具输出、哪些用户输入仍参与研究指纹；不能为满足缓存测试而忽略整个工具目录。
- `evidenceStatus` 与 `evidenceRefs`：区分 source-verified（官方接口已核验）、contract-tested（本地契约通过）、live-tested（对应环境真实运行通过）；这些是不同维度的证据，不由前者推定后者。

凭据只记录环境引用，不记录值。无法限制或说明写入范围的上游动作不自动执行，提供人工方式。Pi 与 Oh My Pi 单独核验，不能互推；一个宿主配置能解析不等于该宿主真的加载。

## 3. 最低核验范围

- Claude Code、Codex、OpenCode、Oh My Pi：各自原生入口、skill 发现、MCP 配置/连接、项目级和用户级配置边界、重载要求。
- Superpowers、OpenSpec、Spec Kit：安装来源、原生入口、产物布局、人工 gate；逐个核验宿主绑定，不把另一个框架的同名命令当替代。
- OpenWiki：安装、MCP、初始化、恢复、GitLab 更新；CodeGraph：安装、MCP、项目索引与查询。分别记录软件安装和项目初始化，不能只验包存在。
- hooks/质量工具/GitLab：所选工具版本、真实检查快照、CI include/语法、报告与退出码；部署/工单系统仅在客户实际适配存在时声明已接入。

每项 recipe 增加 `unverified_recipe_cannot_execute`、`version_change_requires_new_evidence`、`ordinary_update_keeps_locked_version` 契约测试。检查锁文件引用能定位、命令/路径与源码证据一致；测试替身只证明执行契约，不证明真实上游兼容。

先验证能运行环境中的最小安装/skill 发现/MCP 路径，再扩展模板；核验外部操作在已声明目录内也不能覆盖用户文件，及真实初始化输出不会污染研究缓存。客户 MCP 的静态配置合并与真实连接、客户模板复制与实际消费者使用分别留证；单个组合成功不提升其他组合状态。

## 4. 新增或升级的完成条件

先核验官方来源并更新锁定记录，再测试路径/格式/所有权保护，最后在真实环境运行相应场景并保存脱敏证据。真实环境缺失时仍可完成本地适配，但必须保留 pending，不能标 live-tested，也不能把兼容范围写成“支持所有版本”。

README/help/报告只能声明与证据一致的已测试范围；目标能力可以列出，但必须与已验证支持区分。任务失败或未知结果不从记录中删除，以免后续重跑重复副作用。
