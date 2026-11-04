# mattpocock/skills：项目初始化流程研究

研究日期：2026-11-03。对象：[mattpocock/skills](https://github.com/mattpocock/skills)。
本次 main 快照：`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`，提交时间 2026-10-31；下文使用该提交永久链接。
方法：通过 GitHub connector 读取 README、setup skill 及其五份模板；未安装、运行 skills，也未执行源码中的 Git/远端操作。
关联：[CLI 交互设计](../superpowers/specs/2026-11-03-cli-interaction-design.md)。

## 1. 两个不同的初始化层次

README 先让用户获取 skills，再在每个项目中运行一次 `setup-matt-pocock-skills`。获取方式包括宿主插件和 `npx skills@latest add mattpocock/skills`；后者是外部安装工具，不是本仓库自己的 CLI。安装器可选 skills 和 agent，项目 setup 则配置工作约定。[README](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/README.md#installation-30-second-setup)

README 区分插件自动更新与复制到项目的可编辑文件，并提醒同一 agent 选一种渠道，避免重复安装。这是该仓库安装说明，不是我们已验收的兼容能力。[README](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/README.md#installation-30-second-setup)

setup 本身明确是由 prompt 驱动的 skill，并非确定性安装脚本；描述为用户主动调用，配置 tracker、triage 标签及领域文档的消费规则。[SKILL.md](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L1-L15)

## 2. 交互顺序：先发现，只问未决事项

实际主线是：探索仓库 → 总结发现 → 分章节给推荐值并提问 → 展示草稿供修改确认 → 写入 → 告知后续消费方式。[流程](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L17-L120)

探索覆盖远端、根入口文档、已有 Agent skills 块、glossary/旧名称、ADR、既有 docs/agents、local tracker 痕迹、triage 是否安装，以及 monorepo 信号。[Explore](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L19-L30)

提问按章节逐一进行，每节先给推荐答案；已经由探索确定或不适用的章节跳过，不要求用户把所有问题重新回答一遍。[提问规则](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L32-L36)

三个业务章节：

- **Tracker**：根据 Git remote 推荐 GitHub/GitLab，也支持本地 Markdown；其他系统记录用户描述，不要求通用插件协议。[Section A](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L38-L51)
- **Labels**：仅已安装 triage 时询问是否保留默认标签；否则不提问，也不生成对应配置。[Section B](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L53-L59)
- **Domain docs**：默认单上下文；仅发现 monorepo 信号才询问多上下文布局。[Section C](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L61-L63)

## 3. 输出：项目约定与入口引用

确认前展示入口新增块，以及 issue-tracker、domain 和条件生成的 triage-labels 正文，让用户修改后再写。[Confirm](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L65-L72)

入口优先编辑已有 CLAUDE.md，否则编辑已有 AGENTS.md；都不存在才询问创建哪一个。已有 Agent skills 块原位更新，保护周边用户正文。[Write](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L74-L104)

实际文件职责：

- `docs/agents/issue-tracker.md` 说明在哪跟踪、如何读写工单；GitHub/GitLab 模板记录各自命令及关联语义。[GitHub 模板](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md)、[GitLab 模板](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/issue-tracker-gitlab.md)
- 本地模板使用 `.scratch/<feature>/spec.md` 及逐条 ticket 文件，也包含其框架特有的进度/阻塞表达；不能只把它理解为随意保存几份文档。[Local 模板](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md)
- `triage-labels.md` 把五个固定角色映射到项目标签，避免依赖项目必须采用同一命名。[标签模板](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/triage-labels.md)
- `domain.md` 规定如何读取 glossary/ADR、使用领域术语和报告 ADR 冲突；这些文件不存在时继续工作，由后续研发按实际问题逐步建立，不在 setup 填充空壳。[Domain 模板](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/domain.md)

完成后解释哪些 skills 会读取上述文件；用户可直接维护项目配置，只有切换 tracker 或重设时才需要重跑 setup。[Done](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L118-L120)

## 4. 重跑保护与副作用边界

已有入口块原位更新属于文案层保护；源码未定义 B/L/N 基线、目标前置摘要、安装锁或中断对账，不能推断其具备 Rigup 设计中的确定性更新保证。[Write](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L74-L120)

选择远端 tracker 但没有相应 remote 时，上游流程要求获取 URL 并接线，必要时 git init，直到 CLI 可查询项目。这会修改环境，并不是纯问答。[Section A](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L49-L51)

配置 triage 后，上游会创建远端缺失标签；旧 CONTEXT 名称迁移也作为可提出的动作。这些都应被本项目视为单独的写入/迁移副作用。[Explore](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L25-L25)、[Write](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L104-L106)

## 5. 对 Rigup 的设计推论

以下是本项目取舍，并非上游事实或待安装功能承诺：

1. **补项目工作约定**：能力选择后，按需确认工作来源/工单位置、文档与任务产物位置、已有规范及读取约定。安装工具与配置项目习惯是不同层次。
2. **推荐值带来源**：显示“来自 remote / 已有配置 / SDD 原生约定 / 用户 profile”，跳过明确值，仅问会改变行为的未决项。
3. **条件问题**：只有选中的 skill 真正消费 labels、领域文档布局或 tracker 时才提问；没有 triage 消费者，不生成五角色标签或新状态机。
4. **记录引用与消费规则**：入口文件保持简短，正文复用现有文档/所选 SDD 的原生资产；避免每个 agent 复制一套 tracker 和领域知识。
5. **先展示再落盘**：工作约定进入同一 SetupOptions、候选和最终预览，不能在问答中途悄悄写文档或修改 remote。
6. **保留当前增量更新模型**：复用项目选择，B/L/N 保护用户修改，跨宿主共享事实；不照搬“永远只编辑一个 CLAUDE.md/AGENTS.md”的规则。
7. **文档按需形成**：不生成空 glossary/ADR、假知识或占位业务规范；没有现成术语/决策时记录维护方式即可。
8. **明确安装来源与所有权**：检测到既有插件/本地 skills 时避免重复安装或自动接管，不新增首版远端自定义 skill 下载器。

## 6. 不纳入本次范围

- 不为参考此仓库而自动安装 mattpocock/skills 或新增第四个 SDD 选择。
- 不复制其 triage / wayfinder 的角色状态与 ticket 编排成为本产品运行时。
- 不默认创建远端工单、labels、仓库或 Git remote；如客户集成需要，必须进入明确预览并具备授权。
- 不把自然语言描述的“其他 tracker”报告为已实现的 API 连接；仅记录约定时应标为文档接入。
- 不以源码阅读替代真实宿主发现、连接及恢复验收。

核验范围：以上结论仅覆盖锁定提交中读取的说明和模板，没有运行安装器或 setup。后续实现仍需锁定适配版本并执行真实兼容测试。
