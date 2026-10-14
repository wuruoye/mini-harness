// OpenAI Chat Completions API 的请求体和流式数据块格式，只列出本项目用到的部分。
// 文档：https://platform.openai.com/docs/api-reference/chat
// DeepSeek、Ollama、vLLM 等「兼容 OpenAI」的服务也用这个格式，但细节可能不同。

export interface OpenAIToolCall {
  id: string;
  type: "function";
  /** arguments 是 JSON 字符串，不是对象 */
  function: { name: string; arguments: string };
}

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  /** 只有工具调用、没有文字时 content 为 null */
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  /** 每个工具结果单独一条，没有表示出错的字段 */
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  /** OpenAI 官方的输出上限字段；不少兼容服务只认旧的 max_tokens */
  max_completion_tokens?: number;
  /** 推理模型的思考深度，可选值随模型而定 */
  reasoning_effort?: string;
  stream: true;
  /** 不加这一项，流式响应里没有 token 用量 */
  stream_options: { include_usage: true };
}

export type OpenAIFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

export interface OpenAIUsage {
  /** 包含命中缓存的部分 */
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * 工具调用的一个片段。index 指第几个工具调用；id 和 name 只在第一片里出现。
 * 有些兼容服务在后续片段里也带 id 和 name，但值是空字符串
 */
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/**
 * 流式响应里每个 SSE 事件的 data（JSON 解析后）。
 * 流的最后一行是 `data: [DONE]`，它不是 JSON，要在解析前单独判断。
 */
export interface OpenAIChunk {
  id?: string;
  model?: string;
  choices: {
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      /** OpenAI 官方没有这个字段；DeepSeek 等兼容服务用它返回思考内容 */
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    /**
     * 标准里没结束时是 null。公司网关等兼容服务会用空字符串 "" 表示没结束，
     * 用 "error" 表示服务端出错
     */
    finish_reason: OpenAIFinishReason | "error" | "" | null;
  }[];
  /** 打开 include_usage 后，最后会多一个 choices 为空、只带 usage 的数据块；其他数据块里是 null */
  usage?: OpenAIUsage | null;
  /** 部分兼容服务在流的中途出错时，用这个字段报告 */
  error?: { message: string; type?: string };
}
