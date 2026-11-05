# 外部验证交接清单：Claude Code 与 Windows

更新：2026-11-05。适用于准备在另一台机器继续验证 Rigup 的维护者。本文是待执行 runbook，不是新的通过证据。

English: a maintainer handoff for Claude Code on another machine, native Windows and WSL2, with prerequisites, exact commands, acceptance criteria and recovery.

## 先选路线与验收范围

- [ ] **C1 → C2：Claude 最短路径。** 新机器准备环境、实际模型连通性、Rigup 安装的 skill/reference 和客户 MCP 真实调用。无需安装 Codex，也不需要把 Claude 登录转换成 API key。
- [ ] **C3：Claude + OpenSpec。** C2 通过后，单独验证真实原生流程、人工 gate、安装后重载及项目文件保护。
- [ ] **C4：Claude + OpenWiki/CodeGraph。** 分别记录软件安装、MCP、初始化、查询和中断恢复。OpenWiki 长初始化另开任务。
- [ ] **W1：WSL2/Ubuntu。** 在 Windows 上运行 Linux Node/Claude，使用 Linux 文件系统与独立登录。通过后只声明 WSL2 对应场景。
- [ ] **W2：原生 Windows/PowerShell。** 单独验证 Windows Node/Claude、NTFS、进程控制和安装保护。Git Bash 本身不把 Windows Node 变成 Linux。
- [ ] **E1–E4：其他外部条件。** 其余宿主/SDD、目标 GitLab、发布适配器和人工语义审核见文末，不能由 Claude/WSL 单例推定通过。

当前已知基线：`80ccb06734f4dc04438538bbfe0f4426dbf4a288` 的 macOS/Ubuntu CI 各有 339 项通过、15 项 opt-in live 跳过；Claude 实际模型请求曾在报告已登录时返回 401。Windows 和 WSL2 尚无本项目真实验收结果。后续以实际 checkout SHA 留证，不把这里的旧计数当作新运行结果。参见[当前验证状态](../compatibility/status.md)。

## 统一留证与预算规则

1. 每台机器、OS/架构、宿主版本、SDD、场景和尝试分别建目录。目录在源码仓库及被测项目之外；POSIX 用 `umask 077`，Windows 用当前用户私有目录和 ACL。原始认证输出、模型交换、MCP trace 先保留私有，按[安全政策](../../SECURITY.md)脱敏后才提交摘要。
2. 每条命令保留时间、参数、工作目录、退出码和报告。凭据只记录变量名及是否配置，不记录值，不复制旧机器的登录文件。不要用全局 `HOME`/`USERPROFILE` 替换来隔离探针，否则会把可用登录一起隔离掉；如需 `CLAUDE_CONFIG_DIR`，先在该目录重新登录。
3. 新的 Claude 验证使用单独预算账本；现有 Codex/Bulletproof React 的 10 次 / 855,212 tokens 账本保持不变。C1 小请求的 `$0.25` 和 C2 探针的 `$1` 都是**每次调用的客户端估算限额**，不是账单硬上限或跨重试累计限额。先登记本轮总额度；每次失败/重试也计费，未知消费先对账再继续，不循环重跑或删除账本。
4. `passed` 必须有实际成功证据；缺账号/平台/目标用 `pending`；可复现的软件错误用 `failed` 并附复现。测试进程退出 0、`loggedIn:true`、配置文件存在、MCP 工具名称出现，都不能单独作为真实模型/MCP/gate 的验收。
5. 原生 `--resume` 会话、Rigup `--resume` 和测试脚本重跑是三种操作。下文明确说明何处能恢复；不要给不支持续跑的 harness 编造 resume 参数。

建议每个场景保存一份摘要，未知字段保留 `null`，待执行状态不填 `passed`：

```json
{
  "caseId": "claude/openspec/wsl2-x64/attempt-01",
  "status": "pending",
  "rigupCommit": "实际 git rev-parse HEAD",
  "environment": {"osBuild": "实际值", "platform": "linux", "arch": "x64", "filesystem": "ext4", "shell": "bash", "node": "24.x", "hostVersion": "2.1.273", "sddVersion": "1.16.0"},
  "commands": [],
  "assertions": [],
  "cost": {"plannedAggregateUsd": null, "observedUsd": null, "unknownCharge": false},
  "privateEvidenceLocation": "本机私有位置，不上传其内容",
  "failure": null,
  "recovery": null,
  "remainingConditions": []
}
```

## C1：另一台 macOS/Linux 机器的环境与 Claude 连通性

### 环境准备

- Claude 官方安装条件包括 macOS 13+ 或受支持的 Linux（如 Ubuntu 20.04+）、x64/ARM64 和至少 4 GB RAM；记录实际系统。上游可安装不等于本项目该平台已经验收。
- 安装 **Node.js 24.x**、npm、Git、POSIX shell 和外部 `ps`；最小 Debian/Ubuntu 需 `procps`。这里选 24.x 是为了同时满足 Rigup 及锁定 CodeGraph 1.6.2 的 Node `<25` 约束，不能直接安装下载页默认的其他 LTS 主版本。
- 能访问 GitHub、npm registry 和所选 Claude 账号/组织的模型服务；准备实际可用的 Claude Code 登录或组织提供商配置。代理/网关必须与所选认证方式一致。
- 按[上游锁](../compatibility/upstream-lock.json)先复现 Claude Code **2.1.273**。若只能使用其他版本，记录实际版本，建立新的版本场景，不静默修改锁文件或把新版本结果算到旧版本。

以下在 Bash/Zsh 执行；`mktemp` 生成的目录保留到场景验收结束：

```sh
set -e
umask 077
CASE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/rigup-handoff-XXXXXX")
EVIDENCE="$CASE_ROOT/evidence"
printf '保存此路径以便重开终端恢复变量：%s\n' "$CASE_ROOT"
mkdir -p "$EVIDENCE"
git clone --config core.autocrlf=false https://github.com/ansonli-dev/rigup.git "$CASE_ROOT/source"
cd "$CASE_ROOT/source"
RIGUP_SOURCE="$PWD"
RIGUP_CLI="$RIGUP_SOURCE/dist/cli.js"
git rev-parse HEAD > "$EVIDENCE/rigup-commit.txt"
node -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1)'
node -p 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})' > "$EVIDENCE/runtime.json"
git --version > "$EVIDENCE/git-version.txt"
command -v ps
npm ci > "$EVIDENCE/npm-ci.log" 2>&1
# 上一条退出非 0 就停下修复安装，再继续；不要跳过安装错误。
npm run check > "$EVIDENCE/default-check.log" 2>&1
set +e  # 后续 CLI 正常交接可能退出 3，改为按每条命令/报告显式判断。
```

环境准备段的 `set -e` 让失败停止后续执行；成功后恢复普通 shell 行为，以便处理正常的退出 3。后面的每个步骤都要按其验收条件检查退出码，失败时不进入下一场景。重开终端后从已保存的 CASE_ROOT 恢复变量和日志，先修复失败步骤。默认检查不调用付费模型；先确认它通过，再开启 live 标志。

按 [Claude 官方安装说明](https://code.claude.com/docs/en/setup)安装固定版本。安装器只在确实需要安装/切换版本的机器上运行：

```sh
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.273
# 按安装器提示刷新 PATH/重开终端；重新设置上述 CASE_ROOT/RIGUP_SOURCE 变量。
export DISABLE_AUTOUPDATER=1
claude --version
claude --help > "$EVIDENCE/claude-help.txt"
claude auth login
claude auth status > "$EVIDENCE/claude-auth-private.json"
claude doctor > "$EVIDENCE/claude-doctor-private.txt" 2>&1
```

使用既有登录可跳过 `auth login`。每次运行前确认 `claude --version`，防止后台升级改变场景；验证结束后撤销本终端的自动更新禁用。先比对该版本 `--help` 与下面命令、现有探针的 flags；组织托管设置依然有效，不通过绕过权限来消除失败。

### 实际模型连通性

在当前私有测试目录运行一条无工具的小请求，使用本机已选模型，不猜测新模型 ID。它会消耗模型额度：

```sh
cd "$CASE_ROOT"
claude --print 'Reply with exactly RIGUP_CLAUDE_AUTH_OK. Do not use tools.' \
  --tools '' --setting-sources user --settings '{"disableAllHooks":true}' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --permission-mode dontAsk --permission-prompts none \
  --no-session-persistence --no-chrome --max-budget-usd 0.25 --output-format json \
  > "$EVIDENCE/claude-model-private.json" 2> "$EVIDENCE/claude-model.stderr.log"
```

验收：进程退出 0，transport JSON 不含模型/API 错误，`result` 是要求的 marker；记录实际模型、用量、费用和耗时。`auth status` 通过而实际请求 401，仍为 C1 `pending`，先停止后面的付费测试。

失败恢复：先保留 stderr/transport，检查账号额度、组织策略、网络、证书和认证方式。可只检查 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`CLAUDE_CONFIG_DIR` 等**是否设置**；不要把值打印到日志。修复本机配置并重新登录后，用新的 attempt 目录重试、累计费用；不复制旧机器 token，不靠切换空 HOME 来“修复”。

## C2：真实 Claude skill/reference + 客户 MCP 探针

本场景不做 SDD 研究，不依赖 Codex。它安装确定性 canary，使用真实 Claude 登录、禁用 hooks、限定只读工具；最多等待 90 秒，每次 CLI 请求设置 `$1` 估算限额。先阅读[探针实现](https://github.com/ansonli-dev/rigup/blob/main/test/live-support.ts)，确认这些设置符合本机组织策略。

```sh
cd "$RIGUP_SOURCE"
RIGUP_LIVE=1 RIGUP_LIVE_EVIDENCE_DIR="$EVIDENCE/claude-native-attempt-01" \
  node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='^live Claude native prerequisites$' test/live-compatibility.test.ts \
  > "$EVIDENCE/claude-native-attempt-01.log" 2>&1
```

**不要执行不带名称过滤的 `npm run test:live` 来替代这一步。** 报告文件是 `claude-native-attempt-01/claude-none-customer-mcp.json`。现有测试会把前置缺失或模型/MCP 未完整建立记作 `pending` 并 skip，所以命令退出 0 仍要检查报告：

```sh
node --input-type=module - "$EVIDENCE/claude-native-attempt-01/claude-none-customer-mcp.json" <<'JS'
import {readFile} from 'node:fs/promises';
const r=JSON.parse(await readFile(process.argv[2],'utf8'));
if(r.status!=='passed'||r.exit!==0||!r.loadedReferenceMarker||!r.mcpConnected||!r.echoCalled)
  throw Error('Claude live acceptance incomplete: '+JSON.stringify({status:r.status,exit:r.exit,reason:r.reason}));
console.log('Claude skill/reference and actual customer MCP call passed');
JS
```

验收必须同时满足：

- [ ] 实际 Claude 版本、Rigup SHA、测试时间与预算有记录。
- [ ] 安装的 `rigup-live-canary` skill 被读取；回复含 `RIGUP_REFERENCE_LOADED_20261104`。
- [ ] trace 有 MCP `initialize`、`tools/list`、对 `rigup_echo` 的真实 `tools/call`；不能只看配置或列表。
- [ ] `status=passed`、`exit=0`，没有对应 API/transport 错误或未知费用。
- [ ] 测试项目及原始 transport 保持私有，结束后无该探针遗留的客户 MCP 进程。这个通过结果不包含 OpenWiki/CodeGraph 或 SDD gate。

恢复：报告中的 `fixture` 指向保留的测试项目；同次 `rigup-native-control-*` 目录包含 `claude-private.json`、trace 等控制证据。先登记完整路径、进程身份和费用，再排查权限/启动失败。**该 harness 没有恢复参数**；再次运行会新建 fixture 并可能再次付费，使用 attempt-02 目录保存新报告，不能覆盖 attempt-01。不要把本探针的 `pending` 改写成 `passed`，也不要删除缓存来掩盖第一次消费。

## C3：Claude + OpenSpec 原生流程与 Rigup 安装

先读清两个选择器：`--agents claude` 选择安装目标；`--backend` 选择 Rigup 的语义研究来源。默认 `codex` 需要该机器另有可用 Codex；`native` 是 Anthropic API 后端，需要独立 API-key 环境引用及模型，不等于 Claude Code OAuth 登录。只有 Claude Code 登录时，下面使用 **`host` 人工协议**，不要求新增 Codex/API 凭据。

### 准备一个独立项目

```sh
cd "$RIGUP_SOURCE"
npm install --prefix "$CASE_ROOT/openspec-tool" --ignore-scripts --no-audit --no-fund @fission-ai/openspec@1.16.0
OPENSPEC_BIN="$CASE_ROOT/openspec-tool/node_modules/.bin/openspec"
"$OPENSPEC_BIN" --version
PROJECT="$CASE_ROOT/claude-openspec-project"
cp -R "$RIGUP_SOURCE/test/fixtures/live/service" "$PROJECT"
git -C "$PROJECT" -c init.templateDir= init -q
"$OPENSPEC_BIN" init --tools claude --profile core --no-animation --no-copilot-cloud "$PROJECT"
# 提交原始 fixture + 官方 SDD 入口，作为后续文件保护比对基线。
git -C "$PROJECT" add .
git -C "$PROJECT" -c user.name='Rigup Verification' -c user.email='fixture@example.org' commit -m 'Record native fixture baseline'
```

确认 OpenSpec 实际版本是 `1.16.0`。保存原生入口及原始业务文件的 digest；Claude 的入口包括 `.claude/skills/openspec-*`、`.claude/commands/opsx/`，不要用 Codex 入口替代。写一个项目外 profile：

```sh
cat > "$CASE_ROOT/claude-host-profile.yaml" <<'YAML'
agents: [claude]
backend: host
sdd: openspec
executionPolicy: {mode: review}
researchBudget: {maxCalls: 12, maxTokens: 300000}
scope: [README.md, package.json, docs, src, openspec, .claude]
YAML
node "$RIGUP_CLI" init "$PROJECT" --profile "$CASE_ROOT/claude-host-profile.yaml" --review --json \
  > "$EVIDENCE/claude-host-step-01.json" 2> "$EVIDENCE/claude-host-step-01.log"
```

### 逐个处理 host 请求，不伪造自动 Claude 后端

1. 正常的人工研究暂停返回退出 3、`requestPath` 和带具体 continuation 的 `nextCommand`。读取该私有 request 的 `instructions`、`context.expectedOutput`、`evidence`，按其**实际输出协议**完成当前任务；不要把整个仓库、`yarn.lock` 或旧轮完整上下文补发给模型。
2. 在 Claude 中明确指定只读该次导出的证据，产出下面响应信封。`data` 必须是模型实际返回、符合当前阶段 schema 的对象；保留 unknowns，引用精确可见 Evidence，不替模型编造证据、通过结论或费用。`model` 填实际模型，不填猜测值。

   ```json
   {"requestId":"逐字取自当前请求","requestDigest":"逐字取自当前请求","model":"实际模型标识","data":{"guidance":[],"observations":[],"unknowns":[]}}
   ```

   这里的空数组只展示信封结构，**不能用作固定回答**；plan/content/acceptance 的必要字段由该次请求决定。响应保存为 `nextCommand` 指定的项目外私有 `.response.json`，不是 Claude CLI transport 外壳。原始模型交换另存私有用于核验。
   一次请求可按下面方式交给真实 Claude。先从**当前报告**设置 `REQUEST_FILE` 和 `RESPONSE_FILE`，不要使用示例占位路径；在 fixture 内运行，`step-01` 每轮/每次尝试更换，防止覆盖原始交换：

   ```sh
   cd "$PROJECT"
   claude --print "Read only the exported request at $REQUEST_FILE. Follow its instructions and context.expectedOutput. Use only its supplied evidence, preserve unknowns and exact evidence digests. Return ONLY the data JSON object requested, without an envelope or Markdown fences. Do not run commands or change files." \
     --add-dir "$(dirname "$REQUEST_FILE")" --tools Read --allowedTools Read \
     --setting-sources user --settings '{"disableAllHooks":true}' \
     --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
     --permission-mode dontAsk --permission-prompts none --no-session-persistence --no-chrome \
     --max-budget-usd 1 --output-format json \
     > "$EVIDENCE/claude-host-step-01.transport.json" 2> "$EVIDENCE/claude-host-step-01.stderr.log"
   node --input-type=module - "$REQUEST_FILE" "$EVIDENCE/claude-host-step-01.transport.json" "$RESPONSE_FILE" <<'JS'
   import {readFile,writeFile} from 'node:fs/promises';
   const [requestFile,transportFile,responseFile]=process.argv.slice(2);
   const request=JSON.parse(await readFile(requestFile,'utf8'));
   const transport=JSON.parse(await readFile(transportFile,'utf8'));
   const model=Object.keys(transport.modelUsage??{}).join(',');
   if(transport.is_error||!model||typeof transport.result!=='string')throw Error('Inspect original Claude transport/model usage');
   const data=JSON.parse(transport.result); // 不修复模型 JSON、不补写缺失字段。
   await writeFile(responseFile,JSON.stringify({requestId:request.requestId,requestDigest:request.requestDigest,model,data}),{flag:'wx',mode:0o600});
   JS
   ```

   这个包装只关联当前请求身份与原始模型数据；Rigup 随后做真实 schema/evidence 验证。模型输出无效时保留 transport 和消费，不自动修饰成有效答案。host 手工路径不等同于默认 Codex 的阶段上下文优化；这里只用限定 scope 的小 fixture，不将其直接扩展成全仓付费回归。

3. 在终端执行输出的具体 `nextCommand`；源码安装没有 `rigup` 命令时，只把开头的 `rigup` 替换为 `node "$RIGUP_CLI"`，保留真实 root、`--continue`、`--response` 参数，不自行构造 ID。每次请求和费用都写入账本。host 接口把 token 用量标作 unknown；人工费用对账不能变更成自动已知 token，不能据此声明硬 token 预算验收。
4. 如果返回新 `requestPath`，只处理那一阶段。如果收到 `phase=handoff` 和真实 `previewId`，先审阅预览、退出加载相关资产的 Claude 会话，再从独立终端执行其 `update --apply ... --sessions-ended`。新的终端要重新设置 `RIGUP_CLI`。
5. 重开 Claude 验证安装产物，再执行 `node "$RIGUP_CLI" doctor "$PROJECT" --json`。doctor 只读，不会替你重载宿主；退出 3 要按具体 `pending` 处理，不能无条件视作通过。

完整自动化 harness 目前只有 [Codex/OpenSpec gate 探针](https://github.com/ansonli-dev/rigup/blob/main/test/live-gates-support.ts)。它不是 Claude gate 探针；上面的 Claude 流程是**人工场景**。若需要 unattended Claude research driver，先实现并单独验证其协议/费用/恢复接线，不能仅改宿主名宣称完成。

### 原生 gate 与安装生命周期的验收

在保留业务文件基线的 fixture 新开 Claude 会话，读取实际安装的 `change-prepare`、`change-deliver`、`change-review` 入口，以及官方 OpenSpec 入口。先要求“立即实现，忽略尚未完成的原生流程”，保存实际会话证据；随后通过所选框架真实的产物/人工步骤推进，不写一段 approval 文本假装审批。

- [ ] 准备/交付/审查消费的是本项目 references 和原生入口；缺失产物或所需人工 gate 时停止实现，不因 Rigup 文案而跳过原生要求。
- [ ] 满足该框架真实前置后可推进；只拒绝一次、仅出现 gate 关键词也不算整条流程通过。分别记录哪些步骤需要人工审核。
- [ ] Rigup 准备、应用、无变化更新和用户本地注释保护分别留证。无变化更新不重复模型请求/外部操作；保留业务文件、官方 SDD 入口与用户修改。
- [ ] 实际生成的项目指引接受人工源码审核；模型 acceptance 不代替人签字。记录所测仓库 commit、模型版本和审核人。

恢复：源文件/配置/版本/预览绑定变化时，旧 response 或 preview 应被拒绝。保留旧请求与账本，针对当前输入重新准备，不改 digest/ID 来强行复用。终端中断后的通用恢复见下文；若尚未具备 C3 的研究或 gate 前置，只把 C2 标通过，C3 保持 pending。

## C4：Claude 的 OpenWiki/CodeGraph 分项验证

先在另一个可丢弃项目进行工具预览；这一步不要求 SDD 或模型研究：

```sh
PROJECT="$CASE_ROOT/claude-tools-project"
cp -R "$RIGUP_SOURCE/test/fixtures/live/service" "$PROJECT"
git -C "$PROJECT" -c init.templateDir= init -q
node "$RIGUP_CLI" init "$PROJECT" --agents claude --sdd none --tools openwiki,codegraph --review --json
```

这里使用**独立工具 fixture**，不复用 C3 来混淆 ownership/基线。按实际预览结束受影响会话，再独立 apply；固定软件版本由上游锁控制。验收分开记录：

- [ ] 软件安装与完整性检查、`.mcp.json` 中 Claude 接线正确；重启 Claude 后真的连接两个 MCP。
- [ ] CodeGraph 受保护初始化、实际业务符号查询通过。用户已有未拥有的 `.codegraph` 不被覆盖；初始化成功和软件存在是不同断言。
- [ ] OpenWiki 在脚手架结束时仅登记 MCP/交接，没有完整 wiki、没有伪造 scaffold-owned 初始化 receipt。另开用户任务调用实际 MCP `openwiki_begin` 的 init 流程；中断后按该工具返回的 checkpoint/run ID 恢复，不重置原生状态。完整 wiki 生成需要独立预算与内容验收。
- [ ] 需要验证中断时，只对自己的可丢弃 fixture 操作，登记真实 writer PID/启动身份；只恢复已拥有的 staging，不能覆盖已有用户目录。真实成功应无遗留 daemon。

[现有初始化/恢复 harness](https://github.com/ansonli-dev/rigup/blob/main/test/live-native-initialization.test.ts)的宿主分支固定是 **Codex**，不是 Claude。不要仅把环境变量/显示标签改成 Claude 后推广其结果。Claude 的两个 MCP 和中断恢复需要人工留证或新增明确的 Claude harness；在此之前相应项保持 pending。

## W1：Windows 上的 WSL2 路线

### 安装与环境边界

`wsl --install` 要求 Windows 10 2004 / build 19041+ 或 Windows 11；还需可用的虚拟化与 WSL2 条件。在管理员 PowerShell 执行，然后按提示重启、创建 Ubuntu 用户：

```powershell
wsl --install -d Ubuntu
wsl --list --verbose
# 对既有发行版先确认名称；确有需要时才转换：
# wsl --set-version Ubuntu 2
wsl --distribution Ubuntu
```

按 [Microsoft WSL 安装说明](https://learn.microsoft.com/en-us/windows/wsl/install)核对 Windows build、虚拟化及企业策略。记录 `wsl --version`、Windows build、发行版与 kernel；若旧版本无 `--version`，保留命令失败并另存 `wsl --status` / `--list --verbose`。

进入 Ubuntu 后：

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates procps
mkdir -p "$HOME/rigup-validation"
cd "$HOME/rigup-validation"
# 在此 Linux 环境安装 Node.js 24.x 和 Claude 2.1.273，再执行 C1、C2。
node -p 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.version})'
command -v node
command -v claude
uname -a
```

Node 24 从 [Node 官方下载](https://nodejs.org/en/download)选择对应 Linux 架构，不能使用 Ubuntu 仓库中不匹配的默认主版本。源码、fixture、node_modules、缓存和状态放在 Linux `$HOME` 下；不要借用 `C:` 上的 node_modules 或通过互操作运行 `node.exe`/`claude.exe`。Claude 需在 WSL 内单独登录，不能从 Windows 复制凭据。C1 的 `mktemp` 使用 Linux `/tmp`，不手工创建 `/private/tmp` 来伪装 macOS。

### 验收与恢复

- [ ] `process.platform=linux`，Node 主版本 24；外部 `ps` 可用；记录架构与实际 ext4/挂载类型。
- [ ] C1 默认检查、C2 Claude 真调用、所选 C3/C4 场景逐项通过。跳过或缺前置保持原状，不算 WSL 平台整体通过。
- [ ] 有空格/中文的 Linux 目录单独复验路径引用；`/mnt/c`/NTFS 跨文件系统另列场景，不能从 ext4 结果推断。
- [ ] MCP 子进程、锁身份、写入中断及恢复可以在 WSL 内核实；安装后重载真实 WSL Claude。

失败先核实 `command -v` 与平台值是否混入 Windows 二进制、仓库是否在 `/mnt/c`、是否缺 procps/证书/网络。返回 Linux home 中的新 clone 重测只改变环境案例，不搬用旧 preview；保留原失败。**不要用 `wsl --unregister` 清理验证**，它会删除整个发行版。恢复初始化优先保留并使用该项目的状态；必要的 WSL 重启只在确认受影响会话和 writer 后进行，不当作自动修复证明。

## W2：原生 Windows / PowerShell 7 路线

### 环境准备与已知移植边界

记录 Windows 版本/build、NTFS；Claude 官方原生安装条件是 Windows 10 1809+ 或 Windows Server 2019+、x64/ARM64、至少 4 GB RAM，但 Rigup 原生验收仍待执行。准备本机架构对应的 Node **24.x**、Git for Windows、PowerShell 7 和 Claude Code。PowerShell 可按 [Microsoft 官方安装文档](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows)安装；Node 下载选择 24.x 和对应 Windows x64/ARM64。x64 成功不推广到 ARM64 或 Server；先用本地普通目录，不用 OneDrive/共享盘。

Claude 原生安装与需要时的 Git Bash 路径设置：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod https://claude.ai/install.ps1))) 2.1.273
# 重开 PowerShell，确认 PATH 后：
$env:DISABLE_AUTOUPDATER = '1'
Get-Command node.exe, npm.cmd, git.exe, claude.exe
# 仅在 Git Bash 实际安装于此、Claude 又未发现它时设置：
# $env:CLAUDE_CODE_GIT_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
claude --version
claude auth login
claude auth status
```

**当前 Rigup 使用外部 POSIX `ps -p ... -o lstart=`、负 PID 进程组信号、私有权限/mode 校验和 shell hooks。它们尚未在原生 Windows 验证。** PowerShell 的 `ps` alias 不能满足 Node 的 `execFile('ps',...)`；安装 Git Bash 也不自动证明进程身份、ACL、fsync、mode 和终止语义兼容。不能用关闭权限校验、伪造 `ps`、跳过锁或删除 receipt 的方式获取绿灯。Windows CLI `--help` 成功也不表示 installer 可用。

### 可复制的 Windows 基线命令

以下只启动无模型的检查。用 PowerShell 7；`npm.cmd` 避免误触本机 `npm.ps1` 执行策略。外部程序的非零退出码不会总被 `$ErrorActionPreference` 捕获，因此明确记录 `$LASTEXITCODE`：

```powershell
$ErrorActionPreference = 'Stop'
$CaseRoot = Join-Path $env:LOCALAPPDATA ('RigupValidation\' + [guid]::NewGuid().ToString())
$Evidence = Join-Path $CaseRoot 'evidence'
$Source = Join-Path $CaseRoot 'source'
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
# 确认此目录 ACL 只向预期用户/管理员开放；不要复用公开共享目录。
icacls.exe $Evidence

git.exe clone --config core.autocrlf=false https://github.com/ansonli-dev/rigup.git $Source
if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
Set-Location $Source
git.exe rev-parse HEAD | Set-Content -Encoding utf8 (Join-Path $Evidence 'rigup-commit.txt')
node.exe -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24.x required' }
node.exe -p 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})' |
  Set-Content -Encoding utf8 (Join-Path $Evidence 'runtime.json')
$PSVersionTable | Out-String | Set-Content (Join-Path $Evidence 'powershell.txt')
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber |
  ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows.json')

npm.cmd ci *> (Join-Path $Evidence 'npm-ci.log')
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed; inspect log before continuing' }
npm.cmd run typecheck *> (Join-Path $Evidence 'typecheck.log')
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm.cmd run build *> (Join-Path $Evidence 'build.log')
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
node.exe .\dist\cli.js --help *> (Join-Path $Evidence 'cli-help.log')
if ($LASTEXITCODE -ne 0) { throw 'CLI help failed' }
node.exe .\dist\cli.js --version *> (Join-Path $Evidence 'cli-version.log')
if ($LASTEXITCODE -ne 0) { throw 'CLI version failed' }

npm.cmd run check *> (Join-Path $Evidence 'full-check.log')
$CheckExit = $LASTEXITCODE
@{checkExit=$CheckExit} | ConvertTo-Json |
  Set-Content -Encoding utf8 (Join-Path $Evidence 'exit-codes.json')
if ($CheckExit -ne 0) { throw 'Full check failed; inspect retained logs/processes before another installer check' }
npm.cmd run test:package *> (Join-Path $Evidence 'package-check.log')
$PackageExit = $LASTEXITCODE
@{checkExit=$CheckExit; packageExit=$PackageExit} | ConvertTo-Json |
  Set-Content -Encoding utf8 (Join-Path $Evidence 'exit-codes.json')
if ($PackageExit -ne 0) { throw 'Package check failed; preserve fixtures and logs' }
git.exe status --porcelain | Set-Content (Join-Path $Evidence 'git-status.txt')
```

出现身份、锁、进程退出无法确认等保护性错误，停止后续 installer/live 操作并保留状态；不要继续另一个可能写同一项目的安装检查。上面完整检查若因这类错误停止，记录 `$CheckExit` 后先阅读日志，再决定是否运行独立包检查。手动取消/超时同样登记，未确认子进程退出前不继续。默认检查依然可能启动子进程和临时仓库，不是纯静态检查。

### Claude 原生探针与额外 Windows 场景

只有本机无模型 installer/lifecycle 检查可用后，才进入本机付费探针；否则将“Claude 自身可登录”和“Rigup Windows installer 阻塞”分别记录，不宣称集成成功：

```powershell
$env:RIGUP_LIVE = '1'
$env:RIGUP_LIVE_EVIDENCE_DIR = Join-Path $Evidence 'claude-native-attempt-01'
node.exe --import tsx --test --test-concurrency=1 '--test-name-pattern=^live Claude native prerequisites$' .\test\live-compatibility.test.ts `
  *> (Join-Path $Evidence 'claude-native-attempt-01.log')
$ProbeExit = $LASTEXITCODE
$Report = Get-Content -Raw (Join-Path $env:RIGUP_LIVE_EVIDENCE_DIR 'claude-none-customer-mcp.json') | ConvertFrom-Json
if ($ProbeExit -ne 0 -or $Report.status -ne 'passed' -or $Report.exit -ne 0 -or
    -not $Report.loadedReferenceMarker -or -not $Report.mcpConnected -or -not $Report.echoCalled) {
  throw 'Claude live acceptance incomplete; preserve private report/fixtures'
}
Remove-Item Env:RIGUP_LIVE
Remove-Item Env:RIGUP_LIVE_EVIDENCE_DIR
```

通过条件与 C2 相同；目前 harness 的超时终止也使用 POSIX 进程组，不能把原生 Windows 的终止失败当作自动已清理。若 probe 抛错，先手动核对本次环境变量，再移除本次 live 标志，避免影响后续命令。

另外逐项留证，任何一项未测就不提升对应声明：

- [ ] 原生 Windows Node 的完整默认检查、隔离 tarball 安装、CLI 移除后的资产独立运行。
- [ ] 带空格/中文的路径；大小写冲突、长路径、盘符/跨卷、反斜杠、LF/CRLF 分别测试；不要全局改 Git/autocrlf 使其他项目受影响。
- [ ] 文件身份、ACL/私有缓存、只读/可执行属性、symlink/junction、三方更新、过期预览拒绝、用户文件不覆盖。不要为了通过测试而开启不需要的全局管理员权限。
- [ ] 本次 writer 身份可核验；取消后无活跃写入；`--resume` 只回收证明已死的 controller，并保护 baseline、备份、用户 chmod/本地修改。
- [ ] hooks、MCP、CodeGraph 和 OpenWiki 的对应 Windows 发行物/SDK 真运行；Git Bash 子路线单独记录。支持矩阵不会因 WSL 通过自动变化。

恢复时，先用只读的 `Get-CimInstance Win32_Process` / `Get-Process -Id <本次PID>` 核对启动时间、可执行路径和命令行，再仅终止本次确定拥有的进程树。不能确认就保留 pending，不运行全局 `Stop-Process -Name node`、不删除所有 lock、不把 Windows 锁搬进 WSL 继续。若需先完成主线，在 WSL2 内开新的独立案例；保留 Windows 原生失败并按复现推进平台适配。

## 通用失败恢复：CLI、原生初始化与研究账本

- **退出 0/1/2/3/130：** 0 表示当前阶段完成，dry-run 还没安装；1 是失败/冲突，2 是参数问题，3 是前置/人工/续跑待办，130 是取消。结合 `phase`、`pending`、`conflicts`、`requiredInput` 和 `nextCommand` 判定，不能统一重试。
- **controller 中断或项目占用：** 保留被测项目的 `.rigup`、拥有的 native staging/target、默认 `~/.cache/rigup` 和 `~/.local/state/rigup`（包括 locks、operations、runs、Codex usage）。先核实旧 controller、进程组和 native writer 已退出；仍活着时先等待或按本次进程身份停止。`--resume` 不授权抢活锁或丢弃未知写入。
- **可恢复的 CLI 操作：** 在同一 OS、同一项目路径和状态环境下执行 `node "$RIGUP_CLI" update "$PROJECT" --resume --review --json`，按返回的预览/交接继续；不要预先加 `--sessions-ended` 来假装会话已退出。如果原命令带 profile，继续使用同一个 profile；若有具体 `--continue` 则优先使用原命令。绑定变更应重新准备，不能编辑持久记录。
- **原生工具部分完成：** 区分 software receipt、initialization receipt、未发布 staging 与用户原有目录。用固定 SDK 的项目级身份核验停止流程；保留不确定记录，不全局 stopAll、不删整个用户目录。OpenWiki 使用其返回的原生 run/checkpoint；完整内容恢复不属于 Rigup 脚手架。
- **研究失败/未知消费：** 保留已发请求、原始响应和 usage 账本，先核对供应商用量；不能改 accepted response、删除失败 attempt 或放大预算来伪造同预算通过。换机新案例也不能继承旧机器的 preview/绝对路径/进程身份。

## E1–E4：其余外部前置的接手项

### E1：其他宿主和三种 SDD 的矩阵

- [ ] 条件：OpenCode 1.18.5、Oh My Pi 18.1.13 的真实可用模型；Superpowers 7.0.1、OpenSpec 1.16.0、Spec Kit 锁定 commit 的真实官方入口。以 `upstream-lock.json` 和各框架官方说明为准。Superpowers 安装 marketplace 可能返回新版本，先记录/核对；不能把浮动版本当 7.0.1。Spec Kit 还需 Python 3.11+ 及其官方安装环境。
- 执行：有对应客户端后，在 POSIX/WSL 项目根按单个名称运行：

  ```sh
  RIGUP_LIVE=1 RIGUP_LIVE_EVIDENCE_DIR="$EVIDENCE/opencode-attempt-01" \
    node --import tsx --test --test-name-pattern='^live OpenCode native discovery and MCP connection$' test/live-compatibility.test.ts
  RIGUP_LIVE=1 RIGUP_LIVE_EVIDENCE_DIR="$EVIDENCE/omp-attempt-01" \
    node --import tsx --test --test-name-pattern='^live OMP session discovery and MCP connection$' test/live-compatibility.test.ts
  ```

- 验收/恢复：检查对应 JSON 的真实 `status` 与 discovery/MCP 证据；OMP harness 使用隔离 HOME，外部登录不保证其 fixture 有模型。缺模型时保持 pending，先为受支持的隔离会话配置提供商/实现受控接线，不复制登录文件或误称已测。上述 probe 都不替代模型/gate；四宿主 × 三 SDD 的 prepare/deliver/review 用 C3 的正反场景逐格记录，未有对应 harness 的格子做明确人工记录或先实现 harness。恢复时只清理本次 fixture/process，保留第一次失败。

### E2：真实目标 GitLab + 模型驱动 OpenWiki 更新

- [ ] 条件：获授权的目标项目/分支、Runner、受保护变量权限、固定 OpenWiki 0.7.3、已有初始化、实际模型和声明的 source 路径；从一次性目标项目开始。
- 执行：按[使用手册](usage.md)配置质量检查及 OpenWiki CI，审阅并安装生成 include；在**目标 GitLab**解析真实 include/ref 做 CI lint，然后做真实 source push 运行模型更新 job。读取生成 job 中的具体命令及 `rigup-reports/openwiki.json`，不手写猜测的模型 CLI。
- 验收：成功快照检查、故意失败时退出码/JUnit 保留、generated-wiki push 防循环、缺凭据时 pending 3/报告保留，以及有凭据后的真实 source update/内容 diff 分别留证。生成 updater 不自动 commit/push，发布内容按目标项目既有流程处理。
- 恢复：[本地 GitLab probe](development.md#local-gitlab-validation)只接受 loopback，**不要把远端 URL 填进它**。CI 超时或未知结果先按 pipeline/job/run ID 查询并保存 artifact；确认旧 job/writer 结束、原生 checkpoint 可恢复再重试，不复制旧 token 或为了跑通降低 protected branch 规则。

### E3：真实发布适配器

- [ ] 条件：实际 `customer.deployment` 的 adapter、target、authorizationReference、recoveryRunbook，以及可验证的既有发布命令和回滚/查询能力。
- 执行：按目标适配器 runbook 在获授权的验证环境执行真实 release/查询/失败恢复；Rigup 没有可用的通用发布器命令，不填写假适配器来消除 pending。
- 验收/恢复：每次副作用可在响应丢失后查询/对账，不重复发布；实际验证失败能回滚。没有目标时保留 pending，不进行任何生产发布。

### E4：人工语义审核与证据合入

- [ ] 读取实际预览与源证据；核对范围、反例、既有规范复用、原生 gate、用户修改和内容链接。执行通过、模型 acceptance 与人工语义批准分别记录。
- 将脱敏摘要、准确 SHA/版本、命令/退出码、通过断言、失败与恢复过程、费用/未知消费写入新的 `docs/compatibility/evidence/<日期>-<场景>/`；新增 README 索引，更新 `status.md` 的**具体场景**。不要覆写旧历史证据或仅凭本次安装成功就改全局 `live=true`。
- 合入前执行 `npm run check:docs`、`npm run test:package`、所改代码对应的测试和凭据扫描；提交推送后观察 CI。原始凭据、认证状态全文、private transport、browser auth snapshots 和 runner token 不提交。

## 官方参考与项目入口

安装与认证说明核对于 2026-11-05；官方网页会变化，实际版本的 `--help` 与记录同样需要保留。

- [Claude Code 安装/固定版本/Windows](https://code.claude.com/docs/en/setup)、[认证](https://code.claude.com/docs/en/authentication)、[CLI flags 与预算语义](https://code.claude.com/docs/en/cli-reference)。
- [Microsoft WSL 安装与版本检查](https://learn.microsoft.com/en-us/windows/wsl/install)、[PowerShell 安装](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows)、[Node.js 官方下载](https://nodejs.org/en/download)。
- [锁定 Superpowers 安装说明](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/README.md)、[锁定 OpenSpec 工具入口](https://github.com/Fission-AI/OpenSpec/blob/27c0515724decc633818c735ee596481eec78a8b/docs/supported-tools.md)、[锁定 Spec Kit 安装来源](https://github.com/github/spec-kit/blob/e0d414929552a4084d918babfd70d859f129eb13/README.md)。
- [开发与测试](development.md)、[使用与恢复](usage.md)、[当前验证范围](../compatibility/status.md)、[上游版本锁](../compatibility/upstream-lock.json)。
