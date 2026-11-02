# M7 Adapter Platform：适配器与扩展

所属：[总架构](../2026-11-02-smart-harness-design.md)。本 Module 集中承载真实工具差异，不复制 Core 的安装生命周期。

## 1. Interface 与调用限制

```typescript
catalog(): ProviderCatalog
probe(request: ProbeRequest): Promise<Result<Observations>>
renderer(providerId: string): Renderer
recipe(providerId: string): ActionRecipe
driver(providerId: string): ActionDriver
```

catalog/renderer/recipe 不改客户环境。probe 只执行已声明的只读检查，返回带时间/版本的观察。driver 的变更方法只由 Executor 调用，模块间不得借 Adapter 绕过计划。

五类 Adapter 共用 ProviderDescriptor：id、kind、实现版本、支持范围、能力、运行依赖、config schema、操作白名单、作用范围及验证方式。kind 为 agent、sdd、tool、quality、environment。

## 2. 内部结构

- BuiltinRegistry：装载随产品发布的已知实现和版本 manifest，禁止重复 id。
- DescriptorValidator：检查 schema、能力引用、版本范围、作用范围和必需验证。
- ProbeCoordinator：按选项执行必要探测，缓存观察但不把旧观察当作当前可用性证明。
- ProviderFactories：构造无副作用 Renderer/Recipe，以及仅供 Executor 的 Driver。
- CustomSkillImporter：校验本地 skill 包和声明式能力映射，不加载任意用户 TypeScript/JavaScript 安装代码。

M1 不执行 provider 的版本命令，M7 负责这类受限探测；模型后端的 AnalysisProvider 实现属于 M2，不与这里的五类 Adapter 混成通用插件总线。

## 3. 各类内部职责

Agent Adapter：探测已知配置，描述 skills 发现、入口文档、MCP 注册、scope 和重载要求；Renderer 产生具体 selector/文件内容；Validator 分开检查配置存在与宿主实际加载。四种宿主分别验证，不把同名格式视为兼容。

SDD Adapter：提供受支持版本的原生能力映射、产物角色和不可取消 gate；安装配方限定其上游写入范围。resolveArtifacts 只提供产物位置协议，installer 不读取并推进研发任务。

Tool Adapter：OpenWiki、CodeGraph 分开描述软件安装、agent 注册、项目初始化和验证。对上游数据库/Claims/索引只调用官方入口；tool init 的资源效果与文件托管规则分开，不让 Core 重写其内部状态。Pi 不等于 Oh My Pi。

Quality Adapter/Recipe：组合用户选择的通用配置和已有检查入口，声明 hooks/报告配置及安装验证。没有测试就留下缺口，不实现项目测试体系。

Environment Adapter：GitLab 等系统声明配置资源、需求/MR/CI/部署等运行能力的入口。installer 只执行明确的安装配置动作；日常创建研发 MR、读取 CR 和发布由交付产物使用其独立入口，不保留 installer 作为远端代理。

## 4. 自定义 skill 包

最小包只需 SKILL.md，可附 scripts、references、assets。只有用户选择流程绑定时才要求 capabilities 描述：稳定 id、输入/输出角色、作用效果、依赖和调用入口。

包的文件路径规范化，拒绝越出导入根的引用。普通 skill 是项目资产，不获得安装器任意 shell 执行权。附带脚本可以作为声明的日常能力交付，是否允许执行仍受客户政策和宿主约束。

客户传入的能力 id 使用命名空间，重名或多个 provider 由 M3 要求显式选择。首版不做远程 marketplace、动态可执行插件发现或自动传递依赖下载。

## 5. 版本与副作用边界

支持清单按 provider 实现版本、上游版本、OS/架构和宿主范围声明。未知组合可以 probe，但不能因此自动标为完整兼容；返回 unsupported 或未验证条件。

ActionRecipe 使用结构化操作、argv 与环境引用，不把用户输入拼成自由 shell。凭据通过运行时引用传入，不写入 bundle 或 diff。Driver 报告真实资源 id、版本和后置条件，提供 reconcile 以支持恢复。

支持注册项退役的 provider 必须声明可移除对象、所有权证据、版本条件及恢复能力；没有该支持就返回人工处理项。停用某能力不等于卸载其共享工具或中断已有客户流水线。

同一安装器不能让 render 偷偷安装、probe 偷偷修复，或让 Driver 自行升级未在计划中的依赖。新的观察导致动作范围变化时重新规划。

## 6. 测试面

每个 Adapter 使用相同契约套件：只读方法无变更、渲染稳定、操作受限、错误结构、版本拒绝、退出码和恢复对账。宿主配置用真实格式 fixture 验证合并；选定上游版本另做最小集成验证。模型断言或同名配置文件不能替代真实兼容证据。
