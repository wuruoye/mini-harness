# 方案

## 目标

弄懂 coding agent harness 的核心部分：消息格式、主循环、工具、权限、上下文管理和评测。

## 技术选择

| 用途 | 选择 | 说明 |
|---|---|---|
| 运行 | `node src/xxx.ts` | Node 直接运行 .ts，只能用可擦除的类型写法，不能用 `enum`、`namespace` |
| 类型检查 | `tsc --noEmit` | 严格模式全开 |
| 包管理 | pnpm | |
| 测试 | `node:test` | 测试文件命名为 `*.test.ts` |
| 参数校验 | zod | 校验模型传来的工具参数，同一份定义转成 JSON Schema 发给模型 |
| HTTP | 内置 `fetch` | 不用厂商 SDK |
| 子进程 | `node:child_process` | |
| 界面 | readline | 以后再换 Ink |

## 分层

参照 pi 的分层，从下到上：

1. **模型接入层**：统一消息格式，Anthropic Messages 和 OpenAI Chat Completions 两个适配器，流式解析。
2. **主循环**：调用模型、分发工具、判断停止、限制步数。不直接打印，只往外发事件。
3. **编程 agent**：工具注册、权限规则、会话存储（JSONL）、上下文压缩。
4. **界面**：订阅主循环的事件并显示。

## 分工

| Claude 写 | 自己手写 |
|---|---|
| 工程配置、SSE 解析、子进程封装 | OpenAI 适配器，对照 Anthropic 适配器来写 |
| Anthropic 适配器，作为读代码和断点调试的样例 | |
| 假模型：按脚本返回固定回复，测试不花 token | 主循环和事件 |
| 评测脚本、会话查看工具 | 工具、权限、会话存储、上下文压缩 |

每个模块的节奏：Claude 给出类型定义和测试 → 自己写实现 → Claude review → 对照 pi 的同一部分看差别。

## 里程碑

1. 统一消息类型、假模型和最小循环，只有 `read_file` 一个工具，用测试跑通。
2. Anthropic 适配器，第一次真实调用模型。
3. OpenAI 适配器。
4. 加 `bash` 和 `edit` 两个工具，再加权限规则。
5. 会话存成 JSONL，加上上下文压缩。
6. 中断，以及运行中用户输入的消息先排队。
7. 评测任务集。

## 参考代码

pi（[badlogic/pi-mono](https://github.com/badlogic/pi-mono)）：

- [agent-loop.ts](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts)：主循环
- [types.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts)、[transform-messages.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/transform-messages.ts)：统一消息格式，以及换模型时的转换
- [anthropic-messages.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/anthropic-messages.ts)、[openai-completions.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/openai-completions.ts)：两个适配器
- [tools](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/core/tools)：工具实现，重点看 `edit.ts` 和 `truncate.ts`
- [session-format.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)、[compaction.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)：会话格式和压缩

opencode（[anomalyco/opencode](https://github.com/anomalyco/opencode)）：

- [permissions.mdx](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx)、[permission.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/permission.ts)：权限规则
- [max-steps.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/max-steps.ts)：步数上限的提示
