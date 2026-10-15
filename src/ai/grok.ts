import { randomUUID } from "node:crypto";
import { GrokAuth, type GrokAuthOptions } from "./grok-auth.ts";
import type { OpenAIChunk } from "./openai-types.ts";
import { readOpenAIStream, toOpenAIRequest } from "./openai.ts";
import { parseSse, type SseEvent } from "./sse.ts";
import type { AssistantMessage, CompleteOptions, ModelRequest, Provider, StreamDelta } from "./types.ts";

export const DEFAULT_MODEL = "grok-4.7";
export const DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

export interface GrokOptions extends GrokAuthOptions {
  model?: string;
  baseUrl?: string;
  reasoningEffort?: string;
  /** 只用于模型请求；登录凭据由 Grok CLI 管理，不经过原始响应保存。 */
  fetch?: typeof fetch;
}

/** Grok 的部分模型把推理 token 单列在总用量里，输出数需要包含它们。 */
async function* normalizeUsage(events: AsyncIterable<SseEvent>): AsyncGenerator<SseEvent> {
  for await (const event of events) {
    if (event.data === "[DONE]") {
      yield event;
      return;
    }
    const chunk = JSON.parse(event.data) as OpenAIChunk & { usage?: { total_tokens?: number } | null };
    if (chunk.usage?.total_tokens !== undefined) {
      const outputTokens = chunk.usage.total_tokens - chunk.usage.prompt_tokens;
      if (Number.isFinite(outputTokens) && outputTokens > chunk.usage.completion_tokens) {
        chunk.usage.completion_tokens = outputTokens;
      }
    }
    yield { ...event, data: JSON.stringify(chunk) };
  }
}

/** 复用 Chat Completions 的文字、推理和工具调用解析，消息来源标为 grok。 */
export async function readGrokStream(
  events: AsyncIterable<SseEvent>,
  onDelta?: (delta: StreamDelta) => void,
): Promise<AssistantMessage> {
  return { ...await readOpenAIStream(normalizeUsage(events), onDelta), provider: "grok" };
}

/** 使用 Grok Build 订阅登录直接调用模型，工具仍由本 harness 执行。 */
export class GrokProvider implements Provider {
  #options: GrokOptions;
  #auth: GrokAuth;
  #sessionId = randomUUID();

  constructor(options: GrokOptions = {}) {
    this.#options = options;
    this.#auth = new GrokAuth(options);
  }

  async complete(request: ModelRequest, options: CompleteOptions = {}): Promise<AssistantMessage> {
    const { model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL, reasoningEffort, fetch: fetchImpl = globalThis.fetch } = this.#options;
    const body = JSON.stringify(toOpenAIRequest(request, { model, reasoningEffort }));
    const send = (auth: { key: string; clientVersion: string }) => fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.key}`,
        "content-type": "application/json",
        "user-agent": "mini-harness",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": auth.clientVersion,
        "x-grok-client-identifier": "mini-harness",
        "x-grok-model-override": model,
        "x-grok-session-id": this.#sessionId,
        "x-grok-req-id": randomUUID(),
      },
      body,
      signal: options.signal,
      redirect: "error",
    });

    const auth = await this.#auth.credentials(options.signal);
    let response = await send(auth);
    if (response.status === 401) {
      await response.body?.cancel();
      response = await send(await this.#auth.credentials(options.signal, auth.key));
    }
    if (!response.ok) {
      throw new Error(`Grok 请求失败（HTTP ${response.status}）：${await response.text()}`);
    }
    if (response.body === null) throw new Error("Grok 响应缺少数据流");
    return readGrokStream(parseSse(response.body), options.onDelta);
  }
}
