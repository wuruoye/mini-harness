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
 * - checkPermission 和 sandbox 一起放进工具的 context，工具执行中可以再申请权限。
 * - 最后一轮也执行完工具调用，避免历史留下没有结果的 toolCall，影响后续请求。
 * - 待实现：中断（options.signal），被中断时不抛异常，返回 stopReason 为 "aborted"
 *   - 每次请求模型之前检查：已经中止就不再请求，直接返回
 *   - signal 传给 provider.complete（第二个参数 { signal }）和工具的 context
 *   - 请求过程中被中止时 provider 会抛异常：如果 signal 已经中止，不往外抛，丢掉这次请求直接返回；
 *     其他异常照常抛出
 *   - 执行工具调用之前检查：已经中止的话，这一条和后面的工具调用都不执行，
 *     每个都补一条 isError 为 true、内容包含「中断」的工具结果（发 message 事件，不发 toolStart、toolEnd），
 *     保证历史里没有缺少结果的工具调用；这一轮的工具调用都处理完后返回
 * - 待实现：排队的消息（options.getQueuedMessages），只在还会继续请求模型时（没中止、请求次数没用完）去取
 *   - 一轮工具结果都加进历史之后，取一次；取到的用户消息依次加进历史，并发 message 事件
 *   - 模型不再调用工具、本来要结束时，也取一次；取到了就加进历史接着请求，没取到才结束
 */
export async function runAgent(messages: Message[], options: AgentOptions): Promise<AgentResult> {
  const { provider, system, tools, cwd, onEvent, checkPermission, maxTurns = DEFAULT_MAX_TURNS } = options;

  const toolMap = new Map<string, Tool>(tools.map((t) => [t.definition.name, t]));
  const toolDefs = tools.map((t) => t.definition);
  const context = { cwd, sandbox: options.sandbox, checkPermission };
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
