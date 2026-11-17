# 三方集成安装与原生工作流实施方案

> 执行使用 Superpowers 的执行计划或子代理式开发，按任务运行测试驱动循环。检查项记录实际证据。

**目标**　接通四宿主与三 SDD 的所有有效组合，自动复用选中工具，缺失时才选择安装范围。

**架构**　现有来源快照与审批负责保护项目。可选工具共用探测、预览和 apply，OpenSpec 复用安装逻辑并保留独立准备。

**技术栈**　TypeScript、Node.js、npm、现有 npm registry fixture 和宿主原生列表/读取探针。

**设计**　[三方集成安装与原生工作流](../specs/2026-11-16-integration-setup-design.md)

## 全局约束

- npm 自动写入必须有精确包身份、registry、目的地和已批准操作。项目/宿主原生文件及用户数据按现有保护边界处理。
- 生产 SDD 发现只读，复用 `SkillSource` 和预览快照。兼容性证据只用于文档。宿主管理原生安装。
- CI 中运行离线 fixture。实机安装、写保护、回环 MCP、真实 registry 和故障恢复使用隔离项目及用户前缀。

## 评审重点

- 两个缺失工具都选全局时共用一条 apply，前缀内串行。跨项目旧 writer 未退出前拒绝新写入，半成品 launcher 未被复用。任务 3。
- 终端、doctor 和宿主之间 PATH 可能变化。Windows 包目录、受信 Node、独立版和仓库 PATH 抢占用正常 launcher 做断言。任务 2。
- OpenSpec 独立准备的作用域需要从交接一直传到恢复，主预览取消后工具目录仍被 Git 忽略。任务 4。
- OpenCode 和 OMP 的有效配置、缓存版本和同名遮蔽决定实际绑定。来源范围不能扩大研究读取权限。任务 1。
- 旧配置或已批准模式携带原来选择。无模型 socket 原生 E2E 需要实际解析三份生成引用，避免仅凭安装声明通过实机验收。任务 1、2、5。

### Task 1: 原生发现与绑定

**文件** `src/analyzer/{native-sources,repository,research-ignore}.ts`、`src/integrations/{agents/index,sdd/binding,registry}.ts`、`src/{setup-detection,types,cli-output}.ts`。测试在 `test/{integrations,generator,analyzer,rigupignore,cli}.test.ts`。

**接口** `bindSdd(id,agent,available): SddBinding`。`resolveSddBinding` 返回 `{binding:SddBinding,warnings:string[]}`。内部 `SkillSource.packageName?` 表示匹配的插件包，`sourceFingerprint?` 携带已验证加载入口及 manifest 的路径/摘要。失败报告沿用 `SetupRequirement`，附宿主及可执行修复。项目命令目录表包含 OpenCode 旧单数根。

- [ ] 写 12 组按宿主命名的断言，检查 `source-bound`、三份各自的引用和 12 组空入口的 `missing native entry:`。以终端或 `--json` 复现 `claude,omp` 的旧阻塞，另验缺一端、缺两端、冲突和取消保持用户文件。
- [ ] 运行 `node --import tsx --test test/integrations.test.ts test/generator.test.ts test/cli.test.ts`，确认现有 OMP × Superpowers 回归用例失败。
- [ ] 删除绑定特判和 pending 分支。保留必需入口、来源、原生 gates，令 `SetupRequirement` 文本与 JSON 显示真实失败宿主和动作。组合测试中 Superpowers 四项、OpenSpec 三项和 Spec Kit 六项均来自独立预期表。增加真实 `specify init` 布局中用户技能齐全但项目缺 constitution 或当前工作流要求的脚本/模板，包括 sh、ps、py 入口的只读校验，验证更换已核验的依赖使旧批准过期。缺少无条件必需扩展 hook 的真实调用目标也给修复动作。原生修复区分首次 init、已有项目添加宿主和已有项目所需文件修复。
- [ ] 在 `test/analyzer.test.ts` 与 `test/rigupignore.test.ts` 加启用/禁用、仅声明、陈旧缓存、越界链接、冲突和数据保密 fixture。OpenCode V1/V2、OMP npm/link/Marketplace、Claude local scope 分别覆盖。OMP 验证同名项目包覆盖用户包、禁用 OMP 记录遮蔽 Claude 用户记录、当前项目及 OMP 自有记录依宿主规则发现，禁用项目 Marketplace 记录时仍按当前有效用户记录解析。补 Codex 双版本或 local 先解析当前目录的反例。OpenCode 测 V1 附加与 V2 替换配置目录、项目配置禁用、优先级、V2 `integration.use` 与 skill 权限拒绝、注册 ID 与显示名不同、平铺技能和兼容根遮蔽，以及 JSONC 命令覆盖原生 Markdown 的相同 ID。用真实探针比对 ID 与选中的路径。固定 `specify` 1.3.2，在 OpenCode 与 OMP 的干净项目实跑初始化核对命名。
- [ ] 统一 project command roots。扩展有效原生来源和 OMP 社区包的 artifacts/gates。按实际调用名与宿主优先级处理遮蔽和冲突。显式禁止宿主调用时给修复动作，包含 Claude Spec Kit `disable-model-invocation` 和 OMP Spec Kit 原生命令可见但 `skills.enabled:false`。在 CLI fixture 验证真实扫描产生 `executable:true`，独立 apply `complete`，六份引用正确。替换技能、插件入口或 manifest 的字节、同内容换路径或禁用插件时，旧预览及中断恢复拒绝项目写入。重跑本任务五个测试文件，提交原生绑定。

### Task 2: 可用安装探测与 MCP

**文件** `src/{onboarding,setup-detection,cli,config}.ts`、`src/npm-command.mjs`、`src/integrations/{registry.ts,tools/*}`、`src/installer/doctor.ts`。测试复用 `test/{onboarding,cli,registry-selection,openwiki-handoff,native-initialization}.test.ts`。

**接口** `detectToolInstallation` 返回项目回执、可信 PATH、缺失或需修复。固定独立 MCP launcher 与生产探测使用同一解析。`SetupOptions.tools[].install` 表示项目包布尔值。任务 3 在全局 apply 可用时接入共用范围提示。

- [ ] 添加红测，项目包优先于 PATH、已有 PATH 直接复用、缺失使用项目默认。覆盖 TTY 和非交互 `--tools`、普通 update、init 转 update、`update --configure`、旧 YAML/profile/manifest fallback、回退、取消。表驱动断言同名工具保留原映射和布尔值、新增进行探测、显式重配已失联的 PATH 工具及写回策略。用真实生成的 MCP argv 从项目子目录运行受信 launcher，验证有空格的外部目录、Windows 两种包形态与假 project tool launcher 始终未执行。另放置项目假 `node` 抢占便携宿主 PATH，验证 doctor 给出宿主 Node 修复动作。
- [ ] 运行 `node --import tsx --test test/onboarding.test.ts test/cli.test.ts test/openwiki-handoff.test.ts`，看到现有方式提示或接线失败。
- [ ] 实现所选项探测、项目默认与安全接线。项目与 PATH 复用分开返回。复用的工具没有 registry 查询。静态验证 CodeGraph 平台 payload，使用 bundle 真实入口并兼容现有回执。doctor 报告外部工具缺失与宿主 Node。CodeGraph 软件单独规划，已有非空索引保留，项目空范围走 worker，PATH 缺索引时提供原生命令。
- [ ] 重跑本任务聚焦测试，覆盖 CodeGraph 只存在 shim、无匹配载荷的场景，验证未调下载分支。提交探测和 MCP 变更。

### Task 3: 全局 npm 安装与主 apply

**文件** `src/integrations/tools/`、`src/integrations/sdd/openspec-setup.ts`、`src/{lifecycle,types,cli-output}.ts`、`src/installer/{preview,apply,operations}.ts`。测试复用 npm fixture，增加全局流程用例。

**接口** `GlobalNpmApproval` 携带 `ResolvedNpmPackage`、canonical prefix 和 prefix/npm 身份。`install-global:<id>` 在既有 `operations` 以安装类型和全局保护范围表示。项目 `declaredWrites` 仍是项目相对范围，全局目的地来自已审批字段。全局完成回执归安装前缀，私有 `LifecycleFlags.globalTools` 及持久 `Run.mode` 只记录本次选中的全局工具 ID。把这个选择写入 consent 摘要，区分等价 `install:false` 的仅 PATH 复用。

- [ ] 新增使用真实 npm 和隔离 registry 的红测。缺失才询问范围，两工具一起选全局，独立 apply 后第二项目复用。走一次真实 host handoff、`--continue`、保存预览及全局 apply，验证仅 PATH 的 run 不共享全局 consent。保存、取消和干运行无前缀/项目写入。retag 继续原版本。换 prefix、npm、registry 或同版本 tarball拒绝。杀父控制器但让 npm writer 活着，第二项目用另一包尝试时拒绝写入。检查半成品 launcher 和三种恢复（已完成、空目标、证据不足）。第二个全局操作失败或取消时，首个完成项在 JSON/终端中可见且恢复从原审批继续。
- [ ] 运行 `node --import tsx --test test/registry-selection.test.ts test/openspec-setup.test.ts` 与新全局 fixture，验证基线缺全局计划或保护。
- [ ] 提取共享全局 npm 审批、安装、运行时、tarball 和 launcher 验证。只给缺软件的选项接入 `Ask` 范围提示，与全局 apply 同步接通。沿用受保护子进程和持久记录，在 prefix 上串行。可选工具接入已批准 operations 与 apply，使用现有继续、旧批准和 result 展示。项目/全局目的地和回执检查分开，报告已完成的全局写入。序列化同前缀安装，先保存每个完成项。用第二个操作出错和现有 `before-manifest` 故障注入证明进程退出前报告部分结果和原审批恢复动作。
- [ ] 重跑相同命令，验证超时、失败和部分写入、两工具并行项目安装的既有用例、registry 错误提示和后续无变更。提交全局安装。

### Task 4: OpenSpec 两范围和项目 CLI

**文件** `src/cli.ts`、`src/integrations/sdd/{openspec,openspec-setup}.ts`、`src/integrations/tools/{recipes,installed-state}.ts`、`src/{lifecycle,generator/render}.ts`、`src/installer/{preview,apply}.ts` 和宿主指令/三个 change 模板。测试在 `test/openspec-setup.test.ts`。

**接口** `--prepare-openspec --install-scope project|global`，项目透传 `rigup openspec <args>`。`openspecPreparationCommand` 接受明确 scope。使用任务 3 的 global approval。项目包和独立审批保护工具目录和原生文件。

- [ ] 加红测覆盖已有 CLI 仅缺项目入口、全局不可写仍可安装项目、只存在便携 Node/npm、独立准备后取消主预览、新选择 `update --configure` 和 `update --sdd openspec`、生成命令的作用域及恢复。已有三个宿主入口但 CLI 或 root 缺失时验证 update 与 MCP 研究也给出准备动作。批准后移除或替换项目 CLI/配置时验证 apply 和 resume 拒绝过期批准。杀掉独立安装的控制器并改 `latest`，按原身份和范围恢复，半成品 PATH launcher 保持阻塞。`!/tools/` 或已跟踪的安装或 staging 范围下文件须保持原字节，writer 启动次数为零。
- [ ] 运行 `node --import tsx --test test/openspec-setup.test.ts`，确认只能全局安装的基线失败。
- [ ] 实现 project/global 成熟路径，复用 staged 安装。独立写入前保存私有审批和阶段，恢复时先读原审批，再检查当前文件及 writer 状态。工具落盘前合并管理忽略块并保留用户行。用现有 Git 检查约定核验实际 staging 与最终路径的有效 ignore 和 tracked 内容，在发布前复核。让项目透传从根执行原生 argv 并给宿主和工作流引用写明调用方式。统一原生 root、CLI 与技能就绪检查，在准备、生成、应用和恢复使用同一验证。继续原生缺失 step 和会话交接。
- [ ] 重跑聚焦和 CLI 端到端用例。用无裸 Node/npm 和 OpenSpec 的便携安装检查项目准备及实际提案/apply 入口内 CLI 命令，包括 `new change`、`status`、`instructions`。从子目录实走原生 `--json`、`--verbose`、`--`、含空格参数及非零退出状态。确认 native gate 和旧准备调用。提交 OpenSpec 变更。

### Task 5: 端到端验证与交付

- [ ] 跑 `npm run check`、`npm audit --audit-level=low`、干净隔离项目的真实 npm/便携 release smoke、两个工具两范围与第二项目自动复用。回归保留源内容、安全 PATH、失败恢复、已有 CodeGraph 索引和 OpenWiki 内容。
- [ ] 覆盖当前可用的真实宿主。Codex 用 `skills/list`，OpenCode 用对应版本的技能与命令入口，OMP 验证 `skill://` 与 RPC 清单，Claude 检查注册的插件与生成技能。比较实际来源。复跑 OMP canary，验证 `enableSkillCommands` 两状态、`skill:rigup-live-canary` 与 `source:skill`，Spec Kit 用 `source:file`。实测主开关与仅隐藏 slash 的差异，以及 Claude 所需的原生调用权限。记录历史原因仍未知时使用新证据的精确结论。
- [ ] 验收修复采取红绿复跑，并进行整个分支审查。`docs/compatibility/status.md` 的 12 格各有脱敏回执或 `not live-tested` 与原因。CI 检查 Linux、macOS、Windows、WSL2，额外核对 `claude,omp` 在 Windows 的交互 apply。用 0.6.0 可执行文件准备已保存及中断的 CodeGraph 批准，验证版本边界和原版恢复。中断 0.6.0 的独立 OpenSpec 安装，验证新版遵守旧前缀锁、旧残留和互斥，遇无旧成功证据时引导安全对账。
- [ ] 完成回归和端到端后更新版本、lockfile、changelog、双语 README、使用和安装文档。重跑 `npm run check`、`npm pack --dry-run --json`、归档和签名/摘要验证、远程 CI。合并实施分支，按发布指南打 tag，等待 GitHub Release 与 npm Trusted Publishing。
- [ ] 核对发布 tag 和合并提交、GitHub/npm 完整性、公开包安装与版本、便携安装器成果。随后推进默认 `install.sh` 并验证。确认两条 Issue 的关闭状态和最终发布。

## 审查记录

- 第一轮独立反查审批与数据保护。补回了 OpenSpec 有效 Git 忽略与已跟踪路径检查，并明确旧版本审批沿现有版本边界完成或重新生成。加入 negation、tracked、staging 和 v0.6.0 中断验收。
- 第二轮独立反查复用条件和原生入口。明确 `--tools` 按成员选择、同名记录优先及缺失 PATH 的交互重配路径。记录 Spec Kit 项目依赖与独立的快照验证，并增加全局安装后接线异常用例。核对 Codex 当前版本和 OpenCode 配置禁用/合并优先级，补 OpenSpec 缺原生 CLI/root 时的 update 与 MCP 路径。
- Ponytail 收掉重复分支和状态表达。沿用布尔配置、现有预览与 writer，按已批准范围区分项目/全局回执。复用项目根定位与最小启动入口，OpenSpec 独立准备共享安装核验，原生发现继续只输出 `SkillSource`。
- 精简后第三轮核查写入与恢复。沿用历史 OpenSpec 前缀锁，明确旧无回执写入及本版独立准备的批准恢复。加第二个全局安装失败的部分结果用例，并保留原生 OpenSpec 参数。把全局选择纳入继续审批摘要。
- 精简后第四轮核查可调用名称与来源。补 OpenCode V1/V2 注册 ID、兼容根和权限处理，OMP 按有效宿主记录处理覆盖和技能主开关，Claude 检查命名空间及调用权限。保存预览验收覆盖 loader 入口与 manifest 变动。
