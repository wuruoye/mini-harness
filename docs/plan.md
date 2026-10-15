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

从里程碑 7 开始，除测试外的代码都自己写，包括类型、实现，以及 `main.ts` 里模块之间怎么串起来。Claude 负责测试和非核心的部分：

| Claude 负责 | 说明 |
|---|---|
| 测试 | 按大纲或实现注释里的规则写测试，用不进仓库的参考实现确认测试本身是对的 |
| 讨论和解释 | 回答原理问题，对比参考项目的做法，需要时一起讨论设计 |
| review | 读代码、跑测试，用不进仓库的临时脚本或模拟服务器验证；发现漏掉的边界情况时补上测试，实现由自己修改 |
| 环境和工具 | 依赖、tsconfig、IDE 调试配置、遇到的环境问题 |
| git 和文档 | 按约定提交、推送，维护 README 和本文件 |

里程碑 1 到 6 的分工是：Claude 给出类型定义、规则说明和测试，并写工程配置、SSE 解析、子进程封装、假模型、命令行入口等外围部分；自己写各模块的实现。

## 里程碑

1. 统一消息类型、假模型和最小循环，只有 `read_file` 一个工具，用测试跑通。
2. Anthropic 适配器，第一次真实调用模型。
3. OpenAI 适配器。
4. 加 `bash` 和 `edit` 两个工具，再加权限规则。
5. 会话存成 JSONL，加上上下文压缩。
6. 中断，以及运行中用户输入的消息先排队。
7. 评测任务集（暂缓，之后再做）。
8. 模型回复流式显示。
9. 提示缓存。
10. 项目指令和系统提示：读取 AGENTS.md，加上环境信息，拼成系统提示。
11. 终端里渲染 Markdown：模型回复按行渲染标题、强调、行内代码、代码块、列表、引用和表格。
12. 输入框：自己处理按键，支持多行、粘贴、历史；输入框固定在底部，运行中模型输出出现在它上面。

## 参考代码

pi（[badlogic/pi-mono](https://github.com/badlogic/pi-mono)）：

- [agent-loop.ts](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts)：主循环
- [types.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts)、[transform-messages.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/transform-messages.ts)：统一消息格式，以及换模型时的转换
- [anthropic-messages.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/anthropic-messages.ts)、[openai-completions.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/openai-completions.ts)：两个适配器
- [tools](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/core/tools)：工具实现，重点看 `edit.ts` 和 `truncate.ts`
- [system-prompt.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts)、[resource-loader.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/resource-loader.ts)：系统提示的拼接，以及 AGENTS.md 的查找
- [session-format.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)、[compaction.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)：会话格式和压缩

opencode（[anomalyco/opencode](https://github.com/anomalyco/opencode)）：

- [permissions.mdx](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx)、[permission.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/permission.ts)：权限规则
- [max-steps.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/max-steps.ts)：步数上限的提示
