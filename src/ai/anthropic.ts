import type { AnthropicEffort, AnthropicRequestBody } from "./anthropic-types.ts";
import type { SseEvent } from "./sse.ts";
import type { AssistantMessage, ModelRequest, Provider } from "./types.ts";

export const PROVIDER_NAME = "anthropic";
export const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MAX_TOKENS = 64_000;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** 默认 DEFAULT_BASE_URL，走代理或内部网关时修改 */
  baseUrl?: string;
  /** 单次回复最多输出多少 token，默认 DEFAULT_MAX_TOKENS */
  maxTokens?: number;
  /** 思考深度，不填就用模型的默认值 */
  effort?: AnthropicEffort;
  /** 测试时注入假的 fetch，不填用全局 fetch */
  fetch?: typeof fetch;
}

/**
 * 统一请求 → Anthropic 请求体。
 *
 * - 工具定义的 parameters 放进 input_schema；没有工具时不带 tools 字段
 * - 设置了 effort 才带 output_config 字段
 * - 用户消息原样转换
 * - assistant 消息：text → text 块，空文本省略；toolCall → tool_use 块
 * - thinking 块只有在「消息来自 anthropic、message.model 等于 options.model、有签名」时才原样带回，否则省略
 * - 转换后没有任何内容的 assistant 消息整条省略
 * - 连续的工具结果合并成一条 user 消息，每个结果是一个 tool_result 块
 */
export function toAnthropicRequest(request: ModelRequest, options: AnthropicOptions): AnthropicRequestBody {
  throw new Error("未实现");
}

/**
 * Anthropic 流式事件 → 统一的 assistant 消息。
 *
 * - 每个事件的 data 都是 JSON，按其中的 type 处理；ping、不认识的事件和不认识的内容块都忽略
 * - text、thinking、签名的增量拼到对应 index 的块上；工具参数的 partial_json 全部拼完，
 *   在 content_block_stop 时再解析，拼出来是空字符串就当作 {}
 * - 内容块按 index 从小到大排列
 * - model 取 message_start 里的值，provider 为 PROVIDER_NAME
 * - usage 先取 message_start 里的值，message_delta 里出现的字段覆盖它；缺的字段记为 0
 * - stop_reason 映射：end_turn、stop_sequence → "stop"；tool_use → "toolUse"；
 *   max_tokens、model_context_window_exceeded → "length"；refusal → "refusal"；其他值抛异常
 * - 收到 error 事件时抛异常，信息里带上错误类型和内容
 * - 流在 message_stop 之前就结束了也抛异常，信息里提到 message_stop
 */
export async function readAnthropicStream(events: AsyncIterable<SseEvent>): Promise<AssistantMessage> {
  throw new Error("未实现");
}

export class AnthropicProvider implements Provider {
  #options: AnthropicOptions;

  constructor(options: AnthropicOptions) {
    this.#options = options;
  }

  /**
   * POST {baseUrl}/messages，请求头带 x-api-key、anthropic-version 和 content-type: application/json，
   * 请求体是 toAnthropicRequest 的结果。
   * HTTP 状态码不是 2xx 时抛异常，信息里带上状态码和响应正文；
   * 否则用 parseSse 和 readAnthropicStream 把响应解析成 assistant 消息。
   */
  async complete(request: ModelRequest): Promise<AssistantMessage> {
    throw new Error("未实现");
  }
}
