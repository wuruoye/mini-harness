import type { OpenAIRequestBody } from "./openai-types.ts";
import type { SseEvent } from "./sse.ts";
import type { AssistantMessage, ModelRequest, Provider } from "./types.ts";

export const PROVIDER_NAME = "openai";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  /** 默认 DEFAULT_BASE_URL，接兼容服务时改成对方的地址 */
  baseUrl?: string;
  /** 单次回复最多输出多少 token，不填就不限制 */
  maxTokens?: number;
  /** 推理模型的思考深度，不填就用模型的默认值 */
  reasoningEffort?: string;
  /** 测试时注入假的 fetch，不填用全局 fetch */
  fetch?: typeof fetch;
}

/**
 * 统一请求 → OpenAI Chat Completions 请求体。
 *
 * - system 作为第一条消息，role 为 "system"
 * - 工具定义转成 { type: "function", function: { name, description, parameters } }；没有工具时不带 tools 字段
 * - 设置了 maxTokens 才带 max_completion_tokens，设置了 reasoningEffort 才带 reasoning_effort
 * - 总是带 stream: true 和 stream_options: { include_usage: true }
 * - 用户消息原样转换
 * - assistant 消息：所有 text 块用 "\n" 连成 content，空文本不算；没有文字时 content 为 null；
 *   toolCall 转成 tool_calls，arguments 用 JSON.stringify 转成字符串；thinking 块丢掉，OpenAI 没有对应字段
 * - 既没有文字也没有工具调用的 assistant 消息整条省略
 * - 每个工具结果单独一条 role 为 "tool" 的消息；isError 为 true 时在 content 前面加上 "错误："
 */
export function toOpenAIRequest(request: ModelRequest, options: OpenAIOptions): OpenAIRequestBody {
  throw new Error("未实现");
}

/**
 * OpenAI 流式数据块 → 统一的 assistant 消息。
 *
 * - data 为 "[DONE]" 表示流结束，之后的数据忽略；其他 data 都是 JSON
 * - 数据块里有 error 字段时抛异常，信息里带上 error.message
 * - model 取数据块里的 model，provider 为 PROVIDER_NAME
 * - delta.content 拼成一个 text 块；delta.reasoning_content 拼成一个没有签名的 thinking 块
 * - delta.tool_calls 按每一片的 index 归到对应的工具调用上：id、name 出现时记下，arguments 片段依次拼接；
 *   流结束后再解析，拼出来是空字符串就当作 {}，不是合法 JSON 时抛异常，信息里带上工具名
 * - 内容块的顺序：thinking（如果有）、text（如果有）、工具调用（按 index 从小到大）
 * - finish_reason 映射：stop → "stop"；tool_calls → "toolUse"；length → "length"；content_filter → "refusal"；其他值抛异常
 * - usage：inputTokens 为 prompt_tokens 减去 cached_tokens，cacheReadTokens 为 cached_tokens，
 *   outputTokens 为 completion_tokens，cacheWriteTokens 为 0；没有 usage 数据块时全部为 0
 * - 没收到 [DONE] 就结束了要抛异常，信息里提到 [DONE]；收到了但从没拿到 finish_reason 也抛异常
 */
export async function readOpenAIStream(events: AsyncIterable<SseEvent>): Promise<AssistantMessage> {
  throw new Error("未实现");
}

export class OpenAIProvider implements Provider {
  #options: OpenAIOptions;

  constructor(options: OpenAIOptions) {
    this.#options = options;
  }

  /**
   * POST {baseUrl}/chat/completions，请求头带 authorization: Bearer {apiKey} 和 content-type: application/json，
   * 请求体是 toOpenAIRequest 的结果。
   * HTTP 状态码不是 2xx 时抛异常，信息里带上状态码和响应正文；
   * 否则用 parseSse 和 readOpenAIStream 把响应解析成 assistant 消息。
   */
  async complete(request: ModelRequest): Promise<AssistantMessage> {
    throw new Error("未实现");
  }
}
