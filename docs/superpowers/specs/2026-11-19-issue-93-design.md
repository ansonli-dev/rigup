# Issue 93 · MCP 优先提供项目指引和配置

[Issue #93](https://github.com/ansonli-dev/rigup/issues/93) · [核查基线 `ee6648c`](https://github.com/ansonli-dev/rigup/commit/ee6648c7147f642f88d3ff9381d58a1b9765da85)

## 已核实

在 206 条可读路径的合成 Maven 仓库中，MCP 返回 200 条，缺少根 `CLAUDE.md` 和 `pom.xml`。同一 reader 的阶段证据选样包含这两项。前者直接截取清单，后者已有角色上限、锁文件过滤和目录交错。[MCP 任务](../../../src/research/mcp-workflow.ts) · [分析选样](../../../src/analyzer/stage-context.ts)

## 设计

在 MCP 重复实现排序会使两条研究入口继续分化。把完整清单发给 agent 会增加任务负载。选择复用阶段证据已有的分析选样，以同样的顺序输出路径。

- 只用当前 reader 清单，输出当前角色上限内的唯一路径。锁文件和不属于选样角色的编辑器噪声跳过。实现与测试路径在同级目录间交错取样。
- 现有规则识别的根指引先于嵌套指引，根项目清单先于模块清单。模块数量超过池上限时仍能看到项目入口。
- MCP 在 analysis job 公开 `seedPaths`，并说明它是可读清单中的样本，宿主仍可使用已授权的搜索和读取查找相关来源。读策略、引用权限、任务 ID 和其他阶段已有字段继续由原有逻辑决定。
- 使用真实 MCP 初始化和提交覆盖种子排序，以及引用可读但未入选路径的边界。
