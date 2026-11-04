# Real GitHub project E2E

本轮对两个固定提交的公开项目执行真实打包 CLI 测试。结果分开记录：DDD 的 Rigup 主线通过；前端的完整语义流程因预算超限未通过，独立工具安装和业务浏览器测试通过。

- DDD：[Sairyss/domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon/tree/5c2d15a7e2d69e83dfddf28468ee9f30e02c30de)，123 个跟踪文件。真实 PostgreSQL 支持原有 7 项行为 E2E。
- 前端：[alan2207/bulletproof-react](https://github.com/alan2207/bulletproof-react/tree/9506629ed003a561c6627735480cce4994244bb4)，535 个跟踪文件。实际构建/应用测试选择 `apps/react-vite`，研究还包含根 AGENTS、README、docs 及 OpenSpec 入口。两个 Next.js 实现未进行应用验收。

实际 Rigup 源码先为 `8e0b9e1`；DDD 发现校验缺陷后使用 `bf8b7a1`。两次 npm 包摘要、完整提交、测试参数、工具版本、已解析顶层依赖见 [projects-lock.json](projects-lock.json)。模型为本机 Codex 当前默认，没有 `--model` 覆盖；CLI 未暴露服务端最终模型 ID，不作推断。

## 已执行的入口

先在隔离消费目录安装本仓库 `npm pack` 生成的包，保持真实 CLI 和真实 Codex 后端。每个项目使用独立私有 HOME/状态/缓存；Codex 通过原来的 CODEX_HOME 使用已有登录，不复制凭据。官方 OpenSpec 1.16.0 对项目执行 `init --tools codex --profile core --no-animation --no-copilot-cloud`。

项目测试配置为 agents=codex、backend=codex、sdd=openspec、executionPolicy.mode=review，两工具均 install=true，其中 OpenWiki initialize=false、CodeGraph initialize=true。每个项目在开始前配置 maxCalls=12、maxTokens=1200000、readBudget.maxFiles=4000、readBudget.maxBytes=24000000。该预算不同于小 fixture 的专用预算，不能混为同一轮。

对临时克隆执行下列实际命令，previewId 来自上一阶段真实 JSON 报告：

```sh
rigup init /path/to/clone --json
rigup update /path/to/clone --apply PREVIEW_ID --sessions-ended --json
rigup update /path/to/clone --dry-run --sessions-ended --json
rigup update /path/to/clone --apply UNCHANGED_PREVIEW_ID --sessions-ended --json
rigup doctor /path/to/clone --json
```

DDD 另在已安装的 deliver reference 添加用户说明，再运行 dry-run 验证保留且无新模型消费。两个项目均通过实际 CodeGraph CLI 查询源码符号；脚手架完成后没有创建 OpenWiki run/目录。OpenWiki 的长流程始终留给用户独立初始化。

前端的完整语义命令在最终验收时返回 1，没有进行语义安装。其后**另一个独立状态目录**的工具验证在每次 init/update 明确加 `--sdd none`；这是无模型、无完整 SDD 语义生成的单独场景，不把它当作先前失败的恢复或通过。

## 应用环境与检查

DDD 使用临时 Yarn 1.22.22 安装 unchanged package.json。上游无锁文件，npm 会因 `@slonik/migrator` 与 Slonik 的 peer 范围冲突失败；新解析的 `@types/minimatch@6` 为空 stub，临时 node_modules 中改用 5.1.2 后原构建通过。未修改上游跟踪文件。

测试数据库使用官方镜像 `postgres@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab`（实际 PostgreSQL 16.15），专用 `--rm` 容器，只发布到回环随机端口。上游两个 URI 构造函数忽略 DB_PORT，因此迁移/测试进程用 DB_HOST 的 `127.0.0.1:port` 形式；所有凭据均为仓库公开测试 fixture 值。

```sh
npm run build
NODE_ENV=test DB_HOST=127.0.0.1:PORT npm run migration:up:tests
NODE_ENV=test DB_HOST=127.0.0.1:PORT DB_PORT=PORT npm run test:e2e -- --json --outputFile=REPORT
```

前端在 `apps/react-vite` 按已有 yarn.lock 执行 frozen install，禁用生命周期脚本，不运行根 prepare。构建、Vitest 在安装前后执行；浏览器执行仓库原有的 auth.setup/profile/smoke，没有修改原测试或业务代码。项目外的 runner 配置仅设置本地 baseURL、WebServer 命令、worker、报告路径和 storageState 绝对路径；使用仓库自带 Express/MSW API。

```sh
npm run build
CI=1 VITE_APP_API_URL=http://localhost:8080 npm test -- --run --maxWorkers=2 --minWorkers=1 --reporter=json --outputFile=REPORT
node_modules/.bin/vite-node mock-server.ts
CI=1 PLAYWRIGHT_BROWSERS_PATH=PRIVATE_BROWSER_PATH node_modules/.bin/playwright test --config EXTERNAL_RUNNER_CONFIG
```

环境变量配置和明确的用例范围见 [application-checks.json](application-checks.json)。测试服务已停止，临时克隆/依赖和私有原始模型结果留在汇总记录的 workspace 供复核，没有复制登录文件。

## 结果与限制

- [DDD 流程](ddd-e2e.json)：2 次真实请求、400874 token；独立 apply、无变化 apply、用户说明保护、实际索引和原文件保护通过。原始 README 已足够时复用，不为了覆盖而强造正文任务。
- [前端完整语义失败](frontend-semantic-failure.json)：4 请求、1564127 token，超过预设 1200000；最终验收未导入。模型的 accepted=true 自述不代替预算和程序验收。失败后未重发前端模型请求。
- [前端独立工具流程](frontend-tools-e2e.json)：真实安装/索引/接线及无变化 apply 通过，modelCalls=0，明确为 sdd none。
- [DDD 原生 MCP](ddd-native-mcp.json) / [前端原生 MCP](frontend-native-mcp.json)：真实 Codex App Server 发现两工具，并实际调用 CodeGraph explore 读取业务源码；没有 turn/start 或模型调用，也没有触发 OpenWiki begin。
- [应用检查](application-checks.json)：DDD 安装前后构建和 7/7 行为 E2E；前端安装前后构建和 21/21 Vitest，以及真实 Chromium 3/3 浏览器测试（含登录准备）。[浏览器原始 JSON](frontend-browser-e2e.json)。
- [来源抽核](source-audit.json)：123/535 个原跟踪文件和各 6 个原生 OpenSpec skill 字节不变；原未决文档冲突未被裁定为强制规范。抽核者为实现 agent，不冒充人工批准。
- [本地回归日志](local-regressions.txt)：305 总数、292 passed、13 opt-in live skipped、0 failed。校验缺陷的 [RED](validator-red.txt) / [GREEN](validator-green.txt) 同时保留；建议标为 needs-decision 可以被保留，follow-existing 仍被拒绝。

前端每个阶段的 178 文件正文共 853449 字符，其中 yarn.lock 占 501391 字符。完整锁文件在四阶段重复是已观察到的上下文负担；按阶段收缩证据尚未实现。本次没有靠改响应、丢弃失败用量、悄悄增加预算或 mock 成功结果来宣布完整通过。
