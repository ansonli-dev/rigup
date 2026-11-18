# 实施 <change ID>：<observable outcome>

在原生变更目录内填写此模板。替换每个占位项，在命令中使用仓库相对路径，并按新 GOAL 文件的位置重写 Markdown 链接。链接当前每一份 Spec 和 Plan 产出物，包括拆分后的文件。填写完成后移除此段说明。

## 已审阅的变更

- 变更 ID 与原生工作流：<exact ID and selected workflow>。
- 结果：<observable behavior>。保留 <out-of-scope behavior>。
- Spec 产出物：<links to every current requirement/scenario file for this change>。
- Plan 产出物：<links to every current design, implementation and verification task file for this change>。
- 原生实施入口：<installed skill or command and its resolved path>。
- 原生状态与指令：<current evidence and any remaining prerequisite>。
- 实施批准：<pending, or explicit human approval and its current instruction or applicable, verified project-designated record; identify the approved change, revision and full reviewed write scope, and any remaining gate>。

## Reviewed write scope

- <repository-relative business file>：<permitted change>。
- <repository-relative native task file, when applicable>：<task checkboxes/status and verification evidence to update>。
- <any other actually planned repository-relative evidence/record file>：<defined record write; include this GOAL itself only if that write is explicitly reviewed>。

列出交付将修改的每个文件。按此工作流的实际路径，将原生任务指令和下方的所有证据写入位置与该清单核对。移除不适用的条目。出现在链接中的输入文件也需要列明用途并经过写入范围审阅，方可修改。

## 交付指令

实施前请阅读[已安装的交付技能](../../change-deliver/SKILL.md)、[项目上下文](project.md)和适用的原始指南。使用同一批已审阅产出物，遵循所选原生实施入口。实施批准缺失、仍待批准、过期或与范围不符时，就绪检查和交付均受阻。开发者随后提交就绪检查生成的准确 `/goal` 命令，才会启动已经过批准的范围。其他原生前置条件和批准仍然适用。范围发生变化时，重新审阅并取得批准。宿主如果不支持 `/goal`，请用此 GOAL 和同一批批准调用 change-deliver。

## 完成标准与证据

| 验收标准 | 原生实施任务 | 验证命令或场景及工作目录 | 可观察的通过条件和证据写入位置 |
| --- | --- | --- | --- |
| <material scenario, including rejection/preservation cases> | <task link/ID> | <existing check and cwd, or an explicit manual observation> | <expected result and where actual results will be recorded> |

完成每一行，执行必需的项目检查，只在已审阅的位置记录实际结果。完成结论须有可观察的证据。报告无法执行的检查与阻塞项，保留它们的待验证状态。

## 提交、推送和 MR 的范围

- 获准的提交、推送和 MR 操作：<explicit scope or not requested>。
- 每次推送前，根据已批准的范围检查所有待推送提交，修复已确认的问题，再运行受影响的检查。推送前记录审阅的提交范围和结果。
- 如果包含 MR 跟进：<confirmed platform, project, MR identity and configured customer command/MCP/CLI from project guidance>。
- 必需的 CI 检查和已配置的 AI 审阅者：<existing project configuration and how completion is observed; no new CI/reviewer configuration>。
- 完成证据包括最新 MR head SHA、该 SHA 的全部必需检查通过、已配置的 AI 审阅明确完成，以及每条发现的处理记录。结束前再次读取 head。审阅仍在等待、检查失败，或通过结果对应早期 SHA 时，工作仍未完成。讨论为空也须确认审阅已完成。局部修复范围内已确认的问题，验证并审阅待推送提交，推送后继续跟进新 SHA。记录有争议发现的证据，把扩展的范围交回审阅。
