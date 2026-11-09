# Claude Code 与 Windows 验证交接

Claude 先跑 C1、C2，再按需要跑 C3 或 C4。Windows 分别记录 WSL2（W1）和原生 Windows（W2）。当前结果与外部条件见[验证状态](../compatibility/status.md)。

每个场景使用仓库外的私有目录，记录 Rigup SHA、OS/架构、文件系统、Node/宿主/SDD 版本、命令、退出码和报告。每次尝试另存日志和费用。`--max-budget-usd` 是 Claude 单次客户端估算额度，跨重试的总额度单独登记。未知消费先对账。认证状态和原始模型交换留在本机，只提交脱敏结果。[Claude CLI 预算](https://code.claude.com/docs/en/cli-reference) · [安全报告](../../SECURITY.md)

## C1 · 源码环境与 Claude 连通性

在 macOS 或 Linux 准备 Node.js 24.x、npm、Git、C 编译器和 `ps`，以及可用的 Claude 账号或组织提供商。Node 24.x 也满足锁定 CodeGraph 的运行时要求。按实际版本记录场景。[开发环境](development.md) · [上游锁](../compatibility/upstream-lock.json)

在同一 Bash 或 Zsh 会话执行。记下 `CASE_ROOT`，重开终端后可恢复路径。

```sh
set -e
umask 077
CASE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/rigup-handoff-XXXXXX")
CASE_ROOT=$(cd "$CASE_ROOT" && pwd -P)
EVIDENCE="$CASE_ROOT/evidence"
RIGUP_SOURCE="$CASE_ROOT/source"
RIGUP_CLI="$RIGUP_SOURCE/dist/cli.js"
mkdir "$EVIDENCE"
printf '%s\n' "$CASE_ROOT"
git clone --config core.autocrlf=false https://github.com/ansonli-dev/rigup.git "$RIGUP_SOURCE"
cd "$RIGUP_SOURCE"
git rev-parse HEAD > "$EVIDENCE/rigup-commit.txt"
node -p 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})' > "$EVIDENCE/runtime.json"
node -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1)'
command -v cc ps
npm ci > "$EVIDENCE/npm-ci.log" 2>&1
npm run check > "$EVIDENCE/default-check.log" 2>&1
set +e
```

默认检查通过后再开启 live。使用 Claude Code 最新发布版，记录实测版本并在同一批场景中固定。可沿用本机已有登录。专用 `CLAUDE_CONFIG_DIR` 需要单独认证。[Claude 安装](https://code.claude.com/docs/en/setup) · [认证](https://code.claude.com/docs/en/authentication)

```sh
claude update
export DISABLE_AUTOUPDATER=1 # 验证结束后取消
claude --version
claude --help > "$EVIDENCE/claude-help.txt"
claude auth login
claude auth status > "$EVIDENCE/claude-auth-private.json"
```

在私有目录发一条无工具请求。先核对本机版本的 `--help` 和组织权限设置。

```sh
cd "$CASE_ROOT"
CLAUDE_PROBE_FLAGS=(
  --tools '' --setting-sources user --settings '{"disableAllHooks":true}'
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --permission-mode dontAsk --permission-prompts none
  --no-session-persistence --no-chrome --output-format json
)
claude --print 'Reply with exactly RIGUP_CLAUDE_AUTH_OK.' \
  "${CLAUDE_PROBE_FLAGS[@]}" --max-budget-usd 0.25 \
  > "$EVIDENCE/claude-model-private.json" 2> "$EVIDENCE/claude-model.stderr.log"
```

退出 0、无 `is_error` 且 `result` 为 `RIGUP_CLAUDE_AUTH_OK` 才继续。记录实际模型和费用。若返回 401，保留 transport 和 stderr，核对账号额度、组织策略、网络和认证方式。修复后在新 attempt 目录重试。验证结束可取消本终端的 `DISABLE_AUTOUPDATER`。

## C2 · Claude skill 与客户 MCP

此探针只安装确定性 canary，单次 Claude 请求使用 `$1` 估算额度。运行指定测试名。[探针实现](https://github.com/ansonli-dev/rigup/blob/main/test/live-support.ts)

```sh
cd "$RIGUP_SOURCE"
RIGUP_LIVE=1 RIGUP_LIVE_EVIDENCE_DIR="$EVIDENCE/claude-native-attempt-01" \
  node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='^live Claude native prerequisites$' test/live-compatibility.test.ts \
  > "$EVIDENCE/claude-native-attempt-01.log" 2>&1

node --input-type=module - "$EVIDENCE/claude-native-attempt-01/claude-none-customer-mcp.json" <<'JS'
import {readFileSync} from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'passed' || report.exit !== 0 || !report.loadedReferenceMarker ||
    !report.mcpConnected || !report.echoCalled) throw Error('Claude probe incomplete');
JS
```

探针进程须退出 0，报告须通过上述断言。核对 `RIGUP_REFERENCE_LOADED_20261104` 以及 MCP `initialize`、`tools/list` 和实际 `rigup_echo` 调用。缺条件可能被记为 `pending` 并跳过。失败时先保留报告中的 fixture、控制目录、trace 和账本，核实本次 MCP 子进程已退出。再次运行使用新 attempt 和 fixture，并计入实际费用。

## C3 · Claude 与 OpenSpec 原生流程

`--agents claude` 选择安装目标。以下私有请求交接保留为 v0.2.4 兼容场景。验证 v0.3.0 的新入口时先应用 `rigup init --defer-research --review` 的基础预览，再从已登录的宿主调用 `rigup_begin` 并按同一任务账本记录费用。CLI provider 使用独立凭据。[研究入口](usage.md#研究后端与预算)

原生 Windows 使用 `rigup init --agents claude --sdd openspec --defer-research --prepare-openspec` 准备 OpenSpec。下面的 `npm install --prefix` 示例适用于 macOS 和 Linux。

验证 Spec Kit 时，用 `specify init --here --integration claude` 准备原生技能，核对 `speckit-constitution` 和 `speckit-specify` 等入口。验证 Superpowers 时，记录插件版本和 Rigup 预览中报告的版本冲突。

```sh
cd "$RIGUP_SOURCE"
npm install --prefix "$CASE_ROOT/openspec-tool" --ignore-scripts --no-audit --no-fund @fission-ai/openspec@1.16.0
OPENSPEC_BIN="$CASE_ROOT/openspec-tool/node_modules/.bin/openspec"
"$OPENSPEC_BIN" --version
PROJECT="$CASE_ROOT/claude-openspec-project"
cp -R test/fixtures/live/service "$PROJECT"
git -C "$PROJECT" -c init.templateDir= init -q
"$OPENSPEC_BIN" init --tools claude --profile core --no-animation --no-copilot-cloud "$PROJECT"
git -C "$PROJECT" add .
git -C "$PROJECT" -c user.name='Rigup Verification' -c user.email='fixture@example.org' commit -m 'Record fixture baseline'

cat > "$CASE_ROOT/claude-host.yaml" <<'YAML'
agents: [claude]
backend: host
sdd: openspec
executionPolicy: {mode: review}
researchBudget: {maxCalls: 12, maxTokens: 300000}
scope: [README.md, package.json, docs, src, openspec, .claude]
YAML
node "$RIGUP_CLI" init "$PROJECT" --profile "$CASE_ROOT/claude-host.yaml" --review --json \
  > "$EVIDENCE/claude-host-01.json"
```

确认 OpenSpec 1.16.0 生成了 `.claude/skills/openspec-*` 与 `.claude/commands/opsx/`。退出 3 且报告给出 `requestPath` 时，按该轮 `instructions` 准备响应。初始研究的 `context.kind` 为 `analyze`，后续产物阶段再看 `context.expectedOutput`。`REQUEST_FILE` 取 `requestPath`，`RESPONSE_FILE` 取 `nextCommand` 中 `--response` 的值。每轮更换 `STEP`，只发送导出的证据，保留 unknowns 和准确引用。

```sh
cd "$PROJECT"
STEP=01
claude --print 'Follow the exported Rigup request on stdin. Use only its supplied evidence. Return the requested data JSON without an envelope or Markdown fences.' \
  "${CLAUDE_PROBE_FLAGS[@]}" --max-budget-usd 1 \
  < "$REQUEST_FILE" > "$EVIDENCE/claude-host-$STEP.transport.json" \
  2> "$EVIDENCE/claude-host-$STEP.stderr.log"
```

Claude 退出 0 后，把实际模型输出放入请求信封。

```sh
node --input-type=module - "$REQUEST_FILE" "$EVIDENCE/claude-host-$STEP.transport.json" "$RESPONSE_FILE" <<'JS'
import {readFileSync, writeFileSync} from 'node:fs';
const [requestFile, transportFile, responseFile] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestFile, 'utf8'));
const transport = JSON.parse(readFileSync(transportFile, 'utf8'));
const model = Object.keys(transport.modelUsage ?? {}).join(',');
if (transport.is_error || !model || typeof transport.result !== 'string') throw Error('Inspect the original transport');
const data = JSON.parse(transport.result);
writeFileSync(responseFile, JSON.stringify({requestId: request.requestId, requestDigest: request.requestDigest, model, data}), {flag: 'wx', mode: 0o600});
JS
```

执行实际 `nextCommand`。使用源码 CLI 时，将开头的 `rigup` 替换为 `node "$RIGUP_CLI"`，沿用报告中的续跑参数。遇到无效响应保留原数据与费用，按本轮协议处理。Host 用量在 Rigup 报告中为 unknown，使用单独账本对账。

拿到 `previewId` 后审阅变更，结束受影响的 Claude 会话，再独立 apply。重载后验证实际 `change-prepare` 和 `change-deliver` 读取项目 references 与 OpenSpec 入口。分别记录缺少原生 gate 时停止、补齐后推进、审查时使用原项目依据。检查无变化更新、用户修改和原始文件基线，最后执行 `node "$RIGUP_CLI" doctor "$PROJECT" --json`。生成内容另做人工审核。绑定过期时保留原请求和账本，重新预览。

## C4 · Claude 与 OpenWiki、CodeGraph

```sh
PROJECT="$CASE_ROOT/claude-tools-project"
cp -R "$RIGUP_SOURCE/test/fixtures/live/service" "$PROJECT"
git -C "$PROJECT" -c init.templateDir= init -q
node "$RIGUP_CLI" init "$PROJECT" --agents claude --sdd none --tools openwiki,codegraph --review --json
```

按实际预览交接并 apply，重载 Claude 后确认两个 MCP 实际连接。分别核对软件回执、CodeGraph 初始化和业务符号查询。已有用户索引应保留。OpenWiki 此处验收 MCP 和交接，后续独立发起 `openwiki_begin` 的 `mode=init`，用原生 checkpoint 恢复。中断测试仅在独立 fixture 内验证可追踪 writer 和 staging。现有自动恢复探针的宿主是 Codex，Claude 结果在本场景单独留证。[初始化探针](https://github.com/ansonli-dev/rigup/blob/main/test/live-native-initialization.test.ts)

## W1 · WSL2

在支持 WSL2 的 Windows 上用管理员 PowerShell 安装 Ubuntu，按提示重启并建用户。记录 Windows build、发行版和 WSL 版本。[Microsoft WSL 安装](https://learn.microsoft.com/en-us/windows/wsl/install)

```powershell
wsl --install -d Ubuntu
wsl --list --verbose
wsl --distribution Ubuntu
```

确认 `VERSION` 为 2。在 Ubuntu 内准备 Git、POSIX 工具和证书。Release 需要 glibc 2.35 或更高。

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates procps build-essential
getconf GNU_LIBC_VERSION
uname -a
```

先用 Linux 便携包验证 `rigup --version` 和项目根目录 `rigup init` 的 dry-run。[便携包安装](releases.md)

做源码或 Claude 验证时，在 Linux home 下安装 Linux Node 24.x 和 Claude，使用 WSL 内独立登录，执行 C1、C2 及选定场景。核对 `process.platform=linux`、二进制位置、重载与进程恢复。空格/中文路径和 `/mnt/c` 分开测试。失败先核实 PATH、挂载类型、证书和 `ps`，保留原场景后再开 Linux home fixture。[Node.js 下载](https://nodejs.org/en/download)

## W2 · 原生 Windows

用 PowerShell 7、Windows Node.js 24.x 和 Git for Windows，在 NTFS 私有目录做源码探针。记录 Windows build 与架构。POSIX `ps`、进程组、mode/ACL 和 shell hooks 是当前平台移植验证点。CLI help 与 installer 验收分开记录。[PowerShell 安装](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows)

```powershell
$CaseRoot = Join-Path $env:USERPROFILE ('.rigup-validation\' + [guid]::NewGuid())
$Evidence = Join-Path $CaseRoot 'evidence'
$Source = Join-Path $CaseRoot 'source'
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
icacls.exe $Evidence

git.exe clone --config core.autocrlf=false https://github.com/ansonli-dev/rigup.git $Source
if ($LASTEXITCODE) { throw 'git clone failed' }
Set-Location $Source
git.exe rev-parse HEAD | Set-Content (Join-Path $Evidence 'rigup-commit.txt')
node.exe -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1)'
if ($LASTEXITCODE) { throw 'Node.js 24.x required' }
node.exe -p 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})' |
  Set-Content (Join-Path $Evidence 'runtime.json')
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber |
  ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows.json')
npm.cmd ci *> (Join-Path $Evidence 'npm-ci.log')
if ($LASTEXITCODE) { throw 'npm ci failed' }
npm.cmd run build *> (Join-Path $Evidence 'build.log')
if ($LASTEXITCODE) { throw 'build failed' }
node.exe .\dist\cli.js --help
if ($LASTEXITCODE) { throw 'CLI help failed' }
npm.cmd run check *> (Join-Path $Evidence 'check.log')
$CheckExit = $LASTEXITCODE
$CheckExit | Set-Content (Join-Path $Evidence 'check-exit.txt')
if ($CheckExit) { throw 'Full check failed. Inspect the retained logs before continuing.' }
```

记录包安装、资产独立运行、空格/中文路径、盘符与换行、文件权限/链接、预览保护和中断恢复。优先定位第一个原生阻塞。用 `Get-CimInstance Win32_Process` 或 `Get-Process -Id` 核实本次进程身份，确认后再处理该进程树。

无模型生命周期可用后，更新到最新 Claude Code 并本机登录。执行 C2 的同名测试和报告断言。探针也需验证超时终止及 MCP 清理，分别记录 Claude 登录、安装和真实连接。[Claude Windows 安装](https://code.claude.com/docs/en/setup#install-on-native-windows)

```powershell
claude update
claude --version
claude auth login
claude auth status > (Join-Path $Evidence 'claude-auth-private.json')
$env:RIGUP_LIVE = '1'
$env:RIGUP_LIVE_EVIDENCE_DIR = Join-Path $Evidence 'claude-native-attempt-01'
try {
  node.exe --import tsx --test --test-concurrency=1 '--test-name-pattern=^live Claude native prerequisites$' .\test\live-compatibility.test.ts `
    *> (Join-Path $Evidence 'claude-native-attempt-01.log')
  if ($LASTEXITCODE) { throw 'Claude probe failed' }
  $Report = Get-Content -Raw (Join-Path $env:RIGUP_LIVE_EVIDENCE_DIR 'claude-none-customer-mcp.json') | ConvertFrom-Json
  if ($Report.status -ne 'passed' -or $Report.exit -ne 0 -or -not $Report.loadedReferenceMarker -or
      -not $Report.mcpConnected -or -not $Report.echoCalled) { throw 'Claude probe incomplete' }
} finally {
  Remove-Item Env:RIGUP_LIVE, Env:RIGUP_LIVE_EVIDENCE_DIR
}
```

### W2 实测要点

- Rigup 状态目录和缓存依赖私有 NTFS 权限。隔离 HOME 放在 `%USERPROFILE%` 下的私有子目录，并让测试进程的 `USERPROFILE` 与 `HOME` 指向同一位置。域机器的 `%LOCALAPPDATA%` 或盘符根可能继承额外的访问授权。
- 自动化调用 `claude --print` 时，将完整请求通过 stdin 传入并关闭管道。只通过参数传提示词时也要关闭 stdin。host 研究请求中的 `guidance[].scope`、`consumers` 和 `gaps` 使用字符串数组。
- 超时后核对本次探针的进程标识，用 `taskkill /T /F /PID` 清理仍运行的进程树。另行检查 CodeGraph `serve --mcp` 是否在 Claude 退出后仍在运行。
- Windows GitLab Runner 使用 Git for Windows 的 Bash 时，`builds_dir` 和 `cache_dir` 使用相对路径。Docker Desktop 中的 GitLab 使用与容器发布端口一致的 `external_url`。Windows x64 实测覆盖 CI lint、成功和失败时的 JUnit 产物、wiki 递归守卫和缺少变量时的失败提示。
- WSL 非登录 shell 如果找不到 `~/.local/bin` 中的 Claude，用 `bash -lc` 加载登录环境。MCP 名称冲突时，核对用户级和项目级的注册。通过网关运行时，将 CLI 成本估算和网关账单分开记录。续跑同一会话使用最后一次累计值。

## 恢复与留证

- 保留 `.rigup/`、原生 staging、`~/.cache/rigup/` 和 `~/.local/state/rigup/`。核实本次 controller 和 writer 已退出，在相同 OS、项目路径和配置下按报告续跑。先处理确切的 `--continue` 请求，已批准安装中断用 `rigup update --resume --review --json`。参见[应用与恢复](usage.md#应用与恢复)。
- 未确认的结果记 `pending`，可复现失败记 `failed`。报告记录原始错误、进程和恢复结果。重试使用新 attempt，费用继续累计。OpenWiki 内容生成使用自身 checkpoint。
- 其他宿主选用 `test/live-compatibility.test.ts` 中对应的单个场景。目标 GitLab 需要独立 runner、权限、模型和真实 source push，先核对 include 与报告。[本地 GitLab 探针](development.md#local-gitlab-validation)
- 将脱敏摘要、精确 SHA、实测断言和剩余条件存入 `docs/compatibility/evidence/`，只更新通过的场景。运行 `npm run check` 后提交证据。客户发布验收需要已授权的部署适配器、目标与回滚流程。
