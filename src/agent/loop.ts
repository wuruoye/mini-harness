import type { Message, ToolCallBlock, ToolResultMessage } from "../ai/types.ts";
import type { AgentOptions, AgentResult, Tool, ToolResult } from "./types.ts";

/** 模型最多请求次数的默认值，防止无限循环 */
export const DEFAULT_MAX_TURNS = 20;

/**
 * 请求模型并按顺序执行工具调用，直到模型停止或达到 maxTurns。
 *
 * - 不修改传入的历史；工具错误作为结果交回模型。
 * - 找到工具后、执行前调用 checkPermission；拒绝时作为错误结果返回，循环继续。
 *   找不到的工具直接报错，不用询问权限。
 * - 最后一轮也执行完工具调用，避免历史留下没有结果的 toolCall，影响后续请求。
 */
export async function runAgent(messages: Message[], options: AgentOptions): Promise<AgentResult> {
  const { provider, system, tools, cwd, onEvent, checkPermission, maxTurns = DEFAULT_MAX_TURNS } = options;

  const toolMap = new Map<string, Tool>(tools.map((t) => [t.definition.name, t]));
  const toolDefs = tools.map((t) => t.definition);
  const context = { cwd };
  const history: Message[] = [...messages];
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    const assistant = await provider.complete({ system, messages: history, tools: toolDefs });
    history.push(assistant);
    onEvent?.({ type: "message", message: assistant });

    const calls = assistant.content.filter((b): b is ToolCallBlock => b.type === "toolCall");

    if (calls.length === 0) {
      return { messages: history, stopReason: assistant.stopReason };
    }

    for (const call of calls) {
      onEvent?.({ type: "toolStart", toolCall: call });

      let result: Required<ToolResult>;
      const tool = toolMap.get(call.name);

      if (!tool) {
        // 模型可能拼错工具名，列出可用工具方便重试。
        result = {
          content: `找不到工具：${call.name}。可用工具：${[...toolMap.keys()].join("、") || "无"}`,
          isError: true,
        };
      } else {
        try {
          const decision = await checkPermission?.(call);
          if (decision && !decision.allowed) {
            result = {
              content: `用户拒绝了这次工具调用${decision.reason ? `：${decision.reason}` : ""}`,
              isError: true,
            };
          } else {
            const raw = await tool.execute(call.arguments, context);
            result = { content: raw.content, isError: raw.isError ?? false };
          }
        } catch (err) {
          // JS 可以抛出任意值，取 message 前先确认是 Error。
          const message = err instanceof Error ? err.message : String(err);
          result = { content: message, isError: true };
        }
      }

      onEvent?.({ type: "toolEnd", toolCall: call, result });

      const toolResultMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
      };
      history.push(toolResultMsg);
      onEvent?.({ type: "message", message: toolResultMsg });
    }
  }

  return { messages: history, stopReason: "maxTurns" };
}
