# Issue 78 · 单用户开发机上的 Rigup

[Issue 78](https://github.com/ansonli-dev/rigup/issues/78) · [核实基线 v0.8.0](https://github.com/ansonli-dev/rigup/commit/5ff4dff0ef536d5a46227f07ad006d89f2f362f6)

## 目标和取舍

开发者应能在带 Maven 或 Gradle wrapper 的 Windows 仓库、monorepo 子目录、Git worktree 和宿主内正常完成安装与更新。改业务代码、项目检查正常退出、恢复一个中断的研究会话，都应遵循各自的真实结果。Rigup 继续保护用户文件、安装审批、下载 pin 和密钥。

| 落点 | 结果与代价 |
| --- | --- |
| 仅修项目根目录的扩展名检查 | 快速恢复部分 Windows 项目。`.cmd` 启动、worktree 和其余已核实的误拒仍需后续修复。 |
| 按清单一次删除所有状态与校验 | 改动表面最小。跨进程恢复会丢失已批准的目标和完成进度，部分写入后重新三方合并会失去原来的基线。 |
| 按四批替换为直接检查 | 采用。每批有独立红绿测试与可运行状态。保留可直接验证的输出、目标、引用和恢复前置，并在同一版本发布。 |

ponytail 取舍是复用现有解析器、原子写入、三方合并、包校验、状态位置和 CLI。优先删掉重复身份、扫描和协议层。文件行数由验收结果决定。

## 已核实

- 用 v0.8.0 的已构建 `assertProjectScope` 在 macOS 触发 Windows 分支。仅加入 `mvnw.cmd` 即得到 Issue 中的原文错误。同一探针验证父目录 `.git` 和 linked `.git` 文件也被拒。原生 Windows 的进程与文件系统行为由实现阶段的 Windows CI 补验。
- 在隔离 HOME 下实跑 Claude Code 2.1.273 的 marketplace add 和 plugin install，使用本地测试插件。在 monorepo 子目录和真实 `git worktree` 中，回执均指向选定的项目，父仓库及无关设置原样保留。OMP 18.1.13 在隔离 HOME 的命名 XDG profile 中完成本地测试包链接，保留了无关条目。两者均未调用模型。
- v0.8.0 中，一个与安装无关的源码改动足以使已批准预览失效。由测试进程启动一个短期子进程后退出 0，会得到 `Check left a process running`。普通 TypeScript `password: string`、带注释的 tsconfig、`.env.example`、`--max-token=100`、局域网 HTTP 和 `?api-version=` 也都有当前拒绝路径。
- Windows 上 Rigup 已能解开特定 Claude npm shim，但普通 `.cmd` 仍无法交给只支持 `.exe` 的执行器。Claude 另有直接读取 `.git/config` 的代码，linked worktree 要一并处理。现有测试和 WSL CI 有意固化了部分旧拒绝，需改为验证下面的用户行为。
- 隔离 checkout 在 macOS ARM64 和 Node 24.15.0 上执行完整 `npm run check`。1,154 项通过，91 项跳过，类型、构建、文档与隔离包安装通过。

## 约束

- 支持单用户自己的开发设备和信任的本机工具、项目、配置及包管理器。将同用户恶意进程、本机记录伪造、ACL 属主认证、启动器植入及 inode/TOCTOU 攻击排除在产品保证外。
- 保留原子提交、所有权和三方合并、目标文件的并发编辑检测、实际写入范围、seed 只创建一次、用户同意和简单互斥。常规非 TTY `init`/`update`、显式 `--apply` 和显式 `--prepare-openspec [--install-scope …]` 沿用各自的写入授权及范围默认值。`--dry-run`、`--review` 对项目、宿主配置和 npm 前缀只读，可以保存私有预览。原生 Superpowers 的写入需要 TTY 里明确批准。需人工动作才使用 pending 退出码。
- 保留原生 SDD 必须入口、用户显式禁用、有效宿主作用域、版本约束、确认过的 npm 目的地、下载 SRI、`--ignore-scripts` 和安全解包。锁按 Git 根以外的实际资源分别覆盖项目目录、共享宿主状态和 npm 前缀。跨项目命中同一宿主或前缀时也互斥。
- 私钥、实际凭据和二进制仍从 Rigup 传给模型的证据中排除。私密状态仍在项目外，`.rigup/.env` 及其写入临时文件始终由有效 Git 忽略规则覆盖且未跟踪。诊断只给路径、设置键、原因及可执行动作，按现有策略过滤 URL 凭据、命令输出和秘密值。宿主独立调用自己的读取工具属于宿主自身权限。
- 保留 Node `^22.19.0 || >=24.2.0`、现有 CLI flags、JSON/MCP 协议的已用字段、四宿主与现有 SDD。保持已完成的受管安装可升级。v0.8.0 的未完成安装仍以原批准、pin 和文件状态为权威，须能继续或在具名的实际冲突处要求对账。

## 第一批 · 原生准备

- 删除 `assertProjectScope` 的父目录、间接 `.git` 和扩展名拒绝，删除 `assertWindowsLaunch` 及其调用。保留选定项目路径及实际宿主目标。在指定 cwd 运行 Claude 的 project scope 命令，核验返回的 projectPath、版本、commit、市场来源与可用入口。OMP 继续在隔离 cwd 链接至已展示的用户配置位置。
- 用按顺序查找 PATH 上的可运行文件替代目录扫描、格式签名和权限身份。保留便携版 `RIGUP_CONSUMER_PATH`、显式路径、常见 symlink/shim 和 Windows `.exe`/`.cmd`/`.bat`。只有 PATH 显式列出 cwd 才从中选择。设定固定 Windows 命令解释器处理受支持的批处理启动器，验证 shell 边界的 argv。保留现有可直接用 Node/exe 的 npm shim 路径及宿主版本探针。
- 去掉 Claude 顶层 settings 和仓库 Git config 白名单，允许插件/市场映射的无关项。按规范化的当前项目路径和 project scope 选取当前回执，保留其它项目的有效回执并允许复用已核验的共享 cache。检查当前项目的重复项、Superpowers 显式禁用、目标配置、市场源和 pin。采用宿主正常环境，按平台选用有效 HOME/USERPROFILE，路径中的 `resolve` 与 macOS `/private` 行为保持一致。独立保留 Git 官方源与目标版本约束。OMP 两个 config overlay 变量和 HOME/profile/agent 的 `.env` 仍是写入路由条件，错误指出命中的路径。
- 规划一次并显示命令和写入位置。批准后只在锁内检查当前 review 策略、目标冲突与实际目的地，执行后读回目标回执。Claude 已为 OMP 提供可确认的项目入口时跳过 OMP 用户链接。OMP 的 `.env` 和 overlay 路由检查仅拦截需要写入的 link。仅在 overlay 确实令有效宿主入口无法确定时报告状态未知。移除对可执行文件和无关元数据的跨步骤签名。在受影响会话内发出宿主重载提醒，接着走正常批准及执行。在 CLI、生命周期和 OpenSpec 交接使用同一个提示原则。
- OMP 校验固定地址、下载 SHA-512、大小、tar 安全解包与包布局后原子发布。复用当前版本目录及完成标记做快速检查，兼容正常发布的 v0.8 store。继续核验链接目标、必需入口和当前版本。下载未通过或发布中断时后续可重试。

## 第二批 · 文件与私有状态

- 删除常规 Windows ACL/C# worker 和递归权限/属主检查。缓存目录用 `mkdir`，对真实位置核查在项目外；POSIX 以 `0700` 和 `0600` 创建私密状态。私有 JSON 用读取加解析，继续区分文件不存在与记录损坏，保留写入原子性、持久化和必要的 schema 校验。宿主短文件只保留文件种类、现有读上限及格式检查。
- 新旧项目继续以 `.rigup/.env` 作为文件输入及写入目标。保持有效 ignored + untracked、原有字节的 compare-before-rename、凭据仅交给指定消费者。Windows 在写入秘密值之前对同目录空临时文件设当前用户专用权限，原子发布继承该权限。禁止更改整个项目或祖先目录 ACL。文件系统无法兑现私密写入时只停止该凭据写入，并报告目标供改用声明的进程环境变量。接受常见目录别名，检查实际 Git 和目标位置。用户刚创建的空文件也算编辑。
- 删除整项安装前的 mode 写入探测和普通写入对有效 inode 数字的要求。在同目录暂存后取得实际可保存的普通 mode，恢复按有效状态识别已完成写入，使后续无变化重试为 no-op。关键可执行文件仍应可调用，敏感文件仍须满足其保密要求。WSL drvfs、exFAT、SMB 的普通安装由真实写入结果决定。需要排他原子创建的 seed 或 OpenSpec 文件若遇到文件系统能力限制，保留客户目标，给出具体待完成步骤，继续支持恢复已成功的普通写入。

## 第三批 · 安装、恢复、外部进程

- 用 `wx`、PID 和 `process.kill(pid, 0)` 实现项目、宿主及 npm 前缀互斥。只有 `ESRCH` 判为死进程，兼容旧锁的 `identity.pid`。清除死锁必须串行，保留仅用于 read/unlink/acquire 的窄恢复 guard；其中断时报告该 guard 路径供确认后恢复。进行中的 writer 必须持有资源或在启动前登记可判活的 PID，避免控制进程中断即放开写入。
- 普通操作用 `spawn` 和最小的 durable 意图/结果。项目 npm 操作串行，每个资源上只有一个 writer。删除按启动时间、进程组、Windows Job 和树身份做永久阻断的常规路径。超时/取消时 Windows 使用 `taskkill /T /F`，POSIX 对此次启动发送信号并可限时升级。用直接退出状态判定检查成功，正确处理仍打开输出管道的子进程。短期 supervisor 若用于保证 writer PID 在 controller 崩溃后仍有效，复用当前授权启动边界并保留 stdio 与取消契约。
- 预览时保存实际计算出的条目和写入计划。新 apply 用已保存候选、固定 pin 和现有 planner 重算需批准的结果，比较按稳定顺序的项目与 diff 摘要，包含实际字节、目标模式/所有权、操作、已展开 checks 与 seeds。checks 对照实际 cwd、argv、env 引用和选定的脚本声明，普通源码变化不影响批准。`.rigup/config.yaml`、被引用的权威/模板/自定义技能和必需的原生入口属于相关输入。无关源码或 Git HEAD 无需匹配。apply 不调用模型或选取新的 npm 版本。
- 保留中断前写入的最小意图，记录首次批准的文件 before/after、完成回执和 seed 归属；恢复时逐项接受 prestate 或已验证 poststate，其他变化列出文件供复审。继续在实际写入前 `verifyCurrent`，按现有 baseline generation 写入，最后原子提交 manifest。已达到目标的普通文件不重写。seed 使用独占创建，保留无法判定归属的客户文件。`doctor` 读实际文件、配置、工具版本和状态，移除重复身份对账，只在显式探针时运行外部命令。
- npm 读取用户 `.npmrc`、代理、CA 和缓存。显式 `RIGUP_NPM_REGISTRY` 对本次包覆盖通用和 scope registry，否则由 npm 的有效 scope registry、通用 registry 按序决定。npm registry 继续要求无凭据 HTTPS 或回环 HTTP。对每个操作单独展示并冻结实际 registry、包名、版本、SRI 和范围。全局下载 tarball 后校验最强批准 SRI，再将该归档安装到已批准的前缀。项目安装以精确 semver 和批准 registry 写入临时前缀，验证 package-lock 的精确版本与 SRI 和实际 payload 后发布，保留可移植的 semver 依赖。项目 staging 用唯一临时目录，原子发布到空或不存在的目的地，只清理确认为本次创建的目录。
- OpenSpec 用原有 scope、pin、已安装结果及项目 CLI 接线恢复；去掉递归 `projectPayloadDigest` 和重复 runtime identity。保留 Git 忽略、兼容旧记录、尚未发布时保留用户文件、`rigup openspec` 的项目安装路径和真实原生入口验证。客户专属的 Postgres/PM2 推断与注入不属于通用检查，配置里的显式命令负责测试数据库和服务生命周期。默认检查超时 600 秒，终态和脱敏输出由实际进程产生。

## 第四批 · 研究和配置

- 研究的会话标识使用根目录、宿主和实际选项。源码 fingerprint 用于新分析、已完成结果的 no-op 判定和缓存新鲜度。普通改动后继续保存的会话，复验可复用结果自身的引用 digest、权限和阶段输入。需要反例查询的结果同时复验其 scope/query 和有限匹配集，包括原先没有匹配的查询。失效的工作及下游依赖重算。对仍在等待提交且引用省略 digest 的 MCP job，发出时保存所用 fingerprint，变化时发新 job ID 并要求重读当前 job 的证据，已接受页面按各自证据重新验证。带显式 digest 的引用仍按原行校验。兼容现有 run 形状，旧页缺少可验证输入时仅重算受影响的阶段。去掉历史版本枚举拒绝、运行期全树 fingerprint 的会话阻断、约定文件/生成目录 inode 检查。保持按作用域读取、对生成输出的排除和未来新研究识别新证据。
- 读取预算去掉总次数和每次 fsync，保留单文件、清单、单条响应和模型请求大小限制。继续拒绝密钥文件、私钥、凭据 URL 和二进制，简化用已有 JSONC/YAML/TOML 解析器及明文处理。用整文件过滤进入模型的旧 baseline 比较内容，保留多行凭据识别所需的上下文。放行 TS 类型声明、正常注释 tsconfig 和含占位值的 `.env.example`。样例里的真实值仍过滤，结构化、多行和命令参数里的凭据继续受覆盖。`safePath` 允许根内 symlink，按一次真实位置包含关系检查越界并避免递归循环。别名和解析后的相对路径都通过研究 scope、ignore、生成路径和密钥策略，内容按实际文件格式过滤。显式的模板/技能根是独立允许的输入。
- 旧 `--request/--response/--continue` 仍保留阶段绑定和私有路径、保留非空请求文件及原子接受。按旧命令给出的 ID 查找原 run/request，验证原审批语义和相关证据后关联到稳定 run，继续消费适配的原请求，相关证据改变时只重新发当前阶段。删除 ACL、导出镜像逐字比较、一次性消费状态与 `.budget.json`。Codex 通过可运行的 `--version` 探测，使用真实版本记录 provenance，旧已接受记录保留原版本。超时默认 300 秒并可配置为 `RIGUP_CODEX_TIMEOUT_MS` 正数毫秒。保留沙箱参数，兼容额外 NDJSON 事件及未知 usage。中断后用新的 attempt 继续，已接受的有效输出复用。Codex/文件交接预算仅告警，受计费的直接 API 后端保留既有显式上限。
- 保留 `validateResearch` 和 `hydrateEvidence` 的证据范围、结构及行 digest 验证。支持不足、覆盖缺口、需要反例的研究输出产生警告或待判断项。权威不足的说法不进入强制项目规则。原生发现截断时保留已确定的来源并报告，未解析清的优先级不算有效覆盖。OpenCode 用已安装的有效配置、已知包约定或已有宿主观察确认入口，移除 JavaScript 源码写法正则；无法确认的自定义注册在报告中给可操作的后续检查。
- 模型 provider 支持 `new URL()` 可解析的 HTTP/HTTPS、用户配置的局域网主机和非秘密 query，包括 `api-version`。两个 provider 保留 query、原有禁止重定向及安全诊断，拒绝 URL 内嵌凭据。npm registry 和 tracker URL 保持各自已有的规则。`config.ts` 对未知顶层键告警并保留手写 YAML，只把已识别选项传给模型。`command.envRefs` 默认 `[]`，`cwd` 默认 `'.'`，省略 MCP agents 时在选型结束后使用本次所选宿主，写回继续保留省略。工具未声明的 install/initialize 默认 `false`。凭据参数判断限定到实际选项，普通 `--max-token=100` 可用。JUnit 通配写法允许 `reports/junit/**/*.xml` 这类有字面报表子目录和 `.xml` 后缀的仓库相对模式。所有匹配文件按 GitLab 语义交给所选报告配置。混有覆盖率等 XML 的项目应指定 JUnit 子目录。保留已合法的精确路径，拒绝私有状态路径、密钥文件、CI 变量展开和越界路径。
- 自定义模板只替换已给值的占位符，保留 `${{ secrets.X }}` 等原样文本。自定义 skill 接受显式链接目录和正常资源，保留 frontmatter、保留名、边界与 secret 检查。MCP tools 在完成 `initialize` 后可以列出和调用，即使客户端未发送 `notifications/initialized`。发布的参数 schema 容许额外字段，派发时只取已知字段。继续验证必填项、消息类型与协议版本和拒绝未知工具。

## 发布验收

四批分别跑聚焦回归。在同一个发布候选上跑完整 `npm run check`、`npm audit --audit-level=low`、`npm pack --dry-run --json`、操作流程 E2E 和真实 Windows/WSL CI。无模型 E2E 覆盖 `init → review → approve → apply → update → doctor`、v0.8 已完成和中断的升级、当前会话内继续、项目 npm/全局 npm 和 OpenSpec、MCP/旧 host 交接。原生 Windows 至少执行一次带 `mvnw.cmd` 的项目入口及真实 `.cmd` 进程，保留 wrapper 文件，并核验宿主目标回执和取消。其余宿主/平台只以跑过的证据声明支持。

按仓库惯例从 v0.8.0 递增 minor，计划 v0.9.0。正文、双语 README、用法、Windows/WSL 和兼容性证据同步变更。PR 绿后合并到 `main`，在确认合并 SHA 的 CI 后推同版本 tag。跟进 GitHub 四平台资产、npm trusted publishing 和 manifest SRI；隔离安装验版本。验完发布物才单独更新并验证公开的一行 installer，再关闭交付。版本已被占用时从最新发布和 `main` 重新检查并选用下一 minor。
