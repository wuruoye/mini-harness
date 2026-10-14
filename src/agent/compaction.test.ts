import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, fakeReply, text, thinking, toolCall } from "../ai/fake.ts";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../ai/types.ts";
import {
  buildContext,
  compact,
  contextTokens,
  estimateMessageTokens,
  estimateTokens,
  findCutIndex,
  MAX_TOOL_RESULT_CHARS,
  serializeForSummary,
  summarize,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_PREFIX,
  SUMMARY_SYSTEM_PROMPT,
  type Compaction,
} from "./compaction.ts";

/** n 个 token 的文字：每 4 个英文字母算 1 个 token */
const tokens = (n: number) => "a".repeat(n * 4);
const user = (content: string): UserMessage => ({ role: "user", content });
const reply = (content: string): AssistantMessage => fakeReply([text(content)]);
const result = (content: string): ToolResultMessage => ({ role: "toolResult", toolCallId: "1", toolName: "read_file", content, isError: false });
const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe("estimateTokens", () => {
  test("英文字符每 4 个算 1 个，向上取整", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("ab\ncd"), 2);
  });

  test("中日韩字符和全角标点每个算 1 个", () => {
    assert.equal(estimateTokens("你好"), 2);
    assert.equal(estimateTokens("你好abcde"), 4);
    assert.equal(estimateTokens("こんにちは"), 5);
    assert.equal(estimateTokens("안녕"), 2);
    assert.equal(estimateTokens("，。"), 2);
  });
});

describe("estimateMessageTokens", () => {
  test("各种消息", () => {
    assert.equal(estimateMessageTokens(user("abcd")), 1);
    assert.equal(estimateMessageTokens(result("abcdefgh")), 2);
    // "abcd" + "abcd" + "echo" + '{"a":1}' 共 19 个字符
    const assistant = fakeReply([text("abcd"), thinking("abcd", "sig"), toolCall("1", "echo", { a: 1 })]);
    assert.equal(estimateMessageTokens(assistant), 5);
  });
});

describe("contextTokens", () => {
  test("没有 usage 时全部估算", () => {
    assert.equal(contextTokens([user(tokens(100)), reply(tokens(100))]), 200);
  });

  test("用最后一条带 usage 的 assistant 消息，再加上它后面的估算值", () => {
    const older = { ...reply(tokens(10)), usage: usage(999) };
    const latest = { ...reply(tokens(10)), usage: { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, outputTokens: 50 } };
    const messages: Message[] = [user(tokens(10)), older, user(tokens(10)), latest, user(tokens(100)), reply(tokens(30))];
    assert.equal(contextTokens(messages), 1750 + 100 + 30);
  });

  test("usage 全是 0 时当作没有，用估算值", () => {
    const zero = { ...reply(tokens(100)), usage: usage(0) };
    assert.equal(contextTokens([user(tokens(100)), zero, user(tokens(50))]), 250);
  });
});

describe("findCutIndex", () => {
  // 每条 100 个 token：0 用户、1 助手、2 用户、3 助手、4 工具结果、5 用户、6 助手
  const messages: Message[] = [
    user(tokens(100)),
    reply(tokens(100)),
    user(tokens(100)),
    reply(tokens(100)),
    result(tokens(100)),
    user(tokens(100)),
    reply(tokens(100)),
  ];

  test("选保留部分不超过 keepTokens 的最靠前的用户消息", () => {
    assert.equal(findCutIndex(messages, 250), 5);
    assert.equal(findCutIndex(messages, 500), 2);
    assert.equal(findCutIndex(messages, 600), 2);
  });

  test("都超过时保留最近一轮", () => {
    assert.equal(findCutIndex(messages, 50), 5);
  });

  test("没有可以压缩的内容时返回 undefined", () => {
    assert.equal(findCutIndex(messages, 10_000), undefined);
    assert.equal(findCutIndex([user("a"), reply("b")], 1), undefined);
    assert.equal(findCutIndex([reply("a"), result("b")], 1), undefined);
    assert.equal(findCutIndex([], 1), undefined);
  });
});

describe("serializeForSummary", () => {
  test("转成文字记录，不包括 thinking，长的工具结果截断", () => {
    const long = "x".repeat(MAX_TOOL_RESULT_CHARS + 10);
    const transcript = serializeForSummary([
      user("读一下 a.txt"),
      fakeReply([thinking("想一想", "sig"), text("好的"), toolCall("1", "read_file", { path: "a.txt" })]),
      { ...result(long), isError: true },
    ]);
    assert.equal(
      transcript,
      `[用户]\n读一下 a.txt\n\n[助手]\n好的\n\n[助手调用工具] read_file {"path":"a.txt"}\n\n` +
        `[工具结果] read_file（出错）\n${"x".repeat(MAX_TOOL_RESULT_CHARS)}\n…（省略 10 个字符）`,
    );
  });
});

describe("summarize", () => {
  const messages: Message[] = [user("做个计算器"), reply("好的")];

  test("请求的格式", async () => {
    const provider = new FakeProvider([fakeReply([text("  ## 目标\n计算器  ")])]);
    const summary = await summarize(provider, messages);

    assert.equal(summary, "## 目标\n计算器");
    const request = provider.requests[0]!;
    assert.equal(request.system, SUMMARY_SYSTEM_PROMPT);
    assert.deepEqual(request.tools, []);
    assert.deepEqual(request.messages, [
      user(`需要总结的对话记录：\n${serializeForSummary(messages)}\n\n${SUMMARY_INSTRUCTIONS}`),
    ]);
  });

  test("有之前的摘要时放在最前面", async () => {
    const provider = new FakeProvider([fakeReply([text("新摘要")])]);
    await summarize(provider, messages, "旧摘要");
    assert.deepEqual(provider.requests[0]!.messages, [
      user(`之前的摘要：\n旧摘要\n\n需要总结的对话记录：\n${serializeForSummary(messages)}\n\n${SUMMARY_INSTRUCTIONS}`),
    ]);
  });

  test("多个文字块拼起来；没有文字时抛异常", async () => {
    const provider = new FakeProvider([fakeReply([text("第一段"), text("第二段")]), fakeReply([text("   ")])]);
    assert.equal(await summarize(provider, messages), "第一段第二段");
    await assert.rejects(summarize(provider, messages));
  });
});

describe("buildContext", () => {
  const withThinking = (content: string): AssistantMessage => ({
    ...fakeReply([thinking("想", "sig"), text(content)]),
    usage: usage(5000),
  });
  const messages: Message[] = [user("u0"), withThinking("a1"), user("u2"), withThinking("a3"), user("u4"), withThinking("a5")];
  const compaction: Compaction = { summary: "摘要", firstKeptIndex: 2, messageCount: 4, tokensBefore: 0 };

  test("没有压缩记录时返回拷贝", () => {
    const context = buildContext(messages, undefined);
    assert.deepEqual(context, messages);
    assert.notEqual(context, messages);
  });

  test("摘要放在最前面，压缩前产生的 assistant 消息去掉 thinking 和 usage，之后的原样保留", () => {
    const { usage: _unused, ...a3WithoutUsage } = withThinking("a3");
    assert.deepEqual(buildContext(messages, compaction), [
      user(`${SUMMARY_PREFIX}\n\n摘要`),
      user("u2"),
      { ...a3WithoutUsage, content: [text("a3")] },
      user("u4"),
      withThinking("a5"),
    ]);
  });

  test("不修改传入的消息", () => {
    const before = structuredClone(messages);
    buildContext(messages, compaction);
    assert.deepEqual(messages, before);
  });
});

describe("compact", () => {
  // 每条 100 个 token
  const conversation = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? user(`u${i} ${tokens(99)}`) : reply(`a${i} ${tokens(99)}`)));

  test("第一次压缩：总结切分点之前的消息", async () => {
    const messages = conversation(6);
    const provider = new FakeProvider([fakeReply([text("摘要一")])]);
    const result = await compact(provider, messages, undefined, 250);

    assert.deepEqual(result, {
      summary: "摘要一",
      firstKeptIndex: 4,
      messageCount: 6,
      tokensBefore: contextTokens(messages),
    });
    const content = provider.requests[0]!.messages[0]!.content;
    assert.equal(content, `需要总结的对话记录：\n${serializeForSummary(messages.slice(0, 4))}\n\n${SUMMARY_INSTRUCTIONS}`);
  });

  test("再次压缩：带上之前的摘要，下标换算回完整消息", async () => {
    const messages = conversation(8);
    const current: Compaction = { summary: "旧摘要", firstKeptIndex: 2, messageCount: 4, tokensBefore: 0 };
    const provider = new FakeProvider([fakeReply([text("摘要二")])]);
    const result = await compact(provider, messages, current, 250);

    // 上下文是 [摘要, u2, a3, u4, a5, u6, a7]，在上下文里切在 u6（下标 5），对应完整消息的下标 6
    assert.deepEqual(result, {
      summary: "摘要二",
      firstKeptIndex: 6,
      messageCount: 8,
      tokensBefore: contextTokens(buildContext(messages, current)),
    });
    const content = provider.requests[0]!.messages[0]!.content;
    assert.equal(
      content,
      `之前的摘要：\n旧摘要\n\n需要总结的对话记录：\n${serializeForSummary(messages.slice(2, 6))}\n\n${SUMMARY_INSTRUCTIONS}`,
    );
  });

  test("没有可以压缩的内容时返回 undefined，不请求模型", async () => {
    const provider = new FakeProvider([]);
    assert.equal(await compact(provider, conversation(4), undefined, 10_000), undefined);

    // 上下文是 [摘要, u2, a3]，切分点只能在 u2，摘要后面没有可以总结的消息
    const current: Compaction = { summary: "旧摘要", firstKeptIndex: 2, messageCount: 4, tokensBefore: 0 };
    assert.equal(await compact(provider, conversation(4), current, 10), undefined);
    assert.equal(provider.requests.length, 0);
  });
});
