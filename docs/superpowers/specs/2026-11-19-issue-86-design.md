# Rigup #86 用户可见原因的中英本地化

## 目标与范围

为配置文件、命令行校验、工作流就绪检查、原生准备、OpenSpec 准备和 doctor 的 Rigup 自有原因提供中英词条。用户应能定位错误和修正方法，命令、路径、环境变量名、技能名和产品名仍可原样复制。外部工具、操作系统、用户脚本和范围外未分类的原因沿用原文回退。术语用法见 [CLI 中英术语表](../../guides/cli-terminology.md)。

#85 负责 doctor 分组、摘要和帮助建议，以及 `--agent` 拼写提示和终端上的 `--sdd` 合法值提示。#86 负责配置文件中的 `sdd` 校验原因和 doctor 单条诊断的名称与原因。#87 负责结果标题、下一步和输入错误是否显示安装结果。#88 负责原生进度、审批与呈现顺序。

## 基线核对

基线为 GitHub main `51406c25a348937ca0487aacde5bd4a3e691729c`，包版本 `0.10.0`。在 macOS arm64、Node `24.15.0` 上通过 `runCli` 重放下列 25 个输入，另用 `node --import tsx src/cli.ts` 核对配置 JSON 和 SDD 预览的实际进程输出。每个场景使用临时项目、HOME、缓存和状态目录。用本地可执行文件模拟 OpenSpec 和智能体，用注入的 HTTP 503 响应重现 OMP 下载失败。doctor 读取临时项目的配置元数据。

- 25 条中有 14 条泄漏英文，全部是 issue 指名的条目。Issue 正文只给出 5 条命令行泄漏及 10 条 YAML 场景的输入，C06–C15 是为补齐回归矩阵而选的 10 条现有中文对照。Issue 的全库 `throw` 统计属于历史证据，本轮核实了 `cli-output.ts:31` 中的 49 个反查词条。
- `src/cli.ts:36` 的 `errorMessage` 抽取英文，`src/cli-output.ts:44` 仅识别与英语词条完全相等的字符串。OpenSpec 在 `openspec-setup.ts:143–150` 生成字符串，向导在 `setup-detection.ts:49–56` 拼接异常，原生准备将 blocker 的 `reason` 原样插入。doctor 在 `installer/doctor.ts:159–165` 把用途、位置和来源拼成一行英文。
- 带 `--language zh-CN` 的 `update --continue nope` 在文件读取前因显式选项冲突返回 2。用系统中文执行无语言参数的同一命令则报告 `continuation id invalid`，也返回 2。两条分支都进入回归覆盖。
- OpenSpec fixture 返回 3，终端显示 `OpenSpec：OpenSpec project root is missing` 和 `OpenSpec：claude: OpenSpec workflow entries are missing`，`pending` 与 `requiredInput` 都含两条英文。Superpowers 预览返回 3，普通结果原因和 verbose 详情都含 `superpowers: claude: missing native entry: superpowers:brainstorming; /plugin install superpowers@claude-plugins-official`。用 OMP 打开向导后取消返回 130，取消前显示 `检测到项目中的 superpowers 线索 · omp: missing native entry: superpowers:brainstorming`。
- OMP 准备返回 3，智能体状态行和 `download-failed` 行都显示 `Could not download OMP metadata or package from its official URL.`。doctor fixture 显示 `rigup:research-launcher`、`mcp:claude:rigup` 和 `Selected Rigup CLI research provider; destination: .rigup/.env; source: project-file`。doctor 在两种语言下的 JSON 字节相同，失败时的顶层 `error` 来自旧输出顺序最后一行的英文副本，可能是一条可用状态的环境诊断。

## 25 项回归矩阵

命令在给出的 argv 末尾加 `--language zh-CN`。Y01–Y10 分别将内容写入独立项目的 `.rigup/config.yaml` 后执行 `init`。C05 使用仅含 `agents: [claude]`、`backend: host` 选项及空资产清单的有效 manifest，确保进入旧资产检查。每行以真实人读输出及给出的退出码验证。表中英文漏句也是该场景既有 JSON `error` 的值。

| 编号 | 输入 | 退出码 | 基线泄漏或中文对照 | 中文输出验收 |
| --- | --- | ---: | --- | --- |
| C01 | `init --tools none,openwiki` | 2 | `tools: none cannot be combined with a tool` | 说明 `none` 必须单独使用 |
| C02 | `init --profile nope.json` | 2 | `profile: file not found` | 指出找不到 `nope.json` |
| C03 | `init --api-key-env lower` | 2 | `model.apiKeyEnv: environment reference required` | 指明 `--api-key-env` 或 `model.apiKeyEnv` 需要合法环境变量名，给出 `ANTHROPIC_API_KEY` 示例 |
| C04 | `update --continue nope` | 2 | `continuation cannot change explicit selections or execution mode` | 提示继续时沿用原选项和执行模式 |
| C05 | `update --retire x` | 1 | `retirement id not in old inventory` | 指出上次安装清单中找不到 `x` |
| C06 | `init --unknown` | 2 | 已中文 | `未知选项` |
| C07 | `init --profile` | 2 | 已中文 | `--profile`、`缺少参数值` |
| C08 | `init --agents foo` | 2 | 已中文 | `--agents`、`分隔支持的值` |
| C09 | `init --tools foo` | 2 | 已中文 | `--tools`、`分隔支持的值` |
| C10 | `init --dry-run --review` | 2 | 已中文 | `执行模式只能选择一种` |
| C11 | `init --request relative.json` | 2 | 已中文 | `绝对文件路径`、临时缓存的 `host` 目录 |
| C12 | `doctor --check-host codex` | 2 | 已中文 | `--check-host claude`、`只能与 doctor 一起使用` |
| C13 | `doctor --research-tokens 10` | 2 | 已中文 | `--research-tokens`、`仅适用于 Codex 调研` |
| C14 | `init --install-scope project` | 2 | 已中文 | `--prepare-openspec`、`project`、`global` |
| C15 | `init --prepare-native --agents claude --sdd openspec` | 2 | 已中文 | `请与 init 一起使用`、`--sdd superpowers` |
| Y01 | `agents: [claude, foo]` | 2 | `agents: expected supported agent list` | 文件、`agents[1]`、`claude, codex, opencode, omp` |
| Y02 | `agents: claude` | 2 | `agents: expected supported agent list` | 文件、`agents` 需要列表、同一组合法值 |
| Y03 | `sdd: bar` | 2 | `sdd: unsupported selection` | 文件、`sdd`、`none, superpowers, openspec, spec-kit` |
| Y04 | `tools: [x]` | 2 | `tools.0.id: unsupported` | 文件、`tools.0.id`、`openwiki, codegraph` |
| Y05 | `agents: [claude` | 2 | `config: invalid YAML syntax` | 文件、YAML 语法有误 |
| Y06 | `model: {provider: anthropic}` | 2 | `model.model: required` | 文件、`model.model` 需要模型名称 |
| Y07 | `mcp: [{id: x}]` | 2 | `mcp.0: choose url or command` | 文件、`mcp.0`、`url` 和 `command` 二选一 |
| Y08 | `backend: nope` | 2 | `backend: expected codex, native or host` | 文件、`backend`、`codex, native, host` |
| Y09 | `executionPolicy: {mode: fast}` | 2 | `executionPolicy.mode: continuous or review required` | 文件、`executionPolicy.mode`、`continuous, review` |
| Y10 | `documentLanguage: invalid_tag` | 2 | 已中文 | 文件、`documentLanguage`、`auto` 或 BCP 47 语言标记 |

## 设计

扩展英文反查表能补足固定句，参数化原因仍需要逐句约定。仅在 CLI 包装错误能提供统一外观，原因代码和参数却已经在拼接时丢失。采用 issue 建议的生产端原因代码与参数，沿现有调用链传递到呈现边界。复用现有 i18n 词条和 `AsyncLocalStorage` 语言上下文。

### 原因表示与兼容

- 在 `src/i18n/reasons.ts` 定义 `ReasonCode`、`ReasonInput` 和 `ReasonError`。结构化原因含 `code`、`params` 及原有文本 `fallback`。参数可嵌套另一条原因，用于「智能体 + 问题 + 处理办法」和 doctor 环境项。调用 `renderReason(input, locale?)` 时才取词条，`reasonFallback(input)` 返回原有字符串。`ReasonError.message` 使用同一原文。普通字符串和无法识别的 code 直接返回原文。保留现有对 `SyntaxError` 的安全固定提示以及非 Error 的通用提示。
- `error`、`reason`、`pending`、`requiredInput`、`blockers`、`diagnostics[].id`、现有原生 blocker `code`、推荐命令和退出码继续采用当前值和类型。优先保留两种 UI 语言下现有 JSON 的一致性和原生报告原有值。本设计选择零 JSON 字段新增。报告的原有文本照常构造，可选的 symbol 属性承载内存中的呈现数据。现有 `JSON.stringify` 和以 `Object.entries` 为基准的签名继续读取原有字段。doctor 分组后的 JSON `error` 仍按旧行顺序计算。
- 预览通过 `LifecyclePresentation.preview(data, options?: {livePreview?: Preview; restored?: boolean})` 将内存中生成的原因传给 UI。#86 读取 `options.livePreview`，#87 提供 `options.restored`。磁盘中的预览和审批校验继续使用旧字符串及旧签名逻辑。从磁盘读回、缺少结构的历史预览详情继续识别旧版已翻译的四条文档与七条合并原因。这个兼容入口仅服务已保存详情。日常构造原因的入口统一使用代码。其余历史或外部文本按原文呈现。

### 生产端与终端

- 配置校验在实际读取的文件层添加文件名。项目配置使用 `.rigup/config.yaml`，profile 使用它自己的路径，CLI 覆盖项使用选项名或字段名。错误选项用字段或下标定位，避免复述未验证的配置值。合法值取自现有验证使用的列表。保留校验顺序、选项合并及 resume 行为。示例为 `原因: .rigup/config.yaml 中的 sdd 请选择 none、superpowers、openspec 或 spec-kit。`
- SDD 绑定处提供缺少入口、来源未确认或冲突等原因。OpenSpec 和 Superpowers 用代码识别缺入口，保留现有修复分支和命令。OpenSpec 的每条要求同时供直出、结果原因和预览详情使用。原生准备把结构化原因传到主机行、blocker 行和失败原因，`download-failed` 等现有机器代码仍表示处置类别。
- doctor 单条显示采用 `formatDoctorLabel(diagnostic, verbose?)` 和 `formatDoctorReason(diagnostic)`。内置条目有可读名称，例如「Rigup 调研启动器」「Claude Code 的 Rigup MCP 配置」。文件条目可显示实际路径，环境项显示变量名，未知条目有本地化通用名。`--verbose` 追加诊断 ID。来源、设置位置和未验证说明通过现有用途词条与结构化状态拼成完整句。示例为 `RIGUP_PROVIDER · 已选择的 Rigup CLI 调研提供方。设置位置：.rigup/.env。来源：项目文件。`

## 验收

1. 实测矩阵的 25 个场景均通过 CLI 输出回归，具体中文内容与表一致，已知英文原句全部消失。补测系统中文的裸 `--continue nope` 及配置文件中设置中文的启动方式。校验失败、取消和继续分支保留现有退出语义。标题交由 #87 验收。
2. 用临时 OpenSpec、Superpowers、OMP 和 doctor fixture 重放上述基线。验证 OpenSpec 的多条要求与最终原因、Superpowers 预览及 verbose 详情、向导提示、OMP 主机行与失败原因、doctor 默认及 verbose 的终端文本。断言中文解释出现、旧英文句子消失，以及相同命令、路径和标识符仍可获得。
3. 测试逐一枚举所有 `ReasonCode`，检查 en 和 zh-CN 的非空词条、参数占位符一致性以及终端 locale 与 artifact locale 的独立性。覆盖普通字符串、未知代码、嵌套参数与终端转义。
4. 用已观测的旧值验证 JSON stdout 和公开数据类型，包括 Y03 的 `error: "sdd: unsupported selection"`、OpenSpec 两个字符串数组、SDD 的 `reason`/ `nextCommand`、OMP 名称/原因/既有代码及 doctor 诊断和顶层 `error`。用旧字符串预览和签名做回归，验证既有预览和重入仍可走原来的审批路径。
5. [术语表](../../guides/cli-terminology.md) 提供中英对应，作为 #85、#87、#88 编写相关显示文案的用词依据。

[Issue #86](https://github.com/ansonli-dev/rigup/issues/86)
