# #88 原生 Superpowers 准备输出

## 目标

让用户能确认哪几个宿主会执行、执行什么、写到哪里。准备结束后，每个新就绪的宿主只需一行，仍受阻时给出原因和一项可执行的下一步。适用于首次 `init` 向导和独立的 `init --prepare-native`。 [Issue #88](https://github.com/ansonli-dev/rigup/issues/88)

## 基线证据

工作树 HEAD 为 `51406c25a348937ca0487aacde5bd4a3e691729c`（v0.10.0）。在 macOS arm64、Node 24.15.0，通过 `runCli` 驱动确认选项，使用临时项目、HOME、状态目录、假宿主与本地响应。重放了以下情况。

| 场景 | 旧行为 |
| --- | --- |
| 中文首次向导，Claude 可准备，OMP 元数据下载失败，关闭 OMP 的 Claude provider | 初次批准前显示 Claude 的探针、5 个写入条目、OMP 阻塞详情、agent 指示及输入身份声明。首次提示未指明只批准 Claude。两次批准后 Claude 就绪，OMP 保持 `download-failed`，退出 3。 |
| Claude 项目安装后 OMP 复用，有可用 OMP pin | 批准前出现 `plugin link`、tarball、SHA-512、`.env` 检查及 7 个 OMP 写入条目，其中 `.omp` 本身出现两次。获批后只运行了 Claude 的探针、marketplace 和 install。OMP 只请求了元数据，直接复用且没有运行 OMP CLI。退出 0。 |
| OMP 元数据下载失败，Claude 项目安装后仍能复用 | 计划中的 OMP 阻塞在执行后清除。最终两宿主均就绪，退出 0。初始阻塞不意味着复用失败。 |
| OMP 假可执行文件经受保护的进程路径，在 stderr 写出 `EPERM` 后退出 19 | 失败 link 的 `changes: []`。尽管已暂存 Rigup 软件包，宿主写入未被观测到。文本只有通用失败原因和退出码，还给出 uninstall 及 6 条证据。完全相同的路径已在 `toBlocker` 内去重，剩余条目跨父子目录。 |
| 非交互 `--json`，OMP 元数据下载失败 | stdout 为单个 JSON，`nativePreparation` 含 `kind`、`hosts`、`blockers`、`progress`。agent 说明在 stderr，JSON 内无对应字段。 |

另外运行了 18 项现有隔离用例，覆盖显式批准、计划变更复核、OMP 复用、已识别来源无需执行和非交互输出，全部通过。重放使用文本驱动，Windows 原生权限与真实终端自动换行、颜色仍待验证。

`host-setup/index.ts` 的 `nativeSetupInteraction` 将详细计划、逐步进度和阻塞报告直接写入所有文本模式。`runLocalizedCli` 已识别 `--verbose`，两个原生调用点没有收到该模式。实际安装步骤没有捕获 stderr，`protectedOperationCommand` 在版本探针场景也只收集 stdout。泛化错误发生在渲染之前。 [原生交互与执行](../../../src/integrations/host-setup/index.ts) [CLI 入口](../../../src/cli.ts) [受保护的进程执行](../../../src/installer/operations.ts)

## 设计选择

只用 `--verbose` 隐藏现有行会保留含糊的批准范围，也无法表达 OMP 备用路径。另建报告模型会重复现有计划和结果语义。采用现有 `NativePreparation`、`NativeProgress` 和 `describeOutcome` 的文本投影。直接使用已批准的操作与路径，保留结构化报告作为机器接口。

### 批准

- 默认每个宿主每次批准最多三条换行分隔的文本行。已就绪一行，跳过该宿主的批准。可执行宿主用状态、命令或实际操作、写入目录三行。阻塞宿主用一行概括原因，若可能复用 Claude 再加一行交代复用条件。全局批准提示和选项位于这些宿主块之后。
- 命令来自获批步骤。OMP 写入显示包名和已选版本。若实际步骤是 `omp plugin link`，展示该命令并将 store 作为已批准的本地参数。在 #84 的 Windows registry 路线上，使用计划所选的 pinned `omp plugin install … --json` 与 OMP 目录。`omp plugin install` 只在实际计划执行该命令时展示。两个已知 Claude 步骤按执行顺序共用一条命令行。保留已知 Claude 目标的版本与完整提交 SHA，若初次只批准 marketplace，则在命令行说明将另行批准安装。第二次批准仍在拿到目标后显示其项目范围、精确 SHA 以及本步的写入目录。
- 按当前批准涉及的 `Step.writes` 汇总目录。使用 recipe 区分文件和目录，文件合并到所属目录。合并已声明父目录覆盖的同类子目录，保留不同项目、宿主配置、状态及 store 的边界，按照步骤原有顺序显示。Claude 的项目 `.claude` 标明共享设置。若用户状态文件是 HOME 根下的 `.claude.json`，以 `~/（仅 .claude.json）` 表示该项，避免把整个 HOME 合并成可写范围。使用宿主有效 HOME 缩写目录，保留外置目录及自定义 profile 或 XDG 路径。比较完整路径段，Windows 使用其原生路径比较。若 OMP 插件、状态和缓存都位于 `~/.omp`，只展示该目录一次并注明包含插件目录。Rigup 包 store 如在批准的写入范围，也显示其目录。私有工作目录与写入锁留在详细信息。
- Claude 有计划且 OMP 有可执行步骤时，OMP 先尝试复用，只有在已批准的备用操作仍必要时才执行。命令和范围都标为备用。若 OMP 初始已阻塞，提示它仍可能通过 Claude 项目插件就绪。批准仅覆盖 Claude 等有步骤的宿主，OMP 此时没有独立命令或写入范围。混合提示列出会执行的宿主和独立准备受阻的宿主。全部就绪、全部受阻、inspect、项目 review 策略及非双 TTY 沿用现有退出和写入行为。
- 探针与工作目录、锁、完整包 pin、逐项计划路径、`.env` 检查、版本差异、观察到的变更和证据均可在 `--verbose` 查看。英文和中文都删除输入者身份声明。交互 TTY 在任一详细级别均无 `agentNote`。重定向或其他非 TTY 以及 `--json` 仍可在存在阻塞时输出一次，`--json` 下走既有 stderr。

例如 OMP 暂时无法单独安装时的默认批准内容。

```text
Claude：尚未安装 Superpowers
  将运行：claude … marketplace add … --scope project（插件安装将另行批准）
  会修改：<项目>/.claude（共享设置）、~/.claude、~/（仅 .claude.json）
OMP：无法获取 Superpowers 软件包（download-failed）
  若能识别 Claude 项目插件，OMP 将直接复用。
? 只批准为 Claude 准备 Superpowers？OMP 的独立准备已阻塞。
```

### 结果

- 根据复扫结果输出。已完成的安装是一行，如 `OMP：Superpowers 已安装，请重新打开 OMP。` OMP 复用时，一行说明已复用 Claude 项目插件并请重新打开 OMP。始终就绪的宿主无需在结果中重报。仅完成 marketplace、版本探针或 store 暂存时不报已安装。
- 每个仍受阻的宿主给出一行原因。消费 #84 提供的已截断、过滤用户目录与敏感内容的 stderr 摘要，保持一行，含可用的子进程退出码与 blocker code。`EPERM`、`EACCES` 映射为权限问题并保留错误码与安全摘要。未知原因附安全摘要，缺省回退到现有 blocker 理由。计划下载失败等没有子进程的情况展示已有 blocker code 与原因。
- 每次需要处理的准备只给一个下一步，再提示 `详情加 --verbose`。选择顺序为未核实的写入、执行时新阻塞、计划时已知的阻塞或人工宿主，同类按计划顺序。未核实写入先确认该宿主准备进程已退出。权限错误检查批准的宿主写入目录。缺 CLI 则让其在 PATH 可用。禁用则检查宿主插件与技能设置。预案元数据不可用则在可访问官方仓库的终端运行原准备命令。其余未知或目标已变化时提供加 `--review` 的原准备命令。只有人工宿主时可给它的现有手动步骤。非双 TTY 且有可执行步骤时，说明双 TTY 批准前提并给一个准备命令。项目要求 review 时给只读审阅命令。
- 卸载只在详细文本中建议，并要求产生该建议的具体步骤有非空 `changes`。计划条目、store 暂存、另一宿主的写入、先前 marketplace 的写入均不能替代该步骤的写入证据。默认失败文本不重复逐步状态、证据或通用重试提示。
- 取消或返回沿用 `130` 或 `'back'`。取消前若已验证其他宿主安装，可显示该宿主的成功行。取消本身不产生失败修复建议，也不提前发出重载提示。详细模式可以回看已观察到的步骤。

## 兼容和交接

- 保持批准值、无默认批准、双 TTY 门禁、Claude 的第二次独立批准及执行前复核。保持 planning 与执行顺序、锁、pin、下载校验、目的地与回执规则及退出码。`describeOutcome` 的最终就绪判定和 `report` 的内容仍供两个入口使用。
- JSON 保留现有字段、值语义、语言无关性和 stdout 路由。所有计划步骤、原始结构化证据与卸载建议仍是机器报告的一部分。卸载的变化门槛作用于文本建议。若 #84 添加安全诊断字段，应为可选并沿用它的来源与约束。`--verbose` 只影响文本。
- #84 管理 `executeHost`、受保护的进程、OMP 策略和安全诊断。#88 的接点是实际步骤描述及其写入路径，外加失败 `NativeProgress` 上的可选安全 stderr 摘要。使用 #84 定义的 `stderrSummary?: string`。测试夹具的 `launch` 可由 #84 接收 `stderr?: string`。`NativeProgress.code` 保持数字或 `null`，`blocker.code` 保持错误类别字符串。渲染器只消费安全字段。
- #87 管理原生段之外的 `cli-output.ts` 结果、取消和重载。#88 负责原生段的已验证宿主成功行、失败原因和下一步。移除原生段执行前的通用重载行。#87 消费用于判断部分写入或取消的既有报告，包括 `progress[].step/stage/status/changes`、`installStatus` 与退出码。共用 `cli.ts` 的改动分别限于原生调用参数和外层展示。#87 的写入观测回调可与 #88 的显示参数并存。
- #85 管理 `init/update/doctor` 的整段脱敏快照与真实运行预期。#88 验收基于原生段与批准时点的局部断言。合并时从 #85 的 `display.verbose` 传入详细模式。

## 验收

1. 在两个入口的默认文本中，缺失可执行、初始已阻塞、已就绪的宿主都满足每次批准三行上限，同一个批准块中目录无重复。全部已就绪时没有批准、网络请求或命令启动。
2. 部分阻塞时，提示精确匹配获批宿主。OMP 复用成功时没有独立写入或进程，即使初始缺元数据也能转为就绪。未能复用且有获批备用计划时仍可执行。无备用计划时保持受阻。
3. Claude 首次 marketplace 与稍后的安装有各自的批准，两个时点展示对应范围。已知 SHA 与版本漂移继续阻止执行。取消、返回、inspect 和重定向的写入界限保持现状。
4. 失败显示安全 stderr 摘要与可用错误码。空 `changes` 在任何文本模式都无卸载建议。成功只生成每个新就绪宿主的一条完成行。默认故障一次只给一个下一步。
5. 详细文本仍含诊断，任一 TTY 模式没有 agent 指示，任一模式没有输入身份声明。英文和中文 JSON 的既有字段和值保持一致。
