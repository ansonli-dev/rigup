# Issue 92 · 保留可脱敏的研究文件

[Issue #92](https://github.com/ansonli-dev/rigup/issues/92) · [核查基线 `ee6648c`](https://github.com/ansonli-dev/rigup/commit/ee6648c7147f642f88d3ff9381d58a1b9765da85)

## 已核实

在 v0.11.0 的最新主线上，用合成的 Java 服务、Spring properties 和 README 重现了 `unsupported sensitive format`。普通赋值和内联文档示例触发整文件拒读，仓库扫描会将文件排除。原 issue 的私有项目和 31 个文件的计数以报告为准。[读策略](../../../src/analyzer/read-policy.ts) · [读取清单](../../../src/analyzer/repository.ts)

未知格式的现有测试固定了这一行为。Markdown 已经能遮盖可识别的独立多行值。旧安装预览通过单独的 legacy 读取函数核对当时的清单。

另使用 Apache Tika 仓库固定提交中的实际 Maven Wrapper 检查 POSIX 和 Windows 脚本。两个文件均可读，各遮盖 3 行，行数与原文件一致。[mvnw](https://github.com/apache/tika/blob/6ef8f501b1610fcb36d275332d2337e3113de74d/mvnw) · [mvnw.cmd](https://github.com/apache/tika/blob/6ef8f501b1610fcb36d275332d2337e3113de74d/mvnw.cmd)

## 设计

直接替换所有命中行会留下续行和环境段中的值。只排除若干 Java 和 Maven 误报会让其他普通文本继续不可读。选择遮盖边界明确的单行内容，沿用 Markdown 对独立多行值的处理，对边界不明或不能安全处理的内容继续拒读。

- 普通文本和源码的命中行变为 `[REDACTED]`。保留邻行、LF/CRLF 边界以及现有 TypeScript 原始类型字段例外，包括跨行类型声明。Windows 批处理的空 `SET` 和有明确闭合引号的令牌选择式也可逐行脱敏。Markdown 等文档也处理内联命中，独立赋值沿用现有多行逻辑。
- 保持对跨行键名与分隔符、空值后续行、续行符、未闭合引号或括号、块值和别名，以及可能含任意键的独立环境段的保守拒读。原文件名、私钥、二进制、结构化配置解析和 URL 脱敏继续使用现有规则。
- 提升 `READ_POLICY_VERSION` 为 `9`，让研究指纹与旧缓存失配。保留 legacy 安装读取规则。
- 从真实研究 reader 核对恢复后的清单、邻行、行号和可见摘要。测试使用合成标记。
