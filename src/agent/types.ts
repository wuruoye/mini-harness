import type { Message, Provider, StopReason, ToolCallBlock, ToolDefinition } from "../ai/types.ts";

export interface ToolContext {
  /** 工作目录，相对路径以它为准 */
  cwd: string;
}

export interface ToolResult {
  content: string;
  /** 不填等于 false */
  isError?: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  /**
   * 执行工具。args 来自模型，不一定符合 schema，要自己检查。
   * 出错时可以直接抛异常，由主循环转成错误结果交给模型。
   */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type AgentEvent =
  /** 每往历史里新增一条消息发一次，传入的历史不算 */
  | { type: "message"; message: Message }
  /** 开始执行一个工具调用 */
  | { type: "toolStart"; toolCall: ToolCallBlock }
  /** 工具调用执行完。result 和随后加入历史的工具结果一致，isError 已经补全 */
  | { type: "toolEnd"; toolCall: ToolCallBlock; result: Required<ToolResult> };

export interface AgentOptions {
  provider: Provider;
  system: string;
  tools: Tool[];
  cwd: string;
  /** 最多请求模型几次，默认 DEFAULT_MAX_TURNS */
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  /** 完整历史：传入的消息加上这次新增的 */
  messages: Message[];
  /** 最后一条 assistant 消息的停止原因；因为请求次数用完而停下时为 "maxTurns" */
  stopReason: StopReason | "maxTurns";
}
