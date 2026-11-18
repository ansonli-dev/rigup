# Issue 89 · 调用环境中的提供方凭据按需导入

[Issue #89](https://github.com/ansonli-dev/rigup/issues/89) · [总览 #85 P0-4](https://github.com/ansonli-dev/rigup/issues/85)

默认向导先安装基础工作流，由 Rigup MCP 处理待生成的规则。项目的 .rigup/.env 只有在用户明确选择 CLI 提供方并应用设置后，才可接收该提供方的调用环境输入。

## 在 51406c2 核实的行为

使用 Node 24.15.0、macOS arm64、临时 Git 项目和独立 HOME、缓存与状态目录。通过 runCli 的交互输入传入空行以选择真实默认值，使用合成密钥和 .example.test 地址。研究后端由测试替身接管。

| 操作 | 基线结果 |
| --- | --- |
| 全默认交互 init，只有 Anthropic key 和网关 | 退出 0，规则待生成，研究调用 0 次。写入 ANTHROPIC_API_KEY、RIGUP_BASE_URL 和 ANTHROPIC_BASE_URL。文件未被 Git 跟踪且有效忽略，文件为 0600、目录为 0755。默认只有文件已更新的通用提示，带 --verbose 才显示导入的变量名。 |
| 全默认交互 init，环境干净 | 退出 0，研究调用 0 次，.rigup/.env 不存在。有本机私有 provider.json 预设加对应的环境密钥时，当前默认向导也会复制该密钥。 |
| 已安装项目后来设置密钥，update --review 后 --apply | 审阅退出 3，项目尚无 .env。应用退出 0，同样复制了密钥，研究调用 0 次。环境干净时签发的旧预览也能在应用时复制后来加入的密钥。 |
| 环境轮换密钥后 update --review、doctor | 两者退出 3（规则待生成）。doctor 显示 project-file，文件仍是原值。 |
| OpenAI key 加 --model 的审阅与应用 | 审阅执行两次替身研究调用，应用写入密钥。现代流程的模型覆盖值未写入 .env。合成密钥未出现在本例扫描的六个私有 JSON/日志或 manifest 中。 |
| 显式选交互提供方，或旧 Host 续跑 | 提示中输入的隐藏凭据留在本轮内存。旧 Host 运行在初始环境干净时签发 --continue，续跑时加入提供方变量，基线随后应用会写入密钥。 |

projectRules: true 触发提供方输入声明，单个密钥也能推断一个缺少模型的提供方。effective() 给已填项目值优先级，其次使用解析得出的种子和调用环境。applyRuntimeInputs 将声明和值交给文件渲染，应用的所有分支都会重新取值。cli.ts 只在 verbose 时输出 runtime.imported。Windows 当前用户专用临时文件 ACL 来自源码核对。 [CLI 默认及提示](../../../src/cli.ts#L293) · [输入解析和写入](../../../src/runtime-inputs.ts#L83) · [私有写入](../../../src/runtime-private-env.ts#L146) · [提供方推断](../../../src/research/provider-settings.ts#L48)

test/runtime-provider.test.ts 已有非交互用例断言单个 key 会创建空模型占位，另有显式 --model、私有值优先和预览重放用例。回归用例须在 test/helpers.ts 的环境清理之后主动注入假密钥。 [现有测试](../../../test/runtime-provider.test.ts#L83) · [测试环境](../../../test/helpers.ts#L10)

## 设计与兼容

- 只提升提示解决可见性。进程内开关覆盖同次安装。把提供方类别和密钥变量名绑定到已批准计划，另一个进程可以按原选择应用，同时避免把当时的环境值写进批准记录。采用第三种。
- 新准备中，非空 CLI --model、调用进程中有效的 RIGUP_PROVIDER（anthropic 或 openai-compatible），或交互提示实际选中的提供方，才允许生成导入许可。提示选择「在智能体中使用 Rigup MCP」撤回本轮许可。新的默认向导继续延期研究。项目或 profile 的 model、旧 manifest、只设置模型或密钥变量、HOME 私有预设、从已有私有文件推断的默认值，都可参与既有解析和诊断，本身不授予导入许可。纯环境选择须与有效提供方匹配。
- 在已有的 SetupPlan 和续跑 Run.mode 增加可选的 providerEnvImport，内容仅为 {provider, apiKeyEnv}。同次安装、保存后应用以及中断恢复都由已批准的计划授权。--continue 使用原运行的许可。缺省字段代表提供方写入未授权，旧预览和续跑可按原有校验继续处理安装和其他输入。许可按次保存，后续新预览重新判断。
- 运行时读取仍可使用原有的私有项目值和已配置的默认值。文件的 needsUpdate 与实际可写声明一致。没有导入许可时，仅显式配置的其他本地消费者可以生成 .env；基础安装保持文件缺省，已有提供方条目得以保留。获准写入时，以保存的提供方和变量名补齐缺失的选择器，并在应用时解析当前值。若项目文件或调用环境明确指定了不同的提供方或密钥变量名，本次跳过提供方写入。非空项目条目逐字保留，空占位可以填入。现代 --model 仍作为本轮研究覆盖，隐藏输入凭据只用于本轮请求。
- 继续通过现有忽略、未跟踪检查和受保护的原子 writer 发布 .env。获准的计划应准备 .rigup/.gitignore，即使项目尚未 git init 或审阅时环境里没有值。批准、缓存、清单、终端、JSON 与预览详情日志只使用输入名、来源和状态。密钥和网关值留在运行时内存及受保护文件的写入路径。
- 成功写入的当前应用回执是人类提示的依据。中文为「已从调用环境导入 ANTHROPIC_API_KEY 到 .rigup/.env（git 已忽略）」，英文为 “Imported ANTHROPIC_API_KEY from the calling environment into .rigup/.env (git-ignored)”。实际使用获准的密钥变量名。默认和 verbose 各显示一次。JSON 继续用 runtimeSetup.template.imported 的名称和来源表示结果。密钥轮换沿用项目文件优先级。

## 验收

1. 在真实默认交互路径显式设置合成 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL，缺少 RIGUP_PROVIDER。安装完成且项目规则待生成，研究调用 0 次，.rigup/.env 为 ENOENT。独立检查无环境变量的对照，以及本机或项目模型预设与环境密钥并存的情况。
2. 明确设置 RIGUP_PROVIDER 的直接安装会复制获准的合成密钥，并显示变量名、目标和 Git 忽略提示。--model 单独配合一个支持的提供方密钥，以及选择现有交互提示中的提供方，都能形成许可。选择提示中的 MCP 默认项时保持 .env 缺省。
3. 从基础安装执行带显式选择的 update --review，再单独执行 update --apply。审阅后 .env 为 ENOENT。应用，即使省略审阅时的 RIGUP_PROVIDER，也会复制当前同名值并报告来源。改用另一个提供方或密钥变量名不会替换批准对象。无许可的审阅和应用在后续加入 selector 或密钥时仍保留缺省。
4. 已有非空项目密钥与注释保留。旧预览、旧 --continue 和中断安装恢复不能从新的调用环境取得许可。新许可跨保存的预览、续跑和 apply 恢复有效。重复应用已保留的项目值时没有新导入提示。
5. 人类默认和 verbose 的正例各有一次成功提示，JSON stdout 可直接解析。检查两个输出流、签名预览、运行/安装记录、详情日志和生成的清单及基线，排除合成凭据和网关值。保护失败时保留项目文件且不发成功提示，正常写入满足当前 Git 和文件私密权限检查。
