# Issue 87 · 统一 init / update 的结果和下一步

基线 `51406c25a348937ca0487aacde5bd4a3e691729c`（Rigup v0.10.0）。本轮交付设计和计划，进入实现前由控制方独立评审。 [Issue #87](https://github.com/ansonli-dev/rigup/issues/87)

## 基线核实

用 Node 24.15.0、macOS arm64，从指定 worktree 直接运行 `runCli`。项目、HOME、PATH 夹具、缓存和写入状态均在临时目录。Claude 使用注入的 launcher 回调，OpenSpec 使用只响应版本和项目状态的本地程序，两组探针均记录零次 fetch。

| 场景 | 在 `51406c2` 的结果 |
| --- | --- |
| 中文 `init --agents claude --sdd none --defer-research --review` | 退出 3。预览可应用，ID 含 64 个十六进制字符，空项目仍为空。显示「需要处理」和「原因: 应用已保存的预览」。JSON 是 `phase: handoff`、`installStatus: pending`、`executable: true`、`pending: ["Apply the saved preview"]` 和绝对路径 `nextCommand`。 |
| 在模拟活动会话中应用该预览，随后无参 `update` | 应用退出 0，重载提示出现在「安装…」之前，下一步直接写 `rigup_begin`。无参更新退出 3，`phase: research`，原因和下一步逐字相同。 |
| 缺 OpenSpec 项目根和 Codex 入口 | 退出 3，普通初始化把两条带绝对路径的命令串成 `&&`。走 `--backend codex --dry-run` 的生命周期前置分支只给准备命令。两条路径均未写项目。 |
| 非 TTY 选 Claude + Superpowers，launcher 可用，原生入口缺失 | 退出 3，`phase: preview`，先列夹具的 10 个文件，再出现英文 `missing native entry` 和准备命令。非 TTY 直接运行 `--prepare-native` 也先展示计划，后提示需要终端批准。 |
| Claude 的两次原生批准后，在「可选工具」取消 | 退出 130，Git 显示 `?? .claude/`，`.claude/settings.json` 包含市场声明及插件启用项，隔离 HOME 有插件缓存，Rigup manifest 不存在。原生步骤中已显示观测路径和卸载指令，结果页仍写「项目没有写入任何内容」。只批准市场、取消第二次批准时同样留下项目设置，尚无安装回执。 |

保存预览的 `handoff` 和裸更新的待调研摘要都复用了通用退出码 3 的终态。结果页先渲染原因再决定下一步，因而无法去重。四处重载提示都在写入前发出。向导的原生成功回调把 `nativePreparation` 暂存在等待下一份生命周期报告的闭包里，取消可选工具使这份报告从未产生。原生执行器已经在每个写入步骤前后观测声明目标，`NativeProgress.changes` 混有项目和宿主路径，`step` 本身只证明流程经过该步。 [生命周期](../../../src/lifecycle.ts) · [CLI 编排](../../../src/cli.ts) · [结果页](../../../src/cli-output.ts) · [原生准备](../../../src/integrations/host-setup/index.ts)

## 方案与兼容性

选择在输出层使用现有报告加少量显示状态。只改译文无法识别中断预览和向导已经写入的文件。把显示字段加进报告或新建写入日志会扩大接口和存储改动。所选方案延用当前报告和原生写入观测。

- 保持各分支的退出码和现有 `--json` 字段及含义，包括 `pending`、`researchNextStep`、`nextCommand`、`resumeCommand` 及 `nativePreparation.progress` 的内容和出现条件。保留机器命令的绝对路径、连接方式与批准参数。终端文案双语，使用现有 shell 引用和终端转义。
- 保持预览身份、审批、加锁、写入验证、部分写入和中断恢复语义。实现和验证使用 Node 24、隔离 HOME、离线夹具及现有依赖。真实宿主、模型、注册表及发布操作排除在本轮工作之外。

### 预览、待调研和重载

- 新生成、可执行并保存的 `handoff` 退出 3，标题为「预览已生成，尚未安装」 / “Preview generated, not yet installed”。省略原因，只呈现一次带完整 ID 的 `rigup update … --apply <id>`。成功 `--dry-run` 可用同一标题并退出 0，遵循当前只预览的下一步行为。冲突、宿主响应、未满足先决条件及恢复中的受保护预览使用真实状态。恢复预览使用单独的显示标记，保留原批准的恢复命令，并提示可能已有部分写入。标题中的安装指本次 Rigup 预览。
- 去重在决定最终人类可见的原因和下一步之后进行。按去除首尾空白、翻译和终端转义后的文本比较，完全相同则保留下一步。真正的阻塞说明、来源复审和恢复命令继续按原优先级呈现。
- 基础安装后的下一步示例为「在所选智能体中打开项目，确认已启用 Rigup MCP，然后说『请为当前项目生成 Rigup 规则』。」裸更新仍待调研时只显示一次这类说明，附 CLI provider + `--review` 选项。机器报告和 MCP 继续用现有工具名。
- 成功完成的 Rigup apply（含检查要求关注的已提交安装）、验证就绪的 OpenSpec 准备或本次验证成功的原生 install/link 才产生重载资格。保留活动会话判断和受支持的 `--sessions-ended` 行为。有终态时把提示放在结果之后，合并同一次命令里的原生和 Rigup 提示。无 CLI 展示器的生命周期调用在 apply 完成后提示，JSON 模式现有的重载提示通向 stderr。

### OpenSpec 和非 TTY 原生门槛

- 用 `OpenSpecInspection.steps` 的原始数组与单独构造的继续命令，在终端先显示准备、再显示继续，每步一条命令。项目位置以解析后的调用目录为基准，等于项目时省略，其他目录用 shell 引用的相对路径。跨卷时使用可执行的绝对路径。项目名可以包含空格、单引号或 `&&`。需要设 PATH 时保留现有前置命令顺序；原先只有受保护恢复命令时仍按原批准恢复。例子在项目根目录内。

  ```text
  下一步
    1. rigup init --agents codex --sdd openspec --prepare-openspec --install-scope project
    2. rigup init --agents codex --sdd openspec --defer-research
  ```

- 非 TTY（包括输出重定向）遇到可用的 Superpowers 原生准备命令，优先显示本地化缺项、交互终端要求及一条可复制命令；默认输出省略计划文件清单，`--verbose` 在指导后显示细节。普通 init/update 仍生成当前机器报告和私有预览。缺 launcher、禁用插件等真实手动阻塞保留对应诊断和修复入口。独立 `--prepare-native` 缺终端批准时也把可操作提示置于详细计划之前。显式 `--review` / `--dry-run` 仍是原生只读检查，交互批准维持现有细节。

### 原生写入与取消

- 在原生准备的现有步骤前后观测处提取本次已观测的项目路径、无法核实的项目路径和已验证的重载资格。以步骤声明的 `level: project` 为边界，排除宿主缓存、配置和私有状态。通过 `nativeSetupInteraction` 的显示回调交给 CLI，向导返回上一页或后续停止也保留已经观测到的写入。
- 取消后按项目相对路径去重。在 `.claude/settings.json` 下列出现有的项目级卸载命令 `claude plugin uninstall superpowers@claude-plugins-official --scope project --keep-data`，限本次已验证安装并提示在该项目运行。市场步骤确实新增声明时，另给出仅移除 `extraKnownMarketplaces["claude-plugins-official"]` 的编辑指引。市场步骤没有已由仓库验证的项目级撤销命令；取消于两次批准之间使用上述按键编辑，保留已有设置和共享缓存。Rigup 只显示操作，取消流程不执行回滚。 [现有原生恢复说明](../../guides/usage.md)
- 观测不可用或写入进程终止未证实，显示待核对的路径和可能部分写入。仅配置或缓存等项目外变化时，项目零写入说明仍成立。Rigup apply 的部分写入和恢复报告继续出自现有交易状态。

## 验收与协作

1. 显式 review 和 TTY 保存的退出 3 断言保留，并断言无 Needs action / 需要处理、无误导原因、只有一条可应用命令。正常 dry-run 退出 0。真实冲突和恢复路径保留诊断与退出码。
2. 已安装且规则待调研的无参 update 退出 3，用户下一步只出现一次。安装和 update 的人类提示中没有 `rigup_begin`，对应机器报告仍可照旧消费。活动会话的重载提示在成功安装之后，应用取消或失败未提交时省略。
3. OpenSpec 普通引导和生命周期前置分支均按顺序显示准备和继续，保留项目参数、scope 和选择。覆盖同目录、含 shell 特殊字符的相对路径，以及既有机器命令的兼容性。
4. 非 TTY Superpowers 保持退出 3、零批准与零项目写入。紧凑指导在文件清单之前，仅 verbose 输出详细清单。手动阻塞仍给出原恢复入口。
5. 批准 Claude 安装后取消退出 130，最终结果下列出 `.claude/settings.json` 和项目卸载命令。另覆盖未批准、只增市场声明、原设置已有无关字段、项目外变化和项目效果无法核实。取消前后对照项目字节和报告，确认终端说明符合现场。

#87 拥有以上结果与下一步。#88 拥有原生计划、进度与诊断文本，接入同一原生执行结果并协调去掉过程中的重载副句；#84 的子进程捕获继续由其边界负责。#85 拥有通用预览摘要、阶段、doctor、帮助及代表性整屏快照，#87 用定向断言覆盖自身条件和顺序。共享修改点是 `cli.ts`、`cli-output.ts`、双语字典、`host-setup/index.ts` 及 CLI 测试。

[实现计划](../plans/2026-11-19-issue-87.md)
