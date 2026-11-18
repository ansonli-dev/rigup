# Issue 78 · 单用户开发机实施计划

> 执行会话使用 Superpowers `executing-plans`、`test-driven-development` 和 `verification-before-completion`。各任务的复选框跟踪红测、实现、回归与提交。

**目标**　按 [设计](../specs/2026-11-18-single-user-setup-design.md) 完成 Issue 78 的四批改动，并发布经验证的 Rigup 新版本。

**架构**　留在现有的原生安装、apply 和研究入口。用实际目的地、已批准输出、锁和有效回执约束写入。替换重复计划、身份判定与扫描，沿用按阶段恢复的持久状态。

**技术栈**　Node `^22.19.0 || >=24.2.0`、TypeScript、`node:test`、现有 npm 和 Git fixtures、GitHub Actions。

## 执行环境与全局约束

- 进入新会话并以本计划为 `/goal`。从远端 `main` 核实版本与 SHA，基线为 `5ff4dff` / v0.8.0。使用专用工作树和 `codex/issue-78-single-user-setup` 分支。将 spec 和本计划提交在该分支。保护原 checkout 中已有的四份未跟踪稿。
- 保留 Node 版本范围、公开 CLI flags、已使用的 JSON/MCP 字段、用户审批、SDD 必须入口和 pin。普通测试使用隔离的 HOME、项目、前缀和 localhost fixtures。认证 live tests 只在已具备授权且对该改动有验收价值时运行，记录实际测试边界。
- 各批的覆盖基于正常入口。调整原先断言拒绝的测试，再运行失败的单例和同边界负例。实现后跑该批文件的完整测试并提交。共享或同文件代码保持顺序。回归矩阵和发布验证见最后一个任务。

## 审查重点

| 情况 | 需要证明 | 任务 |
| --- | --- | --- |
| 部分 apply 后内容相同的 seed 或已写好的包 | 恢复仅认领有归属证据的文件，已发布版本不重复下载，也不会覆盖用户修改 | 3B、3C |
| 两个进程同时恢复，或 controller 结束但 writer 仍活着 | 同一项目、宿主或 npm 前缀只能有一个有效写者，失效 PID 可恢复 | 3A |
| 路径有空格的 Windows `.cmd`，带 Maven wrapper 的项目 | 真实 argv 越过启动器，wrapper 未执行，目标路径正确，超时与取消可验证 | 1A、3A、5 |
| 用户在预览后改业务文件或在研究后改了引用 | 无关编辑允许 apply 和 resume；相关编辑在正确阶段重审且报告具体文件 | 3B、4A |
| `.env.example`、npm 代理和 CI 通配符 | 预期配置正常工作，凭据不会出现在模型输入、Git、CI 产物或诊断 | 2、3C、4A、4C |

## 第一批 · 原生宿主

### 1A · PATH、启动器和实际项目范围

**文件**　`src/integrations/host-setup/{runtime,host-files,claude,index}.ts`，Windows 命令边界和 `scripts/native-host-smoke-cases.mjs`。测试 `test/{host-setup-runtime,host-setup-claude,host-setup-omp,host-setup-cli,runtime-git-safety}.test.ts`。

- [ ] 写红测。Windows 项目有惰性的 `mvnw.cmd` 和 `gradlew.bat`，带空格的 PATH 目录含可用 `omp.cmd`，`planNativePreparation` 产生 `action`。通过真实子进程执行版本与插件 fixture，断言 argv 和 cwd 正确、wrapper 文件未动。POSIX 用带 shebang 的 shim。同一隔离 HOME 先后准备 Claude 项目、真实 `git worktree` 和 monorepo 子目录。核实 shared cache、各 projectPath 回执、所需项目声明和父目录未变化。加入无关 `[includeIf]`/credential/LFS 配置、settings hooks/env 和预装另一插件的正例。保留当前项目市场错误、显式禁用与冲突 install scope 的负例。
- [ ] 使用 `node --import tsx --test test/host-setup-runtime.test.ts test/host-setup-claude.test.ts test/host-setup-cli.test.ts` 验证与旧根目录/launcher/配置拒绝相符的失败；实际 batch red 在 Windows CI 或 Windows 机器确认。
- [ ] 修改 `inspectHostRuntime(root,host,input)`。以启动目标和必要 argv 取代 `NativeProgram` 的文件身份数组。按有效 PATH 顺序找可运行项目，保留绝对命令与 `RIGUP_CONSUMER_PATH`，Windows 批处理使用固定解释器及安全 argv 传输，执行者仍接收 `{executable,args,env}`。原生宿主用可预测的 HOME/USERPROFILE 优先级、正常环境和 `resolve`。从 `inspectClaude` 删除 repo Git parser 和 settings 全白名单，目标市场/禁用/项目 receipt/pin 继续从实际适用设置验证。去掉 Native ACL path call。
- [ ] 跑五个聚焦测试文件，更新 smoke 的旧拒绝断言并保留确认、作用域、pin 和无副作用断言。提交原生启动和作用域。

### 1B · 一次计划、OMP store 与会话

**文件**　`src/integrations/host-setup/{index,omp,omp-archive,omp-locations}.ts`、`src/{cli,lifecycle}.ts`、`src/installer/session.ts`、`scripts/check-package.mjs`。测试复用 `test/host-setup-*.test.ts` 和 `test/{cli,e2e,openspec-setup}.test.ts`。

- [ ] 红测核对批准后无关状态改变仍开始、review 策略或有效目标变更停止、目标无关设置不变、初次安装/已有 store/断点重试、SHA-512 不符和 tar 路径越界依旧失败。断言 `PI_CONFIG_FILES`、`OMP_CONFIG_FILES` 和具体 `.env` 路径阻断有风险的写入路由。Claude 在 HOME `.env` 存在时仍可为 OMP 提供可确认的项目入口，OMP 不启动、不下载且无用户级写入。CLI/package fixture 验证活动会话得到重载提醒并完成。保持 `--review`、`--dry-run`、取消和未批准的 Superpowers 准备只读。验证既有普通非 TTY/JSON、显式 `--apply` 和 `--prepare-openspec` 的授权语义。
- [ ] 运行 `node --import tsx --test test/host-setup-omp.test.ts test/host-setup-cli.test.ts test/cli.test.ts test/openspec-setup.test.ts test/e2e.test.ts` 复现旧重规划与会话阻断。
- [ ] 改 `executeNativePreparation(plan,input)` 复用 `plan`，锁内直接比较写入目的地和目标冲突，读回具体回执。去除 launch identity 和完整 `planHost` 重跑。快速判断 OMP 版本目录/完成 marker，v0.8 已完整发布的目录仍复用。`sessionHandoffRequired` 只用于产生同一份重载提示，兼容 `--sessions-ended` 和现有 JSON 结构，去掉因会话本身返回 3 的路径。
- [ ] 重跑聚焦测试。按实际删除的拒绝更新旧 native smoke 用例并提交。

## 第二批 · 私有读写与 mode

### 2 · 直接读写和各文件的权限需求

**文件**　`src/{private-access,windows-acl-worker,private-record,runtime-private-env}.ts`、`src/generator/cache.ts`、`src/integrations/host-setup/host-files.ts`、`src/analyzer/host.ts`、`src/installer/{filesystem-modes,manifest,apply}.ts`、`scripts/check-wsl.{mjs,ps1}`。测试 `test/{private-record,runtime-inputs,runtime-git-safety,installer,filesystem-modes,host-setup-runtime}.test.ts`。

- [ ] 红测覆盖正常继承的 Windows 目录、链接至项目外的 cache、真实位置落在项目内的拒绝、读取坏 JSON 报路径，以及 `atomicProjectWrite` 普通 mode 无法兑现但正常写入、在 rename 后/manifest 前中断仍可 resume 和 no-op。模拟硬链接不支持且需排他创建，断言已创建的用户文件保持，缺失目标保持未写并列出路径。密钥负例覆盖 `.env` 或临时文件未被 Git 忽略、已跟踪、用户刚创建空文件、写入期间内容变化和秘密值未出现在诊断。WSL 驱动器和 ext4 都以实际写入和响应为判断。
- [ ] `node --import tsx --test test/private-record.test.ts test/runtime-inputs.test.ts test/runtime-git-safety.test.ts test/installer.test.ts test/filesystem-modes.test.ts` 验证旧 ACL/mode 假设下的失败。
- [ ] `privateDirectory(path, projectRoot)` 保持签名和实际根外检查。`readPrivateJson` 直接 `readFile` + `JSON.parse`，保留 `saveDurable`。删除通用 ACL 和其 C# worker，移除 `O_NOFOLLOW`、`nlink`、mtime stamp 和同一文件重读，保留必要文件类型、大小、格式检查与目标比较。`.rigup/.env` 不迁移位置。Windows 只在写入秘密字节之前限制空临时文件访问，无法做到时保留目标并报告路径。验证 Git 忽略与前置内容。普通目标在实际写入验证并记录有效 mode，移除预探测。旧 ACL 测试替换为上述用户场景，更新 WSL 探针各挂载的结果。
- [ ] 重跑聚焦测试、typecheck 和适用 Windows/WSL 用例，确认 canonical alias、缓存和原子写入一起工作。提交。

## 第三批 · 安装和外部进程

### 3A · 资源锁、进程与项目检查

**文件**　`src/installer/{lock,operations}.ts`、`src/integrations/tools/{windows-process,project-check,quality,check-catalog}.*`，调用端 `host-setup/runtime.ts`、`sdd/openspec-setup.ts`、`analyzer/codex-process.ts`、`agents/rigup-health.ts` 以及 npm 启动链。去掉 `analyzer/check-prerequisites.ts`、`analyzer/repository.ts`、`generator/render.ts` 和 GitLab 的客户规则联动。测试 `test/{check-feedback,recovery,windows-process,host-setup-runtime,openspec-setup,codex-backend}.test.ts` 及健康探针测试。

- [ ] 红测真实双进程恢复 dead PID、活 PID 排斥、旧锁读取和 controller 遇中断时真实 writer 仍占用资源。按共享项目/宿主/prefix 分别测试。同一预览包含 OpenWiki 与 CodeGraph 时，杀掉 controller，验证 writer 仍活的那个 staged 安装不会被另一调用发布或清理，并验证第二个任务尚未启动。检查正常退出 0 且子进程持有 stdio 仍返回 passed，超时和取消停止本次检查进程，正常命令收到用户显式 env/argv，Postgres 和 PM2 不再改写。在 Windows 观察真实 process、stdio、取消、batch argv，以及 Node 和 MCP 健康探针。
- [ ] 运行 `node --import tsx --test test/check-feedback.test.ts test/recovery.test.ts test/host-setup-runtime.test.ts test/openspec-setup.test.ts test/codex-backend.test.ts`，检查 red 为真实状态差异。
- [ ] `acquireLock` 继续返回 `ProjectLock`，记录 `{root,id,pid}` 并读旧 `identity.pid`，保留仅串行 stale unlink 的 guard。将 `protectedOperationCommand` 和 Windows 执行链迁移到共享的现有 spawn 接线，呈现直接子进程终态，写入进程在启动前与锁绑定。删除 `apply.ts` 同项目 npm 安装的并行批处理。用 `taskkill /T /F` 处理 Windows 超时/取消，POSIX 限时信号。删除 Job Object、进程启动时间和残留树硬判定的热路径，保留正在运行的已知 writer 的判活。移除 DB/PM2 的检测、生成和注入，项目明确选择的命令继续执行，项目检查默认 `600_000` 毫秒。
- [ ] 重跑聚焦测试、host health 及 GitLab fixtures。删除旧进程规则测试时保留功能覆盖。提交。

### 3B · 预览、执行与中断恢复

**文件**　`src/installer/{preview,apply,baseline,file-state,manifest,doctor}.ts`、`src/analyzer/repository.ts`、`src/{cli,lifecycle}.ts`。测试 `test/{preview,merge,installer,recovery,managed-input,e2e}.test.ts`。

- [ ] 红测批准后只改无关源码/提交仍 `complete`。改变相关配置、实际 native entry、已引用的规则/模板、自定义文件、操作 pin 或真实 diff 要求新预览。预览 `test` 后新增第二个包的 `test` 或改原脚本命令时要求复审且新增命令未执行。对冲突的用户删除或改动保持原样。按首次文件写入、seed 独占、工具发表后及 manifest 前注入中断。保留用户随后创建的同内容 seed，重启恢复不丢 baseline、私密状态和包 pin。断言普通重试中达到目标的文件不重写，未请求模型和 registry latest。
- [ ] 运行 `node --import tsx --test test/preview.test.ts test/merge.test.ts test/installer.test.ts test/recovery.test.ts test/managed-input.test.ts test/e2e.test.ts`，确认无关源码触发旧 `installationInput` 失败。
- [ ] 新预览以签名覆盖实际列表、before/after 字节、观察到的 before mode、请求的 after mode 及权限要求、scope、已展开的 checks、seed 和固定包，沿用已有 merge planner 和 `PreviewData`。`installationInput` 改为读取归因到已批准结果的输入，保留批准时 config、引用/模板/技能和实际 native/OpenSpec 前置。恢复从已批准的 `Transaction` 取最小必要状态，复用当前跳过 poststate、`verifyCurrent`、exclusive 和 manifest 终态路径。apply 暂存文件后取得真实 mode，在 rename 前保存到恢复记录，后续恢复及 no-op 使用该 mode。旧记录在读取和第一次 writer/recovery 检查之前转换已批准的包、pin、范围和顺序，避免用当前命令串拒绝旧审批。已生效的部分操作不重算。doctor 从实际状态报告。保留 CLI `--resume` 和可指到具体冲突文件的提示。
- [ ] 聚焦套件、v0.8 完成与部分写入 fixtures、异步真实进程中断用例全绿后提交。

### 3C · npm 与 OpenSpec 发布

**文件**　`src/{npm-command,npm-integrity}.mjs`、`src/installer/{apply,operations,install-staging}.ts`、`src/research/mcp-workflow.ts`、`src/integrations/tools/{global-npm,global-npm-runtime,npm-resolution,recipes,installed-state}.ts`、`src/integrations/sdd/{openspec-setup,openspec-project}.ts`。测试 `test/{global-tools,registry-selection,installer,openspec-setup,runtime-installation,native-initialization,research-mcp}.test.ts`。

- [ ] 红测以两个回环 registry 验证同一预览的 scoped 与非 scoped 包走各自地址，覆盖 MCP 结束、CLI apply 与恢复。显式 `RIGUP_NPM_REGISTRY` 覆盖 scope、registry 改变要求复审以及 latest retag 后只装审批版本。测试冷/热缓存、错 SRI 不写，global/project 和 OpenSpec 的恢复复用验证后的目录，project package-lock 保持精确 semver 并且移走临时目录后仍可使用。已有用户同名暂存/生成目录保留。保留 `--ignore-scripts`、CodeGraph 平台载荷、OpenSpec 显式选择、Git ignore 和项目 CLI 转发断言。用 v0.8 binary 生成 stage 创建后/发布前的真实中断状态，升级后 `update --resume --review` + `--apply` 验收。
- [ ] 运行 `node --import tsx --test test/global-tools.test.ts test/registry-selection.test.ts test/openspec-setup.test.ts test/runtime-installation.test.ts test/native-initialization.test.ts test/installer.test.ts`，核对 npmrc 因原来隔离覆盖而失败。
- [ ] 沿用 `ResolvedNpmPackage` 和 `SetupOperation` 的目的地。移除强制空的 user/global config 和 cache。npm validator 继续限制无凭据 HTTPS 和回环 HTTP，和 provider URL 放宽分开。显式 override 胜出，其他情况根据每个操作的包名读取 npm 的有效 scope/通用 registry，密钥不进入仓库/预览。全局对下载 tarball 校验 SRI 后把验证的本地归档装进批准目录。项目以精确 semver 装进独立 staging，核对 I/O、lockfile 和 payload 后发布。仅清理自己的 staging。减少全局 npm runtime/receipt 身份字段，兼容旧 pending 和既有 launcher。OpenSpec 核验已安装 pin 和所需生成入口，删除 `projectPayloadDigest`，保留 scope、阶段、已观察回执和 Git 保护。旧 worker 摘要仅在兼容桥有真实调用时需要。
- [ ] 重跑该批和 3A/3B 的恢复、包安装和 check 回归，提交。此批后重新跑一次 `npm test`。

## 第四批 · 研究和配置

### 4A · 证据、来源和可恢复研究

**文件**　`src/{lifecycle,research/mcp-workflow,generator/generate,generator/project-rules}.ts`、`src/analyzer/{repository,evidence,read-policy,native-sources,backend,topic-evidence}.ts`、`src/integrations/sdd/binding.ts`。测试 `test/{analyzer,repository,backend,generator,research-mcp,rigupignore,managed-input}.test.ts`。

- [ ] 红测已有两个可用页时改无关源码，`rigup_begin`/CLI `--resume` 继续原 session 并复用两页。改已接受引用的行，或新文件使命中原来为空的反例查询，只重算受影响页及依赖。另测发出 job 与提交之间编辑源码，省略 digest 的旧提交要求重读当前任务，已经接受的页仍复验复用。完成 apply 后新发现证据触发新分析，无变化仍 no-op。含旧保存格式、修改 `.rigupignore`、删权限规则、改约定源、超 2000 次普通读取、两宿主大 cache 截断、OpenCode 实际 runtime ID 禁用与未注册的同名非官方包。测试可读 in-root link、越界和被忽略的根内目标，断言后者的标记不进入 list/read/search 或已序列化的 host/API 输入。覆盖按实际文件格式保密、TS 类型、注释 tsconfig、`.env.example` 占位值与实际秘密、多行和结构化凭据。旧 baseline 内的无害多行 secret sentinel 不进入 host/API 序列化输入。缺少支持给 warning，错 digest 继续失败。重复相同证据或当前需要却缺失反例查询时，生成规则和最终文件里均无强制条目。
- [ ] 聚焦执行 `node --import tsx --test test/analyzer.test.ts test/repository.test.ts test/backend.test.ts test/generator.test.ts test/research-mcp.test.ts test/rigupignore.test.ts test/managed-input.test.ts`，确认普通编辑、读预算和读格式各有 red。
- [ ] `repositoryReader` 移除逐读预算持久化和总数限制，保留 scope/ignore/单项边界。`safePath` 一次实际包含检查。`rigup_begin`、`runLifecycle` 和 `generate` 查找稳定的运行和阶段身份，分开保存当前派发与分析完成时的 freshness，重验证可复用页的引用、反例匹配结果及阶段输入，失效才重算。兼容旧阶段记录，去掉 `priorContracts`。用已知包约定、有效配置或确认过的 OpenCode inventory 替代源码正则。按宿主截断扫描并返回已知来源。研究后端继续硬验证结构/证据，软化语义规则并在最终规则生成时应用相同的采纳阈值。发送给模型的 baseline 在整份文档层过滤。
- [ ] 重跑聚焦测试并提交。与 v0.8 的安全合并、原生规则优先级和保密用例共存。

### 4B · Host 文件协议与 Codex

**文件**　`src/analyzer/{host,codex,codex-process,budget}.ts`、`src/lifecycle.ts`、`src/generator/generate.ts`。测试 `test/{host-context,stage-context,codex-backend,final-review,e2e}.test.ts`。

- [ ] 红测同请求继续、错误 ID 与无关旧响应、命名导出不覆盖、合理压缩/路径别名无需镜像比对。由 v0.8 导出原 `--continue … --response …` 命令，改无关文件，新版本直接执行并消费正确阶段。模拟非锁定 Codex `--version`、未知事件、未知用量、用户超时和 Ctrl-C 恢复，断言下一次 attempt 新建、当前与旧已接受的实际版本分别呈现、回执可用、原 sandbox args 不变。预算达限时 Codex/host 给提示，直接 API 在同项测试仍限制派发。
- [ ] 运行 `node --import tsx --test test/host-context.test.ts test/stage-context.test.ts test/codex-backend.test.ts test/final-review.test.ts test/e2e.test.ts` 复现旧版本、事件、预算和一次性消费阻断。
- [ ] `hostBackend(options).run` 保留 request ID、阶段/输出验证、显式文件的独占创建及第一次成功接受，删除镜像 ACL 和 `.budget.json`。旧 continuation 记录直接以原 ID 加载并校验原阶段和相关输入，允许其进入稳定运行状态。`codexBackend` 复用可执行探测与 `spawn`，记录探测的版本，增加默认 `300_000` 毫秒的 `RIGUP_CODEX_TIMEOUT_MS` 解析。使用独立 attempt，接受新增事件，在调用层按 backend 报警或执行计费预算。保留旧 flags 与持久记录兼容。
- [ ] 重跑聚焦测试，另跑 direct provider suite，提交。

### 4C · 普通配置、模板与 MCP

**文件**　`src/{config,runtime-inputs,onboarding,cli}.ts`、`src/analyzer/{provider-url,openai-compatible,anthropic}.ts`、`src/integrations/{custom-templates,custom-skills,gitlab/ci,tools/customer-mcp}.ts`、`src/research/mcp-stdio.ts`。测试 `test/{config,onboarding,runtime-provider,provider-cli,gitlab,integrations,research-mcp,e2e}.test.ts`。

- [ ] 红测 `--configure` 保留未知顶层键，guided 流程改变检测得到的默认宿主后，未指定 agents 的 MCP 到最终所选宿主，显式列表只绑定对应宿主。MCP `cwd` / `envRefs` 默认 `.` / `[]`，tool 默认只复用。`--max-token=100` 可用而实际显式凭据仍被拒。两个 HTTP adapter mock 收到正常局域网 endpoint 与 `api-version` query、拒绝重定向和含秘密的 URL，npm registry/tracker 规则正常。测试 `reports/junit/**/*.xml` 正例和相邻目录、私密路径或全仓 glob，核实实际收集范围。模板 `${{ secrets.X }}` 原样，已知值正常渲染。skill 链接目录可用，私钥和保留名仍精确报错。MCP 在初始化通知缺席时正常，额外 key 被忽略，错误必填参数继续拒绝。
- [ ] `node --import tsx --test test/config.test.ts test/runtime-provider.test.ts test/provider-cli.test.ts test/gitlab.test.ts test/integrations.test.ts test/research-mcp.test.ts test/e2e.test.ts` 验证原拒绝。
- [ ] 在现有 loader 规范化默认值和未知键告警，在最终选型后绑定省略 agents 的 MCP，写回配置时保留原有省略的动态含义。继续现有类型、互斥和 `documentLanguage` 检查。用 `URL` 保留允许的 query，分离 Anthropic SDK 自己拼接的路径。限制报告 glob 的相对路径和用户声明的输出目录。用模板 `values`、现有 frontmatter 读法、MCP 参数 schema 和已知字段解析完成接线，保留 `initialize` 的协议版本握手。
- [ ] 重跑本批全套与文档链接，提交。

## 5 · E2E、文档、合并和发布

- [ ] 用隔离 checkout 和 v0.8.0 安装 fixture 做从 `init` 到 `doctor` 的无模型 CLI E2E，覆盖 approve/取消/实际 apply/update、旧 pending 升级、原生 SDD 和 `.env` 保密。真实 Windows 通过 CI 验证带 `mvnw.cmd` 的入口、batch、实体 worktree 与进程取消；WSL CI 检查 ext4 和 Windows 挂载。跑 `node --import tsx --test test/e2e.test.ts test/research-mcp.test.ts test/host-setup-cli.test.ts test/recovery.test.ts`、`node --test test/harness-e2e/fixture.test.mjs test/harness-e2e/runner.test.mjs` 与 `npm run check`。记录真实退出、测试计数、跑过的平台和跳过理由。
- [ ] 测试通过后更新 `README.md`、`README.zh-CN.md`、`docs/guides/{usage,development,external-validation-handoff,releases}.md` 和 `docs/compatibility/status.md` 的实际变化与验证范围。更新 `CHANGELOG.md`、`package.json`、lockfile。同远端检查可用版本，当前计划 `npm version minor --no-git-tag-version` 得到 `0.9.0`。按 `.github/workflows/release.yml` 和仓库发布指南保留 prerelease 与对应 npm tag 惯例。若 release 文档指向版本化资产，先确认引用版本和计划发布版本一致。公开根 `install.sh` 后移到发布后的验证任务。
- [ ] 对发布候选跑 `npm run check`、`npm audit --audit-level=low`、`npm pack --dry-run --json`、文档检查、差异和 secret scan。Superpowers `requesting-code-review` 安排独立规格和代码审查，处理发现，重新验证。实施和 installer PR 使用 `Refs #78`，Issue 记录在发布验收后关闭。保证 Node 22/24 × Linux/macOS/Windows 与 WSL 所需 checks 在准确 head SHA 通过。合并后验证 `main` 相应 SHA 的 CI；需要预发布验证时按仓库手动 Release 工作流构建四平台。
- [ ] 确认 tag/版本没有竞争后，从已核验的 `main` SHA 推同版本 tag。跟进 Release assets 与 npm Trusted Publishing，验证四个 portable 目标、checksum、release manifest 和 npm `dist.integrity` 相等。用隔离 prefix 安装精确版本，用临时目录验证当前架构 portable 包的完整性和 `rigup --version`。
- [ ] 发布物校验成功后仅更新根 `install.sh` 指向新版本，按既有单独 PR、CI 和合并流程推进。在隔离 `RIGUP_INSTALL_DIR`/`RIGUP_BIN_DIR` 验证 root one-line installer，保留新版本、Issue 关闭、两个 PR、CI/release 链接和验收证据。根据 `/goal` 逐项检查最终状态，随后标记完成。
