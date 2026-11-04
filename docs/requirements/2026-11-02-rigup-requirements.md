# Rigup：需求与约束基线

日期：2026-11-02。本文记录用户需求；脚手架模块与安装协议见[安装与更新设计](../superpowers/specs/2026-11-02-rigup-design.md)，研发 skill 划分与执行协议见[安装后的 skills 设计](../superpowers/specs/2026-11-02-installed-skills-design.md)。

## 1. 产品目标

提供智能 CLI，帮助新项目和老项目快速 setup rigup；能分析现状并动态生成配置，后续支持重新分析和增量更新。脚手架 setup 完成后退出，仅在更新 rigup 等维护场景再次使用。持续研发由已安装到项目中的 skills 牵引；skills 不依赖脚手架 CLI，也不将 rigup 配置入口与研发入口混为一组。

## 2. 兼容与可选能力

- 支持 Claude Code、Codex、OpenCode、Oh My Pi 等 coding agent；多 agent 指兼容多种工具。
- 支持 Superpowers、OpenSpec、Spec Kit 等开源 SDD 框架，保留所选框架的能力与产物。
- 引入 OpenWiki 承载 as-is，配置 MCP，并支持 GitLab 流水线自动更新。
- 引入 [CodeGraph](https://github.com/colbymchenry/codegraph)，初始化项目索引并配置 MCP。
- 根据项目现状提炼代码规范，建立文档体系，生成宿主所需 AGENTS.md、CLAUDE.md 等入口。
- core 与扩展分离；内置默认扩展，允许用户通过自定义 skill、脚本、模板和 MCP 配置接入客户环境。

## 3. 流程要求

- 流程包装主要串联所选 SDD 框架的原生能力，并加入项目和客户上下文。
- 内置流程按需启用，允许使用自定义 skill；首版不建设模板编辑系统。
- spec-gen、code-gen、deploy 是需求讨论中的举例，不是已确定的 skill 清单。
- skill 应按完整工作目标划分，合并可连续执行的步骤，只在需要人类决策或必须遵守的审批处暂停。
- 需要明确输入输出、执行顺序、完成条件、状态、恢复和人类决策点，不能只列功能名称。

## 4. 工程反馈与职责

脚手架负责发现、安装、配置和接线：Git hooks、所选通用静态工具、已有构建/测试命令、CI 与报告，并验证接入是否正确。

开发者负责测试体系、业务用例、fixtures、测试环境、自定义架构规则、业务验收、质量目标及项目缺陷修复。setup 发现缺口后报告所需输入，不自动补业务测试或搭建测试环境；后续研发任务可由开发者授权 agent 辅助完成。

接入状态与项目检查状态分别展示。缺少测试不能报告行为验证完成；项目测试失败不等于脚手架安装失败。

## 5. 维护约束

- 保留已有配置及用户修改，更新时处理所有权、差异和冲突。
- 允许同项目配置多个 coding agent，共享项目事实与选择。
- 根据宿主和上游的真实能力适配，不伪造 skill、命令或支持承诺。
- 客户系统是可选接入；组织策略和高风险操作范围由客户决定。
- 分析执行方式参考 OpenWiki，提供独立模型运行与宿主 agent 两种入口。

## 6. 参考资料

- [Harness design for long-running application development](https://www.anthropic.com/research/harness-design-long-running-apps)
- [Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)
- [The AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)
