import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  DEFAULT_MAX_TOKENS,
  readAnthropicStream,
  toAnthropicRequest,
  type AnthropicOptions,
} from "./anthropic.ts";
import { fakeReply, text, thinking, toolCall } from "./fake.ts";
import type { SseEvent } from "./sse.ts";
import type { AssistantMessage, Message, ModelRequest, Provider, StreamDelta, ToolDefinition, ToolResultMessage } from "./types.ts";

const MODEL = "claude-opus-5-5";
const OPTIONS: AnthropicOptions = { apiKey: "test-key", model: MODEL };

function request(messages: Message[], tools: ToolDefinition[] = []): ModelRequest {
  return { system: "你是测试助手", messages, tools };
}

function toolResult(toolCallId: string, content: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "echo", content, isError };
}

/** 一条来自 Anthropic 指定模型的 assistant 消息 */
function fromAnthropic(message: AssistantMessage, model = MODEL): AssistantMessage {
  return { ...message, provider: "anthropic", model };
}

const echoDef: ToolDefinition = {
  name: "echo",
  description: "原样返回 text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

describe("toAnthropicRequest", () => {
  test("基本字段：model、max_tokens、system、stream", () => {
    const body = toAnthropicRequest(request([{ role: "user", content: "hi" }]), OPTIONS);
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(body.stream, true);
    assert.equal(toAnthropicRequest(request([]), { ...OPTIONS, cache: false }).system, "你是测试助手");
    assert.equal(toAnthropicRequest(request([]), { ...OPTIONS, maxTokens: 1000 }).max_tokens, 1000);
  });

  test("工具定义的 parameters 放进 input_schema，没有工具时不带 tools", () => {
    const withTools = toAnthropicRequest(request([], [echoDef]), OPTIONS);
    assert.deepEqual(withTools.tools, [
      { name: "echo", description: "原样返回 text", input_schema: echoDef.parameters },
    ]);
    assert.equal("tools" in toAnthropicRequest(request([]), OPTIONS), false);
  });

  test("设置了 effort 才带 output_config", () => {
    assert.equal("output_config" in toAnthropicRequest(request([]), OPTIONS), false);
    assert.deepEqual(toAnthropicRequest(request([]), { ...OPTIONS, effort: "high" }).output_config, { effort: "high" });
  });

  test("用户消息原样转换", () => {
    const body = toAnthropicRequest(request([{ role: "user", content: "你好" }]), OPTIONS);
    assert.deepEqual(body.messages, [{ role: "user", content: "你好" }]);
  });

  test("assistant 的文本和工具调用转成 text 和 tool_use 块，空文本省略", () => {
    const assistant = fromAnthropic(fakeReply([text("我来看看"), text(""), toolCall("toolu_1", "echo", { text: "x" })]));
    const body = toAnthropicRequest(request([{ role: "user", content: "hi" }, assistant]), OPTIONS);
    assert.deepEqual(body.messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "我来看看" },
        { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "x" } },
      ],
    });
  });

  test("连续的工具结果合并成一条 user 消息，后面的用户消息单独一条", () => {
    const assistant = fromAnthropic(fakeReply([toolCall("a", "echo"), toolCall("b", "echo")]));
    const body = toAnthropicRequest(
      request([
        { role: "user", content: "go" },
        assistant,
        toolResult("a", "1"),
        toolResult("b", "出错了", true),
        { role: "user", content: "继续" },
      ]),
      OPTIONS,
    );
    assert.deepEqual(body.messages.slice(2), [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "1", is_error: false },
          { type: "tool_result", tool_use_id: "b", content: "出错了", is_error: true },
        ],
      },
      { role: "user", content: "继续" },
    ]);
  });

  test("同一模型的 thinking 块原样带回，包括空的思考内容", () => {
    const assistant = fromAnthropic(fakeReply([thinking("", "sig-1"), text("好")]));
    const body = toAnthropicRequest(request([{ role: "user", content: "hi" }, assistant]), OPTIONS);
    assert.deepEqual(body.messages[1], {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "text", text: "好" },
      ],
    });
  });

  test("换了模型、换了厂商或没有签名的 thinking 块省略", () => {
    const otherModel = fromAnthropic(fakeReply([thinking("a", "sig"), text("1")]), "claude-sonnet-5-5");
    const otherProvider = { ...fakeReply([thinking("b", "sig"), text("2")]), provider: "openai", model: MODEL };
    const noSignature = fromAnthropic(fakeReply([thinking("c"), text("3")]));
    const body = toAnthropicRequest(
      request([{ role: "user", content: "hi" }, otherModel, otherProvider, noSignature]),
      OPTIONS,
    );
    assert.deepEqual(
      body.messages.slice(1).map((m) => m.content),
      [[{ type: "text", text: "1" }], [{ type: "text", text: "2" }], [{ type: "text", text: "3" }]],
    );
  });

  test("转换后没有内容的 assistant 消息整条省略", () => {
    const onlyThinking = fromAnthropic(fakeReply([thinking("想了想", "sig")]), "claude-sonnet-5-5");
    const body = toAnthropicRequest(request([{ role: "user", content: "hi" }, onlyThinking]), OPTIONS);
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  });
});

describe("toAnthropicRequest 的提示缓存", () => {
  /** 一段包含各种消息的对话，用来确认缓存开关不影响消息转换 */
  function conversation(): Message[] {
    const assistant = fromAnthropic(fakeReply([thinking("想想", "sig"), text("我来看看"), toolCall("a", "echo", { text: "x" })]));
    return [{ role: "user", content: "go" }, assistant, toolResult("a", "1"), { role: "user", content: "继续" }];
  }

  test("默认开启：系统提示转成一个带缓存标记的文本块，请求顶层也带缓存标记", () => {
    const body = toAnthropicRequest(request([{ role: "user", content: "hi" }]), OPTIONS);
    assert.deepEqual(body.system, [{ type: "text", text: "你是测试助手", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(body.cache_control, { type: "ephemeral" });
    assert.deepEqual(toAnthropicRequest(request([{ role: "user", content: "hi" }]), { ...OPTIONS, cache: true }), body);
  });

  test("cache 为 false 时系统提示是字符串，请求里没有任何缓存标记", () => {
    const body = toAnthropicRequest(request(conversation(), [echoDef]), { ...OPTIONS, cache: false });
    assert.equal(body.system, "你是测试助手");
    assert.equal(JSON.stringify(body).includes("cache_control"), false);
  });

  test("系统提示为空时不带 system 字段，开启缓存时顶层仍带缓存标记", () => {
    const empty: ModelRequest = { ...request([{ role: "user", content: "hi" }]), system: "" };
    const cached = toAnthropicRequest(empty, OPTIONS);
    assert.equal("system" in cached, false);
    assert.deepEqual(cached.cache_control, { type: "ephemeral" });
    assert.equal("system" in toAnthropicRequest(empty, { ...OPTIONS, cache: false }), false);
  });

  test("缓存开关不影响消息和工具定义，消息里不加缓存标记", () => {
    const on = toAnthropicRequest(request(conversation(), [echoDef]), OPTIONS);
    const off = toAnthropicRequest(request(conversation(), [echoDef]), { ...OPTIONS, cache: false });
    assert.deepEqual(on.messages, off.messages);
    assert.deepEqual(on.tools, off.tools);
    assert.equal(JSON.stringify([on.messages, on.tools]).includes("cache_control"), false);
  });
});

/** 把事件对象转成 SseEvent，event 名和 data 里的 type 一致 */
function sse(data: { type: string } & Record<string, unknown>): SseEvent {
  return { event: data.type, data: JSON.stringify(data) };
}

async function* stream(events: SseEvent[]): AsyncGenerator<SseEvent> {
  yield* events;
}

const start = (usage?: Record<string, number | null>) =>
  sse({ type: "message_start", message: { id: "msg_1", model: MODEL, ...(usage && { usage }) } });
const blockStart = (index: number, content_block: Record<string, unknown>) =>
  sse({ type: "content_block_start", index, content_block });
const delta = (index: number, d: Record<string, unknown>) => sse({ type: "content_block_delta", index, delta: d });
const blockStop = (index: number) => sse({ type: "content_block_stop", index });
const messageDelta = (stop_reason: string, usage?: Record<string, number | null>) =>
  sse({ type: "message_delta", delta: { stop_reason }, ...(usage && { usage }) });
const stop = sse({ type: "message_stop" });

/** 只有一段文本的完整流 */
function textStream(stopReason: string): SseEvent[] {
  return [start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "ok" }), blockStop(0), messageDelta(stopReason), stop];
}

describe("readAnthropicStream", () => {
  test("拼接文本增量，填上 model、provider 和 usage", async () => {
    const message = await readAnthropicStream(
      stream([
        start({ input_tokens: 10, output_tokens: 1 }),
        blockStart(0, { type: "text", text: "" }),
        delta(0, { type: "text_delta", text: "你" }),
        delta(0, { type: "text_delta", text: "好" }),
        blockStop(0),
        messageDelta("end_turn", { output_tokens: 5 }),
        stop,
      ]),
    );
    assert.deepEqual(message, {
      role: "assistant",
      content: [text("你好")],
      stopReason: "stop",
      provider: "anthropic",
      model: MODEL,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  test("工具参数分几段到达，拼完整后解析", async () => {
    const message = await readAnthropicStream(
      stream([
        start(),
        blockStart(0, { type: "tool_use", id: "toolu_1", name: "read_file", input: {} }),
        delta(0, { type: "input_json_delta", partial_json: "" }),
        delta(0, { type: "input_json_delta", partial_json: '{"path":' }),
        delta(0, { type: "input_json_delta", partial_json: ' "a.txt"}' }),
        blockStop(0),
        messageDelta("tool_use"),
        stop,
      ]),
    );
    assert.deepEqual(message.content, [toolCall("toolu_1", "read_file", { path: "a.txt" })]);
    assert.equal(message.stopReason, "toolUse");
  });

  test("没有参数增量的工具调用，arguments 为空对象", async () => {
    const message = await readAnthropicStream(
      stream([start(), blockStart(0, { type: "tool_use", id: "t", name: "ls", input: {} }), blockStop(0), messageDelta("tool_use"), stop]),
    );
    assert.deepEqual(message.content, [toolCall("t", "ls", {})]);
  });

  test("thinking 的内容和签名", async () => {
    const message = await readAnthropicStream(
      stream([
        start(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "thinking_delta", thinking: "想" }),
        delta(0, { type: "thinking_delta", thinking: "一想" }),
        delta(0, { type: "signature_delta", signature: "sig-1" }),
        blockStop(0),
        messageDelta("end_turn"),
        stop,
      ]),
    );
    assert.deepEqual(message.content, [thinking("想一想", "sig-1")]);
  });

  test("多个内容块按 index 排列", async () => {
    const message = await readAnthropicStream(
      stream([
        start(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "signature_delta", signature: "s" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "先读文件" }),
        blockStop(1),
        blockStart(2, { type: "tool_use", id: "t1", name: "read_file", input: {} }),
        delta(2, { type: "input_json_delta", partial_json: '{"path":"x"}' }),
        blockStop(2),
        messageDelta("tool_use"),
        stop,
      ]),
    );
    assert.deepEqual(message.content, [thinking("", "s"), text("先读文件"), toolCall("t1", "read_file", { path: "x" })]);
  });

  test("忽略 ping、不认识的事件和不认识的内容块", async () => {
    const message = await readAnthropicStream(
      stream([
        start(),
        sse({ type: "ping" }),
        sse({ type: "some_future_event", foo: 1 }),
        blockStart(0, { type: "redacted_thinking", data: "xxx" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "hi" }),
        blockStop(1),
        messageDelta("end_turn"),
        stop,
      ]),
    );
    assert.deepEqual(message.content, [text("hi")]);
  });

  test("usage：message_delta 里出现的字段覆盖 message_start 的值", async () => {
    const message = await readAnthropicStream(
      stream([
        start({ input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
        messageDelta("end_turn", { output_tokens: 20 }),
        stop,
      ]),
    );
    assert.deepEqual(message.usage, { inputTokens: 3, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 50 });
  });

  test("usage：message_delta 里为 null 的字段不覆盖已有的值", async () => {
    const message = await readAnthropicStream(
      stream([
        start({ input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
        messageDelta("end_turn", {
          input_tokens: null,
          output_tokens: 20,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        }),
        stop,
      ]),
    );
    assert.deepEqual(message.usage, { inputTokens: 3, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 50 });
  });

  test("stop_reason 映射", async () => {
    const cases: [string, string][] = [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["tool_use", "toolUse"],
      ["max_tokens", "length"],
      ["model_context_window_exceeded", "length"],
      ["refusal", "refusal"],
    ];
    for (const [raw, expected] of cases) {
      const message = await readAnthropicStream(stream(textStream(raw)));
      assert.equal(message.stopReason, expected, raw);
    }
  });

  test("不认识的 stop_reason 抛异常", async () => {
    await assert.rejects(readAnthropicStream(stream(textStream("pause_turn"))), /pause_turn/);
  });

  test("收到 error 事件时抛异常，信息里有错误类型和内容", async () => {
    const events = [
      start(),
      blockStart(0, { type: "text", text: "" }),
      sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ];
    await assert.rejects(readAnthropicStream(stream(events)), /overloaded_error.*Overloaded|Overloaded.*overloaded_error/);
  });

  test("流在 message_stop 之前结束时抛异常，信息里提到 message_stop", async () => {
    const events = textStream("end_turn").slice(0, -1);
    await assert.rejects(readAnthropicStream(stream(events)), /message_stop/);
  });
});

describe("AnthropicProvider", () => {
  /** 记录请求并返回固定响应的假 fetch */
  function fakeFetch(response: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response();
    };
    return { fn, calls };
  }

  function sseResponse(events: SseEvent[]): Response {
    const body = events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  test("发出的请求：地址、请求头和请求体", async () => {
    const fetch = fakeFetch(() => sseResponse(textStream("end_turn")));
    const provider = new AnthropicProvider({ ...OPTIONS, fetch: fetch.fn });
    const req = request([{ role: "user", content: "hi" }], [echoDef]);
    await provider.complete(req);

    assert.equal(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0]!;
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-api-key"), "test-key");
    assert.equal(headers.get("anthropic-version"), ANTHROPIC_VERSION);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), toAnthropicRequest(req, OPTIONS));
  });

  test("中止信号原样传给 fetch", async () => {
    const fetch = fakeFetch(() => sseResponse(textStream("end_turn")));
    // 按 Provider 接口调用，complete 的第二个参数是接口规定的
    const provider: Provider = new AnthropicProvider({ ...OPTIONS, fetch: fetch.fn });
    const controller = new AbortController();
    await provider.complete(request([{ role: "user", content: "hi" }]), { signal: controller.signal });
    assert.equal(fetch.calls[0]!.init.signal, controller.signal);
  });

  test("baseUrl 可以修改", async () => {
    const fetch = fakeFetch(() => sseResponse(textStream("end_turn")));
    const provider = new AnthropicProvider({ ...OPTIONS, baseUrl: "http://127.0.0.1:8080/v1", fetch: fetch.fn });
    await provider.complete(request([{ role: "user", content: "hi" }]));
    assert.equal(fetch.calls[0]!.url, "http://127.0.0.1:8080/v1/messages");
  });

  test("把流式响应解析成 assistant 消息", async () => {
    const fetch = fakeFetch(() => sseResponse(textStream("end_turn")));
    const provider = new AnthropicProvider({ ...OPTIONS, fetch: fetch.fn });
    const message = await provider.complete(request([{ role: "user", content: "hi" }]));
    assert.deepEqual(message.content, [text("ok")]);
    assert.equal(message.stopReason, "stop");
  });

  test("HTTP 出错时抛异常，信息里有状态码和响应正文", async () => {
    const errorBody = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const fetch = fakeFetch(() => new Response(errorBody, { status: 401 }));
    const provider = new AnthropicProvider({ ...OPTIONS, fetch: fetch.fn });
    await assert.rejects(provider.complete(request([{ role: "user", content: "hi" }])), (err: Error) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /invalid x-api-key/);
      return true;
    });
  });
});

/** 收集 onDelta 收到的增量 */
function collector() {
  const deltas: StreamDelta[] = [];
  return { deltas, onDelta: (delta: StreamDelta) => void deltas.push(delta) };
}

describe("readAnthropicStream 的增量", () => {
  test("text_delta 按顺序发出 text 增量，完整消息不受影响", async () => {
    const { deltas, onDelta } = collector();
    const message = await readAnthropicStream(
      stream([
        start(),
        blockStart(0, { type: "text", text: "" }),
        delta(0, { type: "text_delta", text: "" }),
        delta(0, { type: "text_delta", text: "你" }),
        delta(0, { type: "text_delta", text: "好" }),
        blockStop(0),
        messageDelta("end_turn"),
        stop,
      ]),
      onDelta,
    );
    assert.deepEqual(deltas, [
      { type: "text", text: "你" },
      { type: "text", text: "好" },
    ]);
    assert.deepEqual(message.content, [text("你好")]);
  });

  test("thinking_delta 发出 thinking 增量，签名不算增量", async () => {
    const { deltas, onDelta } = collector();
    await readAnthropicStream(
      stream([
        start(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "thinking_delta", thinking: "" }),
        delta(0, { type: "thinking_delta", thinking: "想" }),
        delta(0, { type: "thinking_delta", thinking: "一想" }),
        delta(0, { type: "signature_delta", signature: "sig" }),
        blockStop(0),
        messageDelta("end_turn"),
        stop,
      ]),
      onDelta,
    );
    assert.deepEqual(deltas, [
      { type: "thinking", text: "想" },
      { type: "thinking", text: "一想" },
    ]);
  });

  test("tool_use 块开始时发出 toolCallStart，参数片段不发；多种块按到达顺序", async () => {
    const { deltas, onDelta } = collector();
    const message = await readAnthropicStream(
      stream([
        start(),
        blockStart(0, { type: "text", text: "" }),
        delta(0, { type: "text_delta", text: "先读文件" }),
        blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_1", name: "read_file", input: {} }),
        delta(1, { type: "input_json_delta", partial_json: '{"path":' }),
        delta(1, { type: "input_json_delta", partial_json: '"a.txt"}' }),
        blockStop(1),
        messageDelta("tool_use"),
        stop,
      ]),
      onDelta,
    );
    assert.deepEqual(deltas, [
      { type: "text", text: "先读文件" },
      { type: "toolCallStart", id: "toolu_1", name: "read_file" },
    ]);
    assert.deepEqual(message.content, [text("先读文件"), toolCall("toolu_1", "read_file", { path: "a.txt" })]);
  });

  test("不传 onDelta 时照常工作", async () => {
    const message = await readAnthropicStream(stream(textStream("end_turn")));
    assert.deepEqual(message.content, [text("ok")]);
  });

  test("complete 把 onDelta 传给解析函数", async () => {
    const events = textStream("end_turn");
    const fetch: typeof globalThis.fetch = async () =>
      new Response(events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join(""), { status: 200 });
    const provider: Provider = new AnthropicProvider({ ...OPTIONS, fetch });
    const { deltas, onDelta } = collector();
    await provider.complete(request([{ role: "user", content: "hi" }]), { onDelta });
    assert.deepEqual(deltas, [{ type: "text", text: "ok" }]);
  });
});
