# Rigup v0.3.0 验证报告

2026 年 11 月 9 日。基线为 v0.2.4 源码 `cf7cd0a` 和该版本的 Windows x64、WSL2 实测。新验证使用独立的 macOS ARM64 夹具、本机 Windows 11 ARM64 虚拟机和 GitHub Actions。安装验收、原生宿主连通性、模型交付和可重复的模拟探针分别计证。[历史验证](status.md) · [CI](https://github.com/ansonli-dev/rigup/actions/workflows/ci.yml)

## 调整核对

- **P1–P2**　Windows 用 Job Object 管理 live 探针和写入进程。关闭交互流时核对根进程及后代已退出。工具安装用每次独立、由持久记录验证归属的暂存目录。可从 `update --resume --review` 找回原审批，独立复核后续跑。没有可验证身份的已派发记录会阻止新写入。
- **P3–P5**　MCP 配置的 JSON、JSONC 和可比较 TOML 值按结构判等。真正的合并与审批仍以原始内容和权限为准。Windows 私有 ACL 错误区分拒绝项和检查失败。临时重命名失败按有界间隔重试，每次重试重新核对目标和父目录。已批准的旧原生工作器配方可以按可验证的 v0.2.4 摘要恢复。
- **P6–P8**　提示明确 `scope`、`consumers` 和 `gaps` 为字符串数组。输出入口兼容单字符串，后续仍按数组和引用范围严格验收。参考 OpenWiki 的五工具交接，增加可续跑的 Rigup MCP、独立内容验收和预览交接。终端支持 Anthropic 和 OpenAI 兼容 provider，模型覆盖和密钥引用与项目文件分开。`.rigupignore` 过滤研究读取和引用，原生工作流与可发现的检查继续参与安装。[OpenWiki](https://github.com/langchain-ai/openwiki) · [使用手册](../guides/usage.md)
- **P9、P16**　默认测试隔离 provider 环境和 npm 缓存。便携启动器测试复制 Node 文件，避免硬链接改变宿主文件元数据并触发并发 harness 测试的版本变化保护。CI 包含 macOS、Linux 和原生 Windows。
- **P10–P14**　核对最新工具及锁定版本的兼容边界。CodeGraph 1.6.2 的默认 MCP 代理在 stdin EOF 后退出，剩余进程属于共享 daemon 的空闲策略。项目安装入口改用相对路径，从仓库子目录定位宿主配置。链接形式的 `.rigup` 会给出 junction 或符号链接处理说明。Windows 可通过核验后的本地 npm prefix 启动 OpenSpec。
- **P15、P17**　原生 HTTPS MCP 支持 bearer 变量引用，沿用宿主审批和服务权限。交接记录覆盖进程清理、MCP 注册范围、WSL PATH、Windows Runner 路径和费用口径。旧实验的 12 个显示值合计 **$52.09**，T1 Superpowers 的单格比值约 **21.3×**。T3 的退款终态已写进新题面。[验证交接](../guides/external-validation-handoff.md) · [基线明细](status.md)

## Rigup 本体

- v0.3.0 的 macOS 默认检查通过 **519 项**，26 项按平台或 opt-in 条件跳过。类型检查、编译、文档链接和 npm 包检查均通过。npm audit 报告 0 项漏洞。ARM64 便携包通过自身运行时的 MCP 握手和锁定工具安装验证。
- 在 macOS 上用打包安装物跑过基础预览、独立 apply、doctor、进程中断恢复和零写入重放。真实 OpenWiki 0.7.3 安装在模拟 npm 部分写入和 controller 被终止后恢复。同一审批先被仍存活的 writer 阻止，writer 退出后才通过真实 npm 安装发布并核验回执。真实 CodeGraph 安装、索引、业务符号查询、取消和重新初始化另行验证。
- 用公开 npm v0.2.4 在 CodeGraph 软件安装后、索引初始化前中断，删除普通预览缓存，再从另一安装路径用 v0.3.0 恢复原审批。复核后完成索引初始化并核验回执，重放写入为零。
- Claude Code 2.1.319 从 Unicode 和空格项目的根目录、子目录，以及对应的新 clone 连接 Rigup MCP。Codex、OpenCode 接线也通过实际 stdio 握手。新 clone 的共享接线可启动服务，研究需先建立本机归属。首次预览保护了七个无可信基线的现有文件。留存后按新的本机预览重建，接线字节一致。
- 通过 JSONL 驱动实际安装的 v0.3.0 MCP，验证不同根路径和排除引用被拒绝、阶段可续跑，提交内容后须通过单独验收任务，写入前必须独立应用。自动测试另外覆盖生效 `scope`、语言、缓存丢失后重建和无变化更新。CLI provider 使用本地合成响应验证路由、多工具调用、用量预留、模型覆盖和密钥隔离。
- 原生 Codex 0.166.0 和 OpenCode 1.18.5 的技能及 MCP 发现通过。真实 Codex app-server 连接隔离 HTTPS MCP，未认证请求返回 401，专用变量认证后读取版本 0 并写到版本 1，进程正常清理。它使用合成服务和 RPC，适用于确认传输与授权引用。
- CodeGraph 1.6.2 是当时的 npm latest，完整性与锁一致。macOS ARM64 与 Windows 11 ARM64 各运行五个直接及接线形态的用例。两边均能查询 `createOrder`，EOF 后接线代理分别约 5 ms 和 10 ms 退出。3.5 秒空闲配置下，EOF 和强制客户端退出后 daemon 与 watchdog 均在 4.1 秒内退出。禁用 daemon 的对照没有残留。使用的是受控客户端和缩短的空闲窗口。[CodeGraph v1.6.2](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.2)

## 已安装 harness

- **缺审批。** 真实 Codex 读取已安装的 `change-deliver`、项目参考、客户参考和原生 OpenSpec apply 入口，拒绝执行并拒绝声称检查通过。该场景使用锁定 OpenSpec 1.16.0。
- **批准后交付。** 同一 T4 夹具先用 OpenSpec 1.16.1 原生 CLI 准备接线，再用 npm 安装的 Rigup 配置 Codex。真实模型在准备阶段生成 proposal、specs、design、tasks，OpenSpec 严格验证通过，批准前业务差异为空。独立审阅并批准该夹具的范围后，新会话按 `change-deliver` 交付。项目可见测试 **10 项通过**，独立隐藏用例 **5/5**。模型为 `gpt-6.1-sol`。准备和交付分别记录输入 605,500 和 534,879 tokens，输出 4,444 和 3,911 tokens，输入含缓存。该次运行属于 Codex 补充证据。
- **Claude v3 设计。** 默认矩阵为 T4–T6 × A/R/S/B × 3，共 36 格、60 个计划会话。T5 在同一工作目录用三段独立会话，T6 的标准澄清只在首次有效询问且未编辑代码时提供。T1–T3 与 T7 可单独选择。S/B 使用同一 SDD 原生入口和版本。规则生成费用单列，任务取每个会话最后一次累计估算再相加。隐藏用例的分母固定，超时、基础设施失败和行为失败分别记录。[运行器和夹具](https://github.com/ansonli-dev/rigup/tree/main/test/harness-e2e)

## 版本差异和跳过项

- **Claude 模型矩阵。** 本机状态显示已登录，但 Claude Code 2.1.319 的无工具实际请求返回 OAuth 令牌已吊销。隔离运行器预检也报告认证不可用，显示费用为 $0。36 格均跳过。真实 Claude 的工具连接是独立的无模型证据。矩阵费用、澄清率和各条件质量差异待重新登录后测量。
- **上游工具。** OpenSpec latest 1.16.1 可以用官方 CLI 手动初始化，Rigup 的自动初始化继续核验 1.16.0。Spec Kit 1.3.2 实际生成 `speckit-*` Claude skills，Rigup 预览绑定通过。Superpowers 7.0.2 在隔离 Claude 配置里安装成功，Rigup 预览按 7.0.1 锁拒绝绑定。OpenWiki latest 0.9.0 未用于集成验收，实测锁定的 0.7.3 安装、握手、规划与续跑。新一轮完整 wiki 内容生成待测。[OpenSpec 发布](https://github.com/Fission-AI/OpenSpec/releases) · [Spec Kit 发布](https://github.com/github/spec-kit/releases/tag/v1.3.2) · [Superpowers 发布](https://github.com/obra/superpowers/releases/tag/v7.0.2) · [上游锁](upstream-lock.json)
- **环境。** Oh My Pi 的隔离环境没有可用模型。企业 GitLab 和 Colla 缺少本轮获授权的可写项目与凭据，本机也没有在运行的 GitLab 测试服务。真实企业写入和目标 Runner 留作对应环境验收。Claude 的 Windows x64、WSL2 模型交付仍引用 v0.2.4 证据。
- **便携接线。** 便携安装包自带 CLI 运行时。共享的项目 Node MCP 入口要求启动 agent 的 PATH 能找到 Node.js 24 和 Rigup。这样同一份接线可跨平台及 checkout 使用，Windows 路径也可以用已安装的 npm 包入口启动。

## 发布校验

- v0.3.0 合并提交为 `93080d55d7c49d60bc6f2289e8c0ebab40d17482`。对应的分支检查在 Linux、macOS 和原生 Windows 通过，Windows 为 **505 项通过、40 项条件跳过**。发布工作流校验 macOS 与 Linux 的 ARM64、x64 四种便携包。[合并 PR](https://github.com/ansonli-dev/rigup/pull/6) · [三平台 CI](https://github.com/ansonli-dev/rigup/actions/runs/42642395836) · [发布工作流](https://github.com/ansonli-dev/rigup/actions/runs/42643473853)
- 公开 npm 的 `latest` 为 0.3.0，SHA-512 与发布清单和 GitHub 下载的 npm 归档一致。macOS 的干净 npm 安装返回 0.3.0。下载的 Apple Silicon 便携包通过 SHA-256 和冒烟检查，默认安装脚本也在独立前缀安装出 0.3.0。[npm](https://www.npmjs.com/package/@ansonli.dev/rigup/v/0.3.0) · [GitHub 发布](https://github.com/ansonli-dev/rigup/releases/tag/v0.3.0)
- 本机 Windows 11 ARM64 虚拟机使用 PowerShell 7.6.9 和 Node.js 24.22.1，实际从公开 npm 安装 0.3.0。Unicode 和空格路径的基础预览、独立 apply、doctor、零写入重放通过。从子目录启动 MCP，列出五个工具并收到分析任务。模型请求为零。虚拟机中未发现 Claude CLI 或可用 WSL 发行版。
