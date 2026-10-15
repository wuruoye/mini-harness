import type {
  AnthropicAssistantBlock,
  AnthropicEffort,
  AnthropicRequestBody,
  AnthropicStreamEvent,
  AnthropicToolResultBlock,
  AnthropicUsage,
} from "./anthropic-types.ts";
import { parseSse, type SseEvent } from "./sse.ts";
import type { AssistantContent, AssistantMessage, CompleteOptions, ModelRequest, Provider, StopReason, StreamDelta } from "./types.ts";

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
  const body: AnthropicRequestBody = {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: [],
    stream: true,
  };

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (options.effort !== undefined) {
    body.output_config = { effort: options.effort };
  }

  let toolResults: AnthropicToolResultBlock[] | undefined;
  for (const message of request.messages) {
    if (message.role === "toolResult") {
      if (toolResults === undefined) {
        toolResults = [];
        body.messages.push({ role: "user", content: toolResults });
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: message.isError,
      });
      continue;
    }
    toolResults = undefined;

    if (message.role === "user") {
      body.messages.push({ role: "user", content: message.content });
      continue;
    }

    const content: AnthropicAssistantBlock[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text !== "") content.push({ type: "text", text: block.text });
          break;
        case "toolCall":
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
          break;
        case "thinking":
          if (message.provider === PROVIDER_NAME && message.model === options.model && block.signature) {
            content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
          }
          break;
      }
    }
    if (content.length > 0) {
      body.messages.push({ role: "assistant", content });
    }
  }

  return body;
}

/**
 * Anthropic 流式事件 → 统一的 assistant 消息。
 *
 * - 每个事件的 data 都是 JSON，按其中的 type 处理；ping、不认识的事件和不认识的内容块都忽略
 * - text、thinking、签名的增量拼到对应 index 的块上；工具参数的 partial_json 全部拼完，
 *   在 content_block_stop 时再解析，拼出来是空字符串就当作 {}
 * - 内容块按 index 从小到大排列
 * - model 取 message_start 里的值，provider 为 PROVIDER_NAME
 * - usage 先取 message_start 里的值，message_delta 仅用非 null、非 undefined 的字段更新；缺的字段记为 0
 * - stop_reason 映射：end_turn、stop_sequence → "stop"；tool_use → "toolUse"；
 *   max_tokens、model_context_window_exceeded → "length"；refusal → "refusal"；其他值抛异常
 * - 收到 error 事件时抛异常，信息里带上错误类型和内容
 * - 流在 message_stop 之前就结束了也抛异常，信息里提到 message_stop
 * - 非空文字和推理增量通过 onDelta 发出；tool_use 块开始时发 toolCallStart，签名和参数片段不发增量
 */
export async function readAnthropicStream(
  events: AsyncIterable<SseEvent>,
  onDelta?: (delta: StreamDelta) => void,
): Promise<AssistantMessage> {
  let model = "";
  let stopReason: StopReason | undefined;
  const usage: AnthropicUsage = {};
  const blocks = new Map<number, AssistantContent>();
  const partialInputs = new Map<number, string>();

  function mergeUsage(next?: AnthropicUsage): void {
    if (next?.input_tokens != null) usage.input_tokens = next.input_tokens;
    if (next?.output_tokens != null) usage.output_tokens = next.output_tokens;
    if (next?.cache_read_input_tokens != null) usage.cache_read_input_tokens = next.cache_read_input_tokens;
    if (next?.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = next.cache_creation_input_tokens;
  }

  for await (const event of events) {
    const data: AnthropicStreamEvent = JSON.parse(event.data);
    switch (data.type) {
      case "message_start":
        model = data.message.model;
        mergeUsage(data.message.usage);
        break;
      case "content_block_start": {
        const block = data.content_block;
        switch (block.type) {
          case "text":
            blocks.set(data.index, { type: "text", text: block.text });
            break;
          case "thinking":
            blocks.set(data.index, { type: "thinking", thinking: block.thinking, signature: block.signature });
            break;
          case "tool_use":
            blocks.set(data.index, { type: "toolCall", id: block.id, name: block.name, arguments: block.input });
            partialInputs.set(data.index, "");
            onDelta?.({ type: "toolCallStart", id: block.id, name: block.name });
            break;
        }
        break;
      }
      case "content_block_delta": {
        const block = blocks.get(data.index);
        const delta = data.delta;
        switch (delta.type) {
          case "text_delta":
            if (block?.type === "text") {
              block.text += delta.text;
              if (delta.text !== "") onDelta?.({ type: "text", text: delta.text });
            }
            break;
          case "thinking_delta":
            if (block?.type === "thinking") {
              block.thinking += delta.thinking;
              if (delta.thinking !== "") onDelta?.({ type: "thinking", text: delta.thinking });
            }
            break;
          case "signature_delta":
            if (block?.type === "thinking") block.signature = (block.signature ?? "") + delta.signature;
            break;
          case "input_json_delta":
            if (block?.type === "toolCall") {
              partialInputs.set(data.index, (partialInputs.get(data.index) ?? "") + delta.partial_json);
            }
            break;
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(data.index);
        const json = partialInputs.get(data.index);
        if (block?.type === "toolCall" && json !== undefined) {
          try {
            block.arguments = json === "" ? {} : JSON.parse(json);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`工具 ${block.name} 的参数不是合法 JSON：${message}`);
          }
          partialInputs.delete(data.index);
        }
        break;
      }
      case "message_delta":
        mergeUsage(data.usage);
        if (data.delta.stop_reason != null) {
          switch (data.delta.stop_reason) {
            case "end_turn":
            case "stop_sequence":
              stopReason = "stop";
              break;
            case "tool_use":
              stopReason = "toolUse";
              break;
            case "max_tokens":
            case "model_context_window_exceeded":
              stopReason = "length";
              break;
            case "refusal":
              stopReason = "refusal";
              break;
            default:
              throw new Error(`不支持的 stop_reason：${data.delta.stop_reason}`);
          }
        }
        break;
      case "message_stop":
        if (stopReason === undefined) throw new Error("Anthropic 响应流缺少 stop_reason");
        if (partialInputs.size > 0) throw new Error("Anthropic 工具调用缺少 content_block_stop");
        return {
          role: "assistant",
          content: [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block),
          stopReason,
          provider: PROVIDER_NAME,
          model,
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          },
        };
      case "error":
        throw new Error(`Anthropic 流式响应出错（${data.error.type}）：${data.error.message}`);
    }
  }

  throw new Error("Anthropic 响应流在收到 message_stop 前结束");
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
   * options.signal 原样传给 fetch，用户中断时请求会立刻结束。
   * 否则用 parseSse 和 readAnthropicStream 把响应解析成 assistant 消息。
   */
  async complete(request: ModelRequest, options: CompleteOptions = {}): Promise<AssistantMessage> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl = globalThis.fetch } = this.#options;
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(toAnthropicRequest(request, this.#options)),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic 请求失败（HTTP ${response.status}）：${await response.text()}`);
    }
    if (response.body === null) {
      throw new Error("Anthropic 响应缺少数据流");
    }

    return readAnthropicStream(parseSse(response.body), options.onDelta);
  }
}
