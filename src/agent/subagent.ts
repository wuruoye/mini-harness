// 子代理：task 工具在内部再跑一次主循环。子代理的上下文只有主代理写的任务说明，
// 它读过的文件、跑过的命令都不进主对话，只有最后的汇报作为工具结果交回主代理。

import type { Provider, ToolDefinition } from "../ai/types.ts";
import { runAgent } from "./loop.ts";
import type { AgentEvent, Tool } from "./types.ts";

export const TASK_TOOL_NAME = "task";

/** 子代理最多请求模型几次，默认值 */
export const SUBAGENT_MAX_TURNS = 30;

/** 加在主代理系统提示后面，告诉子代理它的身份和汇报方式 */
export const SUBAGENT_SYSTEM_SUFFIX = `# 子代理
你是主代理派出的子代理，只负责完成下面这条任务说明里的事，看不到主代理和用户之间的对话。
完成后用一段话汇报：做了什么、结论是什么、关键的文件路径和行号。这段汇报是主代理唯一能看到的内容，要写得完整。
做不完或者遇到问题时，也在汇报里说清楚卡在哪里。`;

export const TASK_TOOL_DEFINITION: ToolDefinition = {
  name: TASK_TOOL_NAME,
  description:
    "把一个独立的子任务交给子代理去做，比如在大量文件里查找、调查一个问题的原因。" +
    "子代理用自己的上下文工作，读过的内容不会占用当前对话的上下文，做完后返回一段汇报。" +
    "子代理看不到当前对话，prompt 里要写清楚背景、目标和完成标准。简单的事自己直接做，不要交给子代理。",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "任务的简短说明，3 到 10 个字，用来显示给用户" },
      prompt: { type: "string", description: "交给子代理的完整任务说明" },
    },
    required: ["description", "prompt"],
  },
};

export interface TaskToolOptions {
  provider: Provider;
  /** 主代理的系统提示；子代理用的是它后面空一行再加上 SUBAGENT_SYSTEM_SUFFIX */
  system: string;
  /**
   * 每次执行 task 时调用一次，拿到子代理这次用的工具。每次都要新的一份：比如带子目录指令的工具
   * 要用新的已加载集合，子代理的上下文和主代理是分开的，主代理加载过的指令子代理并没有看到
   */
  createTools: () => Tool[];
  /** 子代理最多请求模型几次，默认 SUBAGENT_MAX_TURNS */
  maxTurns?: number;
  /** 子代理的事件，用于显示；description 是这次任务的简短说明 */
  onEvent?: (event: AgentEvent, description: string) => void;
}

/**
 * 创建 task 工具，definition 是 TASK_TOOL_DEFINITION。执行时：
 * - description 和 prompt 都要是非空字符串，否则抛异常，信息里带上参数名
 * - 用 runAgent 跑子代理：
 *   - 起始历史只有一条 user 消息，内容是 prompt
 *   - system 是 options.system + "\n\n" + SUBAGENT_SYSTEM_SUFFIX
 *   - tools 是 createTools() 的结果去掉名为 TASK_TOOL_NAME 的工具，子代理不能再派子代理
 *   - cwd、sandbox、checkPermission、signal 用这次执行时拿到的 context：
 *     权限照样问用户，按 Ctrl-C 时子代理一起停下
 *   - 不传 getQueuedMessages，用户的插话只给主代理
 *   - 子代理的每个事件交给 options.onEvent(event, description)
 * - 汇报是子代理最后一条 assistant 消息里的所有文本块，按顺序用 \n 连接
 * - 返回的结果：
 *   - stopReason 为 "stop"：content 是汇报；汇报为空时 content 是「子代理没有给出汇报」，isError 都为 false
 *   - stopReason 为 "aborted"：isError 为 true，content 说明子代理被中断
 *   - 其他（"maxTurns"、"length"、"refusal"）：isError 为 true，content 说明子代理没有完成和停止原因，
 *     有汇报时附在后面
 * - runAgent 抛出的异常（比如网络错误）不捕获，交给主循环转成错误结果
 */
export function createTaskTool(options: TaskToolOptions): Tool {
  return {
    definition: TASK_TOOL_DEFINITION,
    async execute(args, context) {
      const { description, prompt } = args;
      if (typeof description !== "string" || description.trim() === "") {
        throw new Error("description 必须是非空字符串");
      }
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("prompt 必须是非空字符串");
      }

      const result = await runAgent([{ role: "user", content: prompt }], {
        provider: options.provider,
        system: `${options.system}\n\n${SUBAGENT_SYSTEM_SUFFIX}`,
        tools: options.createTools().filter((tool) => tool.definition.name !== TASK_TOOL_NAME),
        cwd: context.cwd,
        sandbox: context.sandbox,
        checkPermission: context.checkPermission,
        signal: context.signal,
        maxTurns: options.maxTurns ?? SUBAGENT_MAX_TURNS,
        onEvent: (event) => options.onEvent?.(event, description),
      });
      const assistant = result.messages.findLast((message) => message.role === "assistant");
      const report = assistant?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";

      if (result.stopReason === "stop") return { content: report || "子代理没有给出汇报", isError: false };
      if (result.stopReason === "aborted") return { content: "子代理已被中断", isError: true };
      return {
        content: `子代理没有完成，停止原因：${result.stopReason}${report ? `\n\n${report}` : ""}`,
        isError: true,
      };
    },
  };
}
