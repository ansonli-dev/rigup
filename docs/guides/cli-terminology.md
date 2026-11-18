# Rigup CLI 中英术语表

同一个词在不同场景承担不同作用。优先写用户看到的对象、当前情况和可采取的操作。用表里的中英表述写终端原因与提示，保留命令、路径、配置键、环境变量名、产品名和机器报告字段。

| 源码或诊断术语 | 英文界面 | 简体中文界面 | 用法 |
| --- | --- | --- | --- |
| blocker | Issue to resolve first | 需要先解决的问题 | 开头可以直接说缺少什么或需要修正什么。 |
| evidence | Related files / Related links | 相关文件 / 相关链接 | 文件和链接同组时写「相关文件和链接」。 |
| host | Agent | 智能体 | 知道名称时直接写 Claude Code、Codex、OpenCode 或 OMP。 |
| managed file / block | File maintained by Rigup / Section maintained by Rigup | Rigup 管理的文件 / Rigup 管理的这段内容 | 说明 Rigup 管理整份文件还是其中一段。 |
| write lock | Another operation is updating files | 另一个操作正在写入文件 | 仅在确认写入仍在进行时使用。恢复记录待处理时提示「请先检查上次未完成的写入」。 |
| CLI probe / MCP probe | Check the agent command / Check the MCP connection | 检查智能体命令能否运行 / 检查 MCP 是否已连接 | 根据实际检查的内容选用。 |
| pin | Approved plugin version / Approved commit | 已确认的插件版本 / 已确认的提交 | 审批前用「待确认的版本／提交」。只给出 SHA 时称为提交。 |
| marketplace | Plugin marketplace | 插件市场 | 例如「Claude 插件市场」。命令中的 `marketplace` 保留原样。 |
| native workflow | Agent-provided workflow | 智能体提供的工作流 | 能用 OpenSpec 或 Superpowers 名称说明时用具体名称。 |
| runtime input destination / source | Where to set it / Where it came from | 设置位置 / 来源 | 来源可写「项目文件」「环境变量」「项目配置」或「仓库远程地址」。 |

doctor 的普通视图用功能名，例如「Rigup 调研启动器」或「Claude Code 的 Rigup MCP 配置」。维护时可用 `--verbose` 查看诊断 ID。引用实际文件时保留可复制的路径。
