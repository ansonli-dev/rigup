# Issue 90 · 在克隆后认领已有 Rigup 配置

[Issue 90](https://github.com/ansonli-dev/rigup/issues/90) · [核对基线 `51406c2`](https://github.com/ansonli-dev/rigup/commit/51406c25a348937ca0487aacde5bd4a3e691729c)

## 已核实

- 在 macOS arm64、Node 24.15.0、隔离 HOME、缓存和本机状态下，实际执行 Claude-only `init --agents claude --sdd none --defer-research --review`、`update --apply`、Git 提交和克隆。Git 跟踪了 `.mcp.json`、`.rigup/.gitignore`、`.rigup/rigup-mcp.mjs` 和 `CLAUDE.md`。克隆内 `doctor` 返回 3，缺少下一步。`update --review` 和无选项的 `init --review` 都生成 Codex 选择，要创建 `.codex/config.toml` 和 `AGENTS.md`。
- 对 `core.autocrlf=false` 和 `true` 的两个克隆执行显式 Claude 预览和应用，均返回 0 个受管目标写入。所有跟踪文件的 SHA-256 一致，`git status --porcelain` 为空。本地已有的等价内容合并支持此行为，`v0.5.0` 的变更记录与 `test/crlf-clone.test.ts` 也覆盖了这条路径。[变更记录](../../../CHANGELOG.md) · [现有克隆回归](../../../test/crlf-clone.test.ts)
- 空 Git 仓库的 `update --review` 也生成 Codex 预览。`doctor` 缺少下一步。仅把一个 Claude stub 放入 PATH 后，`detectCommands` 返回 Claude，非交互式 `init --review` 仍选 Codex。`loadOptions` 在未选 agent 时合并 Codex 默认值，CLI 仅在向导分支用探测结果覆盖它。[配置合并](../../../src/config.ts#L190) · [CLI 选择](../../../src/cli.ts#L478)
- 四宿主实装使用各自的 MCP 目标。另一个实际克隆带显式配置、自定义 MCP、模板和带二进制资源的技能。基线预览把已复制技能当作可复用来源，未为副本恢复所有权。将克隆中的启动器替换为 Git 标签 `v0.9.0` 的实际模板及版本后，现有预览在该启动器处因缺少基线而阻塞。启动器还校验 manifest 中的版本字段。[集成准备](../../../src/integrations/registry.ts#L78) · [启动器](../../../templates/rigup-mcp.mjs)

## 方案

可以将探测到的 agent 交给常规安装。这样能处理与当前产物等价的克隆，但常规安装也会创建缺失目标、产生升级差异、导入运行时配置或准备工具。采用专门的认领计划，沿用现有预览、所有权校验和 apply journal。仓库无需增加共享 manifest 或新格式。

认领恢复仓库中已验证的 agent 选择、受管目标和本机基线。以工作区此刻的内容及权限为准，保留所有项目文件字节。认领完成后由通常的 `update` 预览处理升级、补装、调研及显式配置改动。

### 识别

- 逐一检查 `integrations/agents` 注册的目标和键。Claude 为 `.mcp.json` 的 `mcpServers.rigup`，Codex 为 `.codex/config.toml` 的 `mcp_servers.rigup`，OpenCode 为 `opencode.jsonc` 的 `mcp.rigup`，OMP 为 `.omp/mcp.json` 的 `mcpServers.rigup`。用 `prepareCustomerMcp`、`projectMcpArgs` 生成 Rigup 期望的条目，再用现有选择器和 `equalOwnedContent` 比较。命令、完整参数、配置路径、脚本路径、host 参数及各格式的已生成字段都参与比较。允许解析器认可的等价格式。读取遵循受管目标的目录、链接、正规文件和歧义校验。禁止执行所读命令。
- 确认关联的 `.rigup/rigup-mcp.mjs` 是发布的版本化模板。对 LF/CRLF 作比较归一化，仅将版本赋值恢复为模板占位符后比对全文。已核对 `v0.5.0` 至 `v0.10.0` 的该模板家族及 research MCP wrapper。保留实际版本和字节。无法证实的旧格式给出待核对路径，用户仍可显式选择。
- 标记完整的 `.rigup/.gitignore`、Rigup 入口块或已识别的启动器/绑定提供安装痕迹。普通 `AGENTS.md`、其它 MCP 服务、同名用户服务和文本里的脚本路径均不能给出 agent 选择。仅有标记时要求显式 `--agents`。有 Rigup 绑定证据但缺启动器、存在畸形绑定、选中入口缺少必需的 Rigup 块或块链接悬空时，给出目标路径并停止自动认领。存在有效配置时保留与它无关的用户服务、共享入口及其他文件。恢复顺序沿用 agent 注册表。

### 命令与优先级

| 场景 | 行为 |
| --- | --- |
| 有 manifest、旧预览 `--apply` 或已批准的恢复/调研会话 | 继续使用已有选择与校验。损坏的 manifest 或状态照常报错。待恢复的本机 apply 优先于克隆探测。 |
| 无 manifest，完整 Rigup 绑定，普通 `update` 或 `init` | 选择全部恢复到的 agent。项目或 profile 的明确 agent 列表在集合一致时仍为权威。保留显式的 `projectRules: false`。TTY 与非 TTY 都直接给认领预览和 `update --apply <id>`，跳过向导。`--dry-run` 只预览。 |
| 完整绑定与项目或 profile 的显式 agent 列表冲突 | 普通命令提示用显式安装选择复审。现有配置与克隆文件保留。 |
| 无 manifest，无 Rigup 配置痕迹，无显式 agent 选择的 `update` | 返回需操作状态 3，说明项目尚未初始化并给出 `rigup init` 命令。带路径时复用 CLI 的 shell 引用。无保存状态的 `update --resume` 也进入此判断。 |
| 新项目的非交互式 `init` 缺少显式 agent 选择 | 用向导的 `detectCommands` 选用现有探测到的 agent，随后正常初始化。探测为空时返回 3 并请求 `--agents`。TTY 的默认选择和交互沿用原行为。 |
| 显式安装、变更或原生准备 | `--agents`、配置/profile 选择、现有准备命令和会话入口保留原有作用。只有配置声明的项目可继续走原显式安装流程，例如旧的自定义 MCP-only 配置。普通恢复入口遇到悬空的内建绑定时先请求修复或显式复审。 |

`doctor` 保持诊断为只读。无安装记录时，空项目的下一步为 `rigup init`，可认领项目为 `rigup update --review`，无法确定时给相应的显式选择或待核对路径，已有中断继续提示恢复原批准。用 `nextCommand` 和现有诊断原因提供这些语义。#85 负责诊断聚焦和布局，#86 负责友好标签。

### 预览与应用

- 预览说明“找到 Rigup 项目配置（{agents}）。应用将保留已提交文件，只添加本机安装记录。”明确显示可用的应用命令。保留现有 JSON 字段和退出码，增量提供 `claim: { agents }`。认领类型属于签名计划，现有无该字段的预览沿用原逻辑。
- 候选由已存在、可验证的受管目标组成。恢复内建 MCP 选择器、启动器、已标记的忽略和入口块。使用现有 ID、选择器、项目路径和文档链接验证。项目配置声明的自定义 MCP、模板、技能副本及可验证的固定目标复用正常候选和验证规则。有相同目录的已复制技能仍可恢复其文件 ID，外部原生技能维持复用。只记录匹配的自定义内容，含二进制及检出权限。缺失或无法证实的附加目标保留现状并指明待复审项，用户自行维护的 MCP 和语义产物保持原样。悬空的必需入口引用阻塞认领。
- 新预览内所有目标在应用前后字节及 mode 必须一致。整文件仍参与现有新鲜度检查，只把受管片段写到基线。保留项目/profile 与声明的自定义输入的新鲜度检查。应用复用同一根目录锁、原子写入、manifest 待提交校验和原审批恢复。对 Git 项目在预览及实际记录写入前验证 manifest 和 baseline 作用域有效忽略且未跟踪，遇到不安全的路径或忽略规则时停止并指明路径。
- 应用的唯一持久写入是忽略的 `.rigup/manifest.json`、`.rigup/baseline/` 和项目外现有的私有 journal/cache。没有运行时 `.env` 更新、项目检查、seed、宿主探针、工具安装或 provider 调用。claim 保留明确声明的 SDD/工具意图，禁止据此伪造本机 receipt。显式禁用的 project rules 保持禁用，其余已有调研入口标为待调研。若启动器嵌入较旧版本，manifest 的版本与它一致，预览校验仍使用当前实现版本。后续升级走通常的显式预览。

## 验收

1. 在隔离临时路径以 CLI 初始化 Claude-only 仓库，实际提交后分别用 LF、CRLF 克隆。无 manifest 时从 `update --review` 和 `init --review` 都得到可应用的 Claude 认领预览，预览无项目文件写入、无 Codex 目标、无向导。应用后 `written=[]`，安装记录选中 Claude，所有跟踪文件的字节、SHA-256 和 mode 一致，Git 状态为空。
2. 空项目 `update` 与 `doctor` 指向 `rigup init`，无预览 ID。隔离 PATH 分别验证仅有 Claude、无宿主和显式选择优先。四宿主及删掉两种宿主绑定后的探测集合准确。普通入口文档、无关文件、同名用户服务和仅带脚本字符串的用户服务均无误识别。悬空或畸形的真实 Rigup 安装给出路径并停止自动应用。
3. 实际克隆包含匹配的声明式自定义 MCP、模板和技能副本，另包含 `v0.9.0` 发布形态的启动器或不同语言的合法入口块。匹配的资产获得基线，所有已跟踪字节保持原样。预览后修改受管目标、添加 Rigup 绑定、改变权限或取消本机文件的 Git 忽略时，apply 拒绝过时批准。中断后可以按原 ID 恢复，重复应用仍为零目标写入。旧预览、显式安装和已装项目更新通过回归。
