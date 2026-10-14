import type { Message } from "../ai/types.ts";
import type { AgentOptions, AgentResult } from "./types.ts";

export const DEFAULT_MAX_TURNS = 20;

/**
 * 主循环：请求模型 → 执行回复里的工具调用 → 把结果加进历史 → 再请求，直到模型不再调用工具。
 *
 * - messages 是已有的历史，最后一条通常是用户消息。不要修改这个数组
 * - assistant 消息里有 toolCall 块就按顺序执行，全部结果加进历史后再请求下一次；没有就结束
 * - 找不到工具、工具抛异常，都转成 isError 为 true 的工具结果，循环继续
 * - 请求次数达到 maxTurns 时，执行完这一轮的工具调用就停下，stopReason 为 "maxTurns"
 */
export async function runAgent(messages: Message[], options: AgentOptions): Promise<AgentResult> {
  throw new Error("未实现");
}
