import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakeReply, text, thinking, toolCall } from "./fake.ts";
import { OpenAIProvider, readOpenAIStream, toOpenAIRequest, type OpenAIOptions } from "./openai.ts";
import type { SseEvent } from "./sse.ts";
import type { Message, ModelRequest, Provider, StreamDelta, ToolDefinition, ToolResultMessage } from "./types.ts";

const MODEL = "gpt-test";
const OPTIONS: OpenAIOptions = { apiKey: "test-key", model: MODEL };

function request(messages: Message[], tools: ToolDefinition[] = []): ModelRequest {
  return { system: "你是测试助手", messages, tools };
}

function toolResult(toolCallId: string, content: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "echo", content, isError };
}

const echoDef: ToolDefinition = {
  name: "echo",
  description: "原样返回 text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

describe("toOpenAIRequest", () => {
  test("基本字段：model、system 消息、stream 和 stream_options", () => {
    const body = toOpenAIRequest(request([{ role: "user", content: "hi" }]), OPTIONS);
    assert.equal(body.model, MODEL);
    assert.deepEqual(body.messages[0], { role: "system", content: "你是测试助手" });
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("设置了 maxTokens、reasoningEffort 才带对应字段", () => {
    const plain = toOpenAIRequest(request([]), OPTIONS);
    assert.equal("max_completion_tokens" in plain, false);
    assert.equal("reasoning_effort" in plain, false);
    const full = toOpenAIRequest(request([]), { ...OPTIONS, maxTokens: 1000, reasoningEffort: "high" });
    assert.equal(full.max_completion_tokens, 1000);
    assert.equal(full.reasoning_effort, "high");
  });

  test("工具定义转成 function 格式，没有工具时不带 tools", () => {
    const withTools = toOpenAIRequest(request([], [echoDef]), OPTIONS);
    assert.deepEqual(withTools.tools, [
      { type: "function", function: { name: "echo", description: "原样返回 text", parameters: echoDef.parameters } },
    ]);
    assert.equal("tools" in toOpenAIRequest(request([]), OPTIONS), false);
  });

  test("用户消息原样转换", () => {
    const body = toOpenAIRequest(request([{ role: "user", content: "你好" }]), OPTIONS);
    assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "你好" }]);
  });

  test("assistant 的文字连成 content，工具调用转成 tool_calls，thinking 丢掉", () => {
    const assistant = fakeReply([
      thinking("想一想", "sig"),
      text("第一段"),
      text(""),
      text("第二段"),
      toolCall("call_1", "echo", { text: "x" }),
    ]);
    const body = toOpenAIRequest(request([{ role: "user", content: "hi" }, assistant]), OPTIONS);
    assert.deepEqual(body.messages[2], {
      role: "assistant",
      content: "第一段\n第二段",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"text":"x"}' } }],
    });
  });

  test("只有工具调用时 content 为 null；只有文字时不带 tool_calls", () => {
    const onlyCall = fakeReply([toolCall("call_1", "echo")]);
    const onlyText = fakeReply([text("好")]);
    const body = toOpenAIRequest(request([{ role: "user", content: "hi" }, onlyCall, toolResult("call_1", "ok"), onlyText]), OPTIONS);
    assert.deepEqual(body.messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }],
    });
    assert.deepEqual(body.messages[4], { role: "assistant", content: "好" });
  });

  test("每个工具结果单独一条 tool 消息，出错的结果前面加上「错误：」", () => {
    const assistant = fakeReply([toolCall("a", "echo"), toolCall("b", "echo")]);
    const body = toOpenAIRequest(
      request([{ role: "user", content: "go" }, assistant, toolResult("a", "1"), toolResult("b", "出错了", true)]),
      OPTIONS,
    );
    assert.deepEqual(body.messages.slice(3), [
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "错误：出错了" },
    ]);
  });

  test("既没有文字也没有工具调用的 assistant 消息整条省略", () => {
    const onlyThinking = fakeReply([thinking("想了想", "sig")]);
    const body = toOpenAIRequest(request([{ role: "user", content: "hi" }, onlyThinking]), OPTIONS);
    assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "hi" }]);
  });
});

/** 一个 OpenAI 数据块对应的 SseEvent，没有 event 行，所以 event 是默认的 "message" */
function chunk(data: Record<string, unknown>): SseEvent {
  return { event: "message", data: JSON.stringify({ id: "chatcmpl-1", model: MODEL, ...data }) };
}

const DONE: SseEvent = { event: "message", data: "[DONE]" };

function delta(d: Record<string, unknown>, finish_reason: string | null = null): SseEvent {
  return chunk({ choices: [{ index: 0, delta: d, finish_reason }] });
}

function finish(reason: string): SseEvent {
  return delta({}, reason);
}

function usage(prompt_tokens: number, completion_tokens: number, cached_tokens?: number): SseEvent {
  return chunk({
    choices: [],
    usage: { prompt_tokens, completion_tokens, ...(cached_tokens !== undefined && { prompt_tokens_details: { cached_tokens } }) },
  });
}

async function* stream(events: SseEvent[]): AsyncGenerator<SseEvent> {
  yield* events;
}

describe("readOpenAIStream", () => {
  test("拼接文字，填上 model、provider 和 usage（输入数扣掉缓存部分）", async () => {
    const message = await readOpenAIStream(
      stream([
        delta({ role: "assistant", content: "" }),
        delta({ content: "你" }),
        delta({ content: "好" }),
        finish("stop"),
        usage(100, 5, 80),
        DONE,
      ]),
    );
    assert.deepEqual(message, {
      role: "assistant",
      content: [text("你好")],
      stopReason: "stop",
      provider: "openai",
      model: MODEL,
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0 },
    });
  });

  test("多个工具调用的片段按 index 归类，文字排在工具调用前面", async () => {
    const message = await readOpenAIStream(
      stream([
        delta({ content: "我读两个文件" }),
        delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: 'th":"b.txt"}' } }] }),
        finish("tool_calls"),
        DONE,
      ]),
    );
    assert.deepEqual(message.content, [
      text("我读两个文件"),
      toolCall("call_a", "read_file", { path: "a.txt" }),
      toolCall("call_b", "read_file", { path: "b.txt" }),
    ]);
    assert.equal(message.stopReason, "toolUse");
  });

  test("没有参数的工具调用，arguments 为空对象", async () => {
    const message = await readOpenAIStream(
      stream([delta({ tool_calls: [{ index: 0, id: "c", function: { name: "ls" } }] }), finish("tool_calls"), DONE]),
    );
    assert.deepEqual(message.content, [toolCall("c", "ls", {})]);
  });

  test("工具参数不是合法 JSON 时抛异常，信息里有工具名", async () => {
    const events = [
      delta({ tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: '{"path":' } }] }),
      finish("tool_calls"),
      DONE,
    ];
    await assert.rejects(readOpenAIStream(stream(events)), /read_file/);
  });

  test("reasoning_content 拼成没有签名的 thinking 块，排在最前面", async () => {
    const message = await readOpenAIStream(
      stream([
        delta({ reasoning_content: "先想" }),
        delta({ reasoning_content: "一想" }),
        delta({ content: "答案" }),
        finish("stop"),
        DONE,
      ]),
    );
    assert.deepEqual(message.content, [thinking("先想一想"), text("答案")]);
  });

  test("finish_reason 映射", async () => {
    const cases: [string, string][] = [
      ["stop", "stop"],
      ["tool_calls", "toolUse"],
      ["length", "length"],
      ["content_filter", "refusal"],
    ];
    for (const [raw, expected] of cases) {
      const message = await readOpenAIStream(stream([delta({ content: "x" }), finish(raw), DONE]));
      assert.equal(message.stopReason, expected, raw);
    }
  });

  test("不认识的 finish_reason 抛异常", async () => {
    await assert.rejects(readOpenAIStream(stream([finish("function_call"), DONE])), /function_call/);
  });

  test("兼容服务用空字符串表示还没结束，finish_reason 为 \"\" 时跳过", { todo: "公司网关的格式差异，接回公司网关时再处理" }, async () => {
    const message = await readOpenAIStream(stream([delta({ content: "hi" }, ""), delta({ content: "!" }, ""), finish("stop"), DONE]));
    assert.deepEqual(message.content, [text("hi!")]);
    assert.equal(message.stopReason, "stop");
  });

  test("后续片段里为空字符串的 id 和 name 不覆盖第一片的值", { todo: "公司网关的格式差异，接回公司网关时再处理" }, async () => {
    const message = await readOpenAIStream(
      stream([
        delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] }, ""),
        delta({ tool_calls: [{ index: 0, id: "", function: { name: "", arguments: '{"path":"a.txt"}' } }] }, ""),
        finish("tool_calls"),
        DONE,
      ]),
    );
    assert.deepEqual(message.content, [toolCall("call_1", "read_file", { path: "a.txt" })]);
  });

  test("finish_reason 为 error 时抛异常，信息里带上这个数据块的原始内容", { todo: "公司网关的格式差异，接回公司网关时再处理" }, async () => {
    // 不同服务把错误详情放在不同字段里，带上原始数据块最方便排查
    await assert.rejects(readOpenAIStream(stream([delta({ content: "" }, "error"), DONE])), /error[\s\S]*chatcmpl-1/);
  });

  test("没有 usage 数据块时用量全部为 0", async () => {
    const message = await readOpenAIStream(stream([delta({ content: "x" }), finish("stop"), DONE]));
    assert.deepEqual(message.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("收到 [DONE] 之后的数据忽略", async () => {
    const message = await readOpenAIStream(stream([delta({ content: "x" }), finish("stop"), DONE, delta({ content: "y" })]));
    assert.deepEqual(message.content, [text("x")]);
  });

  test("数据块里有 error 字段时抛异常", async () => {
    const events = [delta({ content: "x" }), chunk({ choices: [], error: { message: "Rate limit reached" } })];
    await assert.rejects(readOpenAIStream(stream(events)), /Rate limit reached/);
  });

  test("没收到 [DONE] 就结束时抛异常，信息里提到 [DONE]", async () => {
    await assert.rejects(readOpenAIStream(stream([delta({ content: "x" }), finish("stop")])), /\[DONE\]/);
  });

  test("从没拿到 finish_reason 时抛异常", async () => {
    await assert.rejects(readOpenAIStream(stream([delta({ content: "x" }), DONE])));
  });
});

describe("OpenAIProvider", () => {
  function fakeFetch(response: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response();
    };
    return { fn, calls };
  }

  function sseResponse(events: SseEvent[]): Response {
    const body = events.map((e) => `data: ${e.data}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  const okStream = () => sseResponse([delta({ content: "ok" }), finish("stop"), DONE]);

  test("发出的请求：地址、请求头和请求体", async () => {
    const fetch = fakeFetch(okStream);
    const provider = new OpenAIProvider({ ...OPTIONS, fetch: fetch.fn });
    const req = request([{ role: "user", content: "hi" }], [echoDef]);
    await provider.complete(req);

    assert.equal(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0]!;
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key");
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), toOpenAIRequest(req, OPTIONS));
  });

  test("中止信号原样传给 fetch", async () => {
    const fetch = fakeFetch(() => okStream());
    // 按 Provider 接口调用，complete 的第二个参数是接口规定的
    const provider: Provider = new OpenAIProvider({ ...OPTIONS, fetch: fetch.fn });
    const controller = new AbortController();
    await provider.complete(request([{ role: "user", content: "hi" }]), { signal: controller.signal });
    assert.equal(fetch.calls[0]!.init.signal, controller.signal);
  });

  test("baseUrl 可以修改", async () => {
    const fetch = fakeFetch(okStream);
    const provider = new OpenAIProvider({ ...OPTIONS, baseUrl: "http://localhost:11434/v1", fetch: fetch.fn });
    await provider.complete(request([{ role: "user", content: "hi" }]));
    assert.equal(fetch.calls[0]!.url, "http://localhost:11434/v1/chat/completions");
  });

  test("把流式响应解析成 assistant 消息", async () => {
    const fetch = fakeFetch(okStream);
    const provider = new OpenAIProvider({ ...OPTIONS, fetch: fetch.fn });
    const message = await provider.complete(request([{ role: "user", content: "hi" }]));
    assert.deepEqual(message.content, [text("ok")]);
  });

  test("HTTP 出错时抛异常，信息里有状态码和响应正文", async () => {
    const errorBody = JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
    const fetch = fakeFetch(() => new Response(errorBody, { status: 401 }));
    const provider = new OpenAIProvider({ ...OPTIONS, fetch: fetch.fn });
    await assert.rejects(provider.complete(request([{ role: "user", content: "hi" }])), (err: Error) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /Incorrect API key/);
      return true;
    });
  });
});

/** 收集 onDelta 收到的增量 */
function collector() {
  const deltas: StreamDelta[] = [];
  return { deltas, onDelta: (delta: StreamDelta) => void deltas.push(delta) };
}

describe("readOpenAIStream 的增量", () => {
  test("content 按顺序发出 text 增量，完整消息不受影响", async () => {
    const { deltas, onDelta } = collector();
    const message = await readOpenAIStream(stream([delta({ content: "你" }), delta({ content: "好" }), finish("stop"), DONE]), onDelta);
    assert.deepEqual(deltas, [
      { type: "text", text: "你" },
      { type: "text", text: "好" },
    ]);
    assert.deepEqual(message.content, [text("你好")]);
  });

  test("reasoning_content 发出 thinking 增量，和文字按到达顺序", async () => {
    const { deltas, onDelta } = collector();
    await readOpenAIStream(
      stream([delta({ reasoning_content: "先想" }), delta({ reasoning_content: "一想" }), delta({ content: "答案" }), finish("stop"), DONE]),
      onDelta,
    );
    assert.deepEqual(deltas, [
      { type: "thinking", text: "先想" },
      { type: "thinking", text: "一想" },
      { type: "text", text: "答案" },
    ]);
  });

  test("每个工具调用只在第一次拿到名字时发一次 toolCallStart，参数片段不发", async () => {
    const { deltas, onDelta } = collector();
    await readOpenAIStream(
      stream([
        delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }),
        // 有的服务会在后面的片段里重复带上名字，也不能再发一次
        delta({ tool_calls: [{ index: 1, function: { name: "read_file", arguments: 'th":"b.txt"}' } }] }),
        finish("tool_calls"),
        DONE,
      ]),
      onDelta,
    );
    assert.deepEqual(deltas, [
      { type: "toolCallStart", id: "call_a", name: "read_file" },
      { type: "toolCallStart", id: "call_b", name: "read_file" },
    ]);
  });

  test("空字符串和 null 的 content 不发增量", async () => {
    const { deltas, onDelta } = collector();
    await readOpenAIStream(
      stream([delta({ role: "assistant", content: "" }), delta({ content: null }), delta({ content: "x" }), finish("stop"), DONE]),
      onDelta,
    );
    assert.deepEqual(deltas, [{ type: "text", text: "x" }]);
  });

  test("complete 把 onDelta 传给解析函数", async () => {
    const events = [delta({ content: "ok" }), finish("stop"), DONE];
    const fetch: typeof globalThis.fetch = async () =>
      new Response(events.map((e) => `data: ${e.data}\n\n`).join(""), { status: 200 });
    const provider: Provider = new OpenAIProvider({ ...OPTIONS, fetch });
    const { deltas, onDelta } = collector();
    await provider.complete(request([{ role: "user", content: "hi" }]), { onDelta });
    assert.deepEqual(deltas, [{ type: "text", text: "ok" }]);
  });
});
