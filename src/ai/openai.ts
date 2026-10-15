import type { OpenAIChunk, OpenAIRequestBody, OpenAIToolCall } from "./openai-types.ts";
import { parseSse, type SseEvent } from "./sse.ts";
import type { AssistantContent, AssistantMessage, CompleteOptions, ModelRequest, Provider, StopReason, StreamDelta } from "./types.ts";

export const PROVIDER_NAME = "openai";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** 每次请求前取 key；force 为 true 表示上一次的 key 被拒绝（HTTP 401），要换一个新的 */
export type ApiKeyProvider = (options: { signal?: AbortSignal; force?: boolean }) => Promise<string>;

export interface OpenAIOptions {
  /** 固定的 key，或者每次请求前取 key 的函数（比如会过期的 OAuth token） */
  apiKey: string | ApiKeyProvider;
  /** 消息里记的厂商名，默认 PROVIDER_NAME */
  name?: string;
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
export function toOpenAIRequest(
  request: ModelRequest,
  options: Pick<OpenAIOptions, "model" | "maxTokens" | "reasoningEffort">,
): OpenAIRequestBody {
  const body: OpenAIRequestBody = {
    model: options.model,
    messages: [{ role: "system", content: request.system }],
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (options.maxTokens !== undefined) {
    body.max_completion_tokens = options.maxTokens;
  }
  if (options.reasoningEffort !== undefined) {
    body.reasoning_effort = options.reasoningEffort;
  }

  for (const message of request.messages) {
    if (message.role === "user") {
      body.messages.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "toolResult") {
      body.messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.isError ? `错误：${message.content}` : message.content,
      });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text !== "") textParts.push(block.text);
          break;
        case "toolCall":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.arguments) },
          });
          break;
      }
    }
    if (textParts.length === 0 && toolCalls.length === 0) continue;

    body.messages.push({
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return body;
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
 *   outputTokens 为 completion_tokens，cacheWriteTokens 为 0；没有 usage 数据块时全部为 0。
 *   有 total_tokens 且减去 prompt_tokens 后比 completion_tokens 大时（推理 token 没算进 completion_tokens），
 *   outputTokens 用这个差
 * - 没收到 [DONE] 就结束了要抛异常，信息里提到 [DONE]；收到了但从没拿到 finish_reason 也抛异常
 * - 非空文字和推理片段通过 onDelta 发出；每个 index 的工具调用第一次拿到非空名字时发一次 toolCallStart
 */
export async function readOpenAIStream(
  events: AsyncIterable<SseEvent>,
  onDelta?: (delta: StreamDelta) => void,
): Promise<AssistantMessage> {
  let model = "";
  let text = "";
  let thinking = "";
  let stopReason: StopReason | undefined;
  let done = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const toolCalls = new Map<number, OpenAIToolCall>();
  const startedToolCalls = new Set<number>();

  for await (const event of events) {
    if (event.data === "[DONE]") {
      done = true;
      break;
    }

    const chunk: OpenAIChunk = JSON.parse(event.data);
    if (chunk.error) {
      throw new Error(`OpenAI 流式响应出错：${chunk.error.message}`);
    }
    if (chunk.model !== undefined) model = chunk.model;
    if (chunk.usage) {
      usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage.inputTokens = chunk.usage.prompt_tokens - usage.cacheReadTokens;
      const { prompt_tokens, completion_tokens, total_tokens } = chunk.usage;
      usage.outputTokens =
        total_tokens !== undefined && total_tokens - prompt_tokens > completion_tokens ? total_tokens - prompt_tokens : completion_tokens;
    }

    for (const choice of chunk.choices) {
      // 当前接口只返回一条消息，取 index 为 0 的候选。
      if (choice.index !== 0) continue;

      text += choice.delta.content ?? "";
      thinking += choice.delta.reasoning_content ?? "";
      if (choice.delta.content) onDelta?.({ type: "text", text: choice.delta.content });
      if (choice.delta.reasoning_content) onDelta?.({ type: "thinking", text: choice.delta.reasoning_content });
      for (const part of choice.delta.tool_calls ?? []) {
        const call: OpenAIToolCall = toolCalls.get(part.index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.id !== undefined) call.id = part.id;
        if (part.function?.name !== undefined) call.function.name = part.function.name;
        if (call.function.name !== "" && !startedToolCalls.has(part.index)) {
          startedToolCalls.add(part.index);
          onDelta?.({ type: "toolCallStart", id: call.id, name: call.function.name });
        }
        call.function.arguments += part.function?.arguments ?? "";
        toolCalls.set(part.index, call);
      }

      if (choice.finish_reason != null) {
        switch (choice.finish_reason) {
          case "stop":
            stopReason = "stop";
            break;
          case "tool_calls":
            stopReason = "toolUse";
            break;
          case "length":
            stopReason = "length";
            break;
          case "content_filter":
            stopReason = "refusal";
            break;
          default:
            throw new Error(`不支持的 finish_reason：${choice.finish_reason}`);
        }
      }
    }
  }

  if (!done) throw new Error("OpenAI 响应流在收到 [DONE] 前结束");
  if (stopReason === undefined) throw new Error("OpenAI 响应流缺少 finish_reason");

  const content: AssistantContent[] = [];
  if (thinking !== "") content.push({ type: "thinking", thinking });
  if (text !== "") content.push({ type: "text", text });
  for (const [, call] of [...toolCalls].sort(([a], [b]) => a - b)) {
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments === "" ? {} : JSON.parse(call.function.arguments);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`工具 ${call.function.name} 的参数不是合法 JSON：${message}`);
    }
    content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: args });
  }

  return { role: "assistant", content, stopReason, provider: PROVIDER_NAME, model, usage };
}

export class OpenAIProvider implements Provider {
  #options: OpenAIOptions;

  constructor(options: OpenAIOptions) {
    this.#options = options;
  }

  /**
   * POST {baseUrl}/chat/completions，请求头带 authorization: Bearer {apiKey} 和 content-type: application/json，
   * 请求体是 toOpenAIRequest 的结果。
   * apiKey 是函数时，每次请求前调用它取 key；返回 HTTP 401 时用 force 再取一次，重发一次。
   * HTTP 状态码不是 2xx 时抛异常，信息里带上状态码和响应正文；
   * options.signal 原样传给 fetch，用户中断时请求会立刻结束。
   * 否则用 parseSse 和 readOpenAIStream 把响应解析成 assistant 消息，provider 记为 name。
   */
  async complete(request: ModelRequest, options: CompleteOptions = {}): Promise<AssistantMessage> {
    const { apiKey, name = PROVIDER_NAME, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl = globalThis.fetch } = this.#options;
    const body = JSON.stringify(toOpenAIRequest(request, this.#options));
    const send = (key: string) =>
      fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body,
        signal: options.signal,
      });

    const keyOf = (force: boolean) =>
      typeof apiKey === "string" ? Promise.resolve(apiKey) : apiKey({ signal: options.signal, force });
    let response = await send(await keyOf(false));
    if (response.status === 401 && typeof apiKey !== "string") {
      await response.body?.cancel();
      response = await send(await keyOf(true));
    }

    if (!response.ok) {
      throw new Error(`OpenAI 请求失败（HTTP ${response.status}）：${await response.text()}`);
    }
    if (response.body === null) {
      throw new Error("OpenAI 响应缺少数据流");
    }

    const message = await readOpenAIStream(parseSse(response.body), options.onDelta);
    return name === PROVIDER_NAME ? message : { ...message, provider: name };
  }
}
