// Anthropic Messages API 的请求体和流式事件格式，只列出本项目用到的部分。
// 请求：https://platform.claude.com/docs/en/api/messages
// 流式事件：https://platform.claude.com/docs/en/build-with-claude/streaming

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock;

export type AnthropicMessage =
  | { role: "user"; content: string | AnthropicToolResultBlock[] }
  | { role: "assistant"; content: AnthropicAssistantBlock[] };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 思考深度。Opus 5.5 不填时是 medium */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  output_config?: { effort: AnthropicEffort };
  stream: true;
}

export type AnthropicStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "model_context_window_exceeded"
  | "pause_turn";

/**
 * 输入和缓存字段可能是 null，表示这次没有给出，不能用来覆盖已有的值。
 * 字段定义见官方 TypeScript SDK 的 Usage 和 MessageDeltaUsage。
 */
export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export type AnthropicDelta =
  | { type: "text_delta"; text: string }
  /** 工具参数 JSON 的一个片段，拼完整后才能解析 */
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  /** thinking 块的签名，在块结束前单独发一次 */
  | { type: "signature_delta"; signature: string };

/**
 * 流式响应里每个 SSE 事件的 data（JSON 解析后），按 type 区分。
 * API 以后可能新增事件类型和内容块类型，遇到不认识的要忽略。
 */
export type AnthropicStreamEvent =
  | { type: "message_start"; message: { id: string; model: string; usage?: AnthropicUsage } }
  /** 内容块开始。实际还可能出现上面没列出的块类型，比如 redacted_thinking */
  | { type: "content_block_start"; index: number; content_block: AnthropicAssistantBlock }
  | { type: "content_block_delta"; index: number; delta: AnthropicDelta }
  | { type: "content_block_stop"; index: number }
  /** usage 里的数字是到目前为止的累计值 */
  | { type: "message_delta"; delta: { stop_reason: AnthropicStopReason | null }; usage?: AnthropicUsage }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };
