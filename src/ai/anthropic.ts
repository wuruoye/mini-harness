import type {
  AnthropicAssistantBlock,
  AnthropicEffort,
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicToolResultBlock,
  AnthropicUsage,
} from "./anthropic-types.ts";
import { parseSse, type SseEvent } from "./sse.ts";
import type {
  AssistantContent,
  AssistantMessage,
  ModelRequest,
  Provider,
  StopReason,
  Usage,
} from "./types.ts";

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
  const messages: AnthropicMessage[] = [];

  for (const message of request.messages) {
    switch (message.role) {
      case "user":
        messages.push({ role: "user", content: message.content });
        break;

      case "assistant": {
        // 签名只对生成它的那个模型有效，换了模型就不能带回去
        const sameModel = message.provider === PROVIDER_NAME && message.model === options.model;
        const content: AnthropicAssistantBlock[] = [];
        for (const block of message.content) {
          switch (block.type) {
            case "text":
              // API 不接受空的 text 块
              if (block.text !== "") content.push({ type: "text", text: block.text });
              break;
            case "thinking":
              if (sameModel && block.signature) {
                content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
              }
              break;
            case "toolCall":
              content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
              break;
          }
        }
        // API 也不接受没有内容的 assistant 消息
        if (content.length > 0) messages.push({ role: "assistant", content });
        break;
      }

      case "toolResult": {
        const result: AnthropicToolResultBlock = {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError,
        };
        // Anthropic 要求同一轮的工具结果放在同一条 user 消息里。
        // 上一条如果是装工具结果的 user 消息（content 是数组），就追加进去；否则新建一条
        const last = messages.at(-1);
        if (last?.role === "user" && Array.isArray(last.content)) {
          last.content.push(result);
        } else {
          messages.push({ role: "user", content: [result] });
        }
        break;
      }
    }
  }

  const body: AnthropicRequestBody = {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages,
    stream: true,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (options.effort) body.output_config = { effort: options.effort };
  return body;
}

function toStopReason(reason: AnthropicStopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "toolUse";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    default:
      // pause_turn 只在使用服务端工具时出现，这个项目用不到
      throw new Error(`不支持的 stop_reason：${reason}`);
  }
}

/** 用 API 返回的用量覆盖已有的值，API 没给的字段保持不变 */
function applyUsage(usage: Usage, raw: AnthropicUsage | undefined): void {
  if (!raw) return;
  if (raw.input_tokens !== undefined) usage.inputTokens = raw.input_tokens;
  if (raw.output_tokens !== undefined) usage.outputTokens = raw.output_tokens;
  if (raw.cache_read_input_tokens !== undefined) usage.cacheReadTokens = raw.cache_read_input_tokens;
  if (raw.cache_creation_input_tokens !== undefined) usage.cacheWriteTokens = raw.cache_creation_input_tokens;
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
  let model = "";
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason: StopReason | undefined;
  let finished = false;

  // 正在拼接的内容块，key 是事件里的 index
  const blocks = new Map<number, AssistantContent>();
  // 工具参数的 JSON 片段，同样按 index 存，块结束时再解析
  const toolJson = new Map<number, string>();

  for await (const sse of events) {
    // as 只告诉编译器类型，不做检查；遇到不认识的 type 会落到 switch 外面，什么都不做
    const event = JSON.parse(sse.data) as AnthropicStreamEvent;

    switch (event.type) {
      case "message_start":
        model = event.message.model;
        applyUsage(usage, event.message.usage);
        break;

      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          blocks.set(event.index, { type: "text", text: block.text });
        } else if (block.type === "thinking") {
          blocks.set(event.index, { type: "thinking", thinking: block.thinking, signature: block.signature });
        } else if (block.type === "tool_use") {
          blocks.set(event.index, { type: "toolCall", id: block.id, name: block.name, arguments: {} });
          toolJson.set(event.index, "");
        }
        // 其他块类型（比如 redacted_thinking）不记录，它们后续的增量也会因为找不到块而被忽略
        break;
      }

      case "content_block_delta": {
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (block?.type === "text" && delta.type === "text_delta") {
          block.text += delta.text;
        } else if (block?.type === "thinking" && delta.type === "thinking_delta") {
          block.thinking += delta.thinking;
        } else if (block?.type === "thinking" && delta.type === "signature_delta") {
          block.signature = (block.signature ?? "") + delta.signature;
        } else if (block?.type === "toolCall" && delta.type === "input_json_delta") {
          toolJson.set(event.index, (toolJson.get(event.index) ?? "") + delta.partial_json);
        }
        break;
      }

      case "content_block_stop": {
        const block = blocks.get(event.index);
        if (block?.type === "toolCall") {
          // 片段只有拼完整才是合法 JSON，所以等块结束再解析
          const json = toolJson.get(event.index) ?? "";
          try {
            block.arguments = json === "" ? {} : JSON.parse(json);
          } catch {
            throw new Error(`工具 ${block.name} 的参数不是合法 JSON：${json}`);
          }
        }
        break;
      }

      case "message_delta":
        stopReason = toStopReason(event.delta.stop_reason);
        applyUsage(usage, event.usage);
        break;

      case "message_stop":
        finished = true;
        break;

      case "error":
        throw new Error(`Anthropic API 流式错误 ${event.error.type}：${event.error.message}`);
    }
  }

  if (!finished || stopReason === undefined) {
    throw new Error("响应流在 message_stop 之前就结束了");
  }

  const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  return { role: "assistant", content, stopReason, provider: PROVIDER_NAME, model, usage };
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
    const options = this.#options;
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(`${options.baseUrl ?? DEFAULT_BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(toAnthropicRequest(request, options)),
    });

    if (!response.ok || !response.body) {
      // 错误响应是普通 JSON，里面有错误类型和说明，原样带上方便排查
      throw new Error(`Anthropic API 返回 HTTP ${response.status}：${await response.text()}`);
    }
    return readAnthropicStream(parseSse(response.body));
  }
}
