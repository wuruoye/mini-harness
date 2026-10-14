import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, fakeReply, text, thinking, toolCall } from "../ai/fake.ts";
import type { Message, ToolCallBlock, ToolResultMessage, UserMessage } from "../ai/types.ts";
import { runAgent } from "./loop.ts";
import type { AgentEvent, AgentOptions, PermissionDecision, Tool, ToolContext } from "./types.ts";

function user(content: string): UserMessage {
  return { role: "user", content };
}

function toolResult(toolCallId: string, toolName: string, content: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError };
}

/** 把参数 text 原样返回 */
const echoTool: Tool = {
  definition: {
    name: "echo",
    description: "原样返回 text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  async execute(args) {
    return { content: String(args.text) };
  },
};

/** 总是抛异常 */
const failingTool: Tool = {
  definition: { name: "fail", description: "总是失败", parameters: { type: "object", properties: {} } },
  async execute() {
    throw new Error("磁盘满了");
  },
};

function options(provider: FakeProvider, extra: Partial<AgentOptions> = {}): AgentOptions {
  return { provider, system: "你是测试助手", tools: [echoTool, failingTool], cwd: "/work", ...extra };
}

test("模型不调用工具时，请求一次就结束", async () => {
  const final = fakeReply([text("你好")]);
  const provider = new FakeProvider([final]);
  const result = await runAgent([user("hi")], options(provider));

  assert.equal(provider.requests.length, 1);
  assert.deepEqual(result.messages, [user("hi"), final]);
  assert.equal(result.stopReason, "stop");
});

test("请求里带上 system、全部工具定义和历史", async () => {
  const provider = new FakeProvider([fakeReply([text("ok")])]);
  const history: Message[] = [user("第一句"), fakeReply([text("回答")]), user("第二句")];
  await runAgent(history, options(provider));

  const request = provider.requests[0]!;
  assert.equal(request.system, "你是测试助手");
  assert.deepEqual(request.tools, [echoTool.definition, failingTool.definition]);
  assert.deepEqual(request.messages, history);
});

test("执行工具后把结果交回模型，直到模型不再调用工具", async () => {
  const first = fakeReply([
    thinking("先调用 echo 看看", "sig-1"),
    text("我来调用 echo"),
    toolCall("call_1", "echo", { text: "pong" }),
  ]);
  const final = fakeReply([text("拿到了 pong")]);
  const provider = new FakeProvider([first, final]);
  const result = await runAgent([user("ping")], options(provider));

  const afterTool = [user("ping"), first, toolResult("call_1", "echo", "pong")];
  assert.equal(provider.requests.length, 2);
  // 第二次请求里，assistant 消息原样保留（包括 thinking 块和签名），后面跟着工具结果
  assert.deepEqual(provider.requests[1]!.messages, afterTool);
  assert.deepEqual(result.messages, [...afterTool, final]);
  assert.equal(result.stopReason, "stop");
});

test("一轮里的多个工具调用按顺序执行，全部结果加进历史后才请求下一次", async () => {
  const first = fakeReply([toolCall("a", "echo", { text: "1" }), toolCall("b", "echo", { text: "2" })]);
  const provider = new FakeProvider([first, fakeReply([text("done")])]);
  await runAgent([user("go")], options(provider));

  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1]!.messages.slice(2), [
    toolResult("a", "echo", "1"),
    toolResult("b", "echo", "2"),
  ]);
});

test("找不到工具时返回错误结果，循环继续", async () => {
  const provider = new FakeProvider([fakeReply([toolCall("c1", "no_such_tool")]), fakeReply([text("好吧")])]);
  const result = await runAgent([user("x")], options(provider));

  const r = result.messages[2];
  assert.ok(r?.role === "toolResult");
  assert.equal(r.toolCallId, "c1");
  assert.equal(r.isError, true);
  assert.match(r.content, /no_such_tool/);
  assert.equal(provider.requests.length, 2);
  assert.equal(result.stopReason, "stop");
});

test("工具抛异常时返回错误结果，内容包含异常信息，循环继续", async () => {
  const provider = new FakeProvider([fakeReply([toolCall("c1", "fail")]), fakeReply([text("知道了")])]);
  const result = await runAgent([user("x")], options(provider));

  const r = result.messages[2];
  assert.ok(r?.role === "toolResult");
  assert.equal(r.isError, true);
  assert.match(r.content, /磁盘满了/);
  assert.equal(provider.requests.length, 2);
});

test("工具抛出的不是 Error 对象时，同样转成错误结果", async () => {
  // JS 里 throw 后面可以跟任何值，catch 拿到的不一定是 Error
  for (const thrown of [undefined, null, "字符串错误"]) {
    const weird: Tool = {
      definition: { name: "weird", description: "", parameters: { type: "object", properties: {} } },
      async execute() {
        throw thrown;
      },
    };
    const provider = new FakeProvider([fakeReply([toolCall("1", "weird")]), fakeReply([text("ok")])]);
    const result = await runAgent([user("x")], options(provider, { tools: [weird] }));

    const r = result.messages[2];
    assert.ok(r?.role === "toolResult", `throw ${String(thrown)}`);
    assert.equal(r.isError, true);
    if (typeof thrown === "string") assert.match(r.content, /字符串错误/);
  }
});

test("工具收到的 context 里有 cwd", async () => {
  let seen: ToolContext | undefined;
  const spy: Tool = {
    definition: { name: "spy", description: "", parameters: { type: "object", properties: {} } },
    async execute(_args, context) {
      seen = context;
      return { content: "" };
    },
  };
  const provider = new FakeProvider([fakeReply([toolCall("1", "spy")]), fakeReply([text("ok")])]);
  await runAgent([user("x")], options(provider, { tools: [spy], cwd: "/my/project" }));

  assert.equal(seen?.cwd, "/my/project");
});

test("结束原因取最后一条 assistant 消息的 stopReason", async () => {
  const provider = new FakeProvider([fakeReply([text("写到一半")], "length")]);
  const result = await runAgent([user("x")], options(provider));
  assert.equal(result.stopReason, "length");
});

test("达到 maxTurns 后停下，最后这轮的工具调用也要有结果", async () => {
  const call = (id: string) => fakeReply([toolCall(id, "echo", { text: id })]);
  const provider = new FakeProvider([call("1"), call("2"), call("3")]);
  const result = await runAgent([user("loop")], options(provider, { maxTurns: 2 }));

  assert.equal(provider.requests.length, 2);
  assert.equal(result.stopReason, "maxTurns");
  // 历史不能停在一条没有结果的工具调用上，否则下次接着对话时 API 会报错
  assert.deepEqual(result.messages.at(-1), toolResult("2", "echo", "2"));
});

test("默认最多请求 20 次", async () => {
  const replies = Array.from({ length: 25 }, (_, i) => fakeReply([toolCall(`${i}`, "echo", { text: "x" })]));
  const provider = new FakeProvider(replies);
  const result = await runAgent([user("loop")], options(provider));

  assert.equal(provider.requests.length, 20);
  assert.equal(result.stopReason, "maxTurns");
});

test("不修改传入的数组", async () => {
  const input: Message[] = [user("hi")];
  const provider = new FakeProvider([fakeReply([toolCall("1", "echo", { text: "x" })]), fakeReply([text("ok")])]);
  await runAgent(input, options(provider));
  assert.deepEqual(input, [user("hi")]);
});

test("事件按顺序发出", async () => {
  const first = fakeReply([toolCall("1", "echo", { text: "x" })]);
  const final = fakeReply([text("ok")]);
  const events: AgentEvent[] = [];
  const provider = new FakeProvider([first, final]);
  await runAgent([user("hi")], options(provider, { onEvent: (event) => events.push(event) }));

  const call = toolCall("1", "echo", { text: "x" });
  assert.deepEqual(events, [
    { type: "message", message: first },
    { type: "toolStart", toolCall: call },
    { type: "toolEnd", toolCall: call, result: { content: "x", isError: false } },
    { type: "message", message: toolResult("1", "echo", "x") },
    { type: "message", message: final },
  ]);
});

/** 记录被执行过的调用的工具 */
function recordingTool(name: string, calls: string[]): Tool {
  return {
    definition: { name, description: "", parameters: { type: "object", properties: {} } },
    async execute() {
      calls.push(name);
      return { content: `${name} 执行了` };
    },
  };
}

test("权限：不允许时不执行工具，返回带理由的错误结果，循环继续", async () => {
  const executed: string[] = [];
  const provider = new FakeProvider([fakeReply([toolCall("1", "danger")]), fakeReply([text("好，换个办法")])]);
  const result = await runAgent([user("x")], options(provider, {
    tools: [recordingTool("danger", executed)],
    checkPermission: async () => ({ allowed: false, reason: "不要动生产环境" }),
  }));

  assert.deepEqual(executed, []);
  const r = result.messages[2];
  assert.ok(r?.role === "toolResult");
  assert.equal(r.isError, true);
  assert.match(r.content, /拒绝/);
  assert.match(r.content, /不要动生产环境/);
  assert.equal(provider.requests.length, 2);
});

test("权限：没有理由时也返回拒绝的错误结果", async () => {
  const provider = new FakeProvider([fakeReply([toolCall("1", "danger")]), fakeReply([text("ok")])]);
  const result = await runAgent([user("x")], options(provider, {
    tools: [recordingTool("danger", [])],
    checkPermission: async () => ({ allowed: false }),
  }));
  const r = result.messages[2];
  assert.ok(r?.role === "toolResult");
  assert.equal(r.isError, true);
  assert.match(r.content, /拒绝/);
});

test("权限：允许时正常执行，checkPermission 收到的是这次的工具调用", async () => {
  const executed: string[] = [];
  const asked: ToolCallBlock[] = [];
  const call = toolCall("1", "safe", { a: 1 });
  const provider = new FakeProvider([fakeReply([call]), fakeReply([text("ok")])]);
  await runAgent([user("x")], options(provider, {
    tools: [recordingTool("safe", executed)],
    checkPermission: async (toolCall): Promise<PermissionDecision> => {
      asked.push(toolCall);
      return { allowed: true };
    },
  }));
  assert.deepEqual(executed, ["safe"]);
  assert.deepEqual(asked, [call]);
});

test("权限：找不到的工具直接报错，不询问", async () => {
  let asked = 0;
  const provider = new FakeProvider([fakeReply([toolCall("1", "no_such_tool")]), fakeReply([text("ok")])]);
  await runAgent([user("x")], options(provider, {
    checkPermission: async () => {
      asked++;
      return { allowed: true };
    },
  }));
  assert.equal(asked, 0);
});

test("权限：先发 toolStart 事件，再询问权限，最后发 toolEnd", async () => {
  const order: string[] = [];
  const provider = new FakeProvider([fakeReply([toolCall("1", "danger")]), fakeReply([text("ok")])]);
  await runAgent([user("x")], options(provider, {
    tools: [recordingTool("danger", [])],
    onEvent: (event) => {
      if (event.type !== "message") order.push(event.type);
    },
    checkPermission: async () => {
      order.push("checkPermission");
      return { allowed: false };
    },
  }));
  assert.deepEqual(order, ["toolStart", "checkPermission", "toolEnd"]);
});

test("沙箱配置原样放进工具的 context", async () => {
  let seen: ToolContext | undefined;
  const spy: Tool = {
    definition: { name: "spy", description: "", parameters: { type: "object", properties: {} } },
    async execute(_args, context) {
      seen = context;
      return { content: "" };
    },
  };
  const sandbox = { writableDirs: ["/my/project", "/tmp"], allowNetwork: false };
  const provider = new FakeProvider([fakeReply([toolCall("1", "spy")]), fakeReply([text("ok")])]);
  await runAgent([user("x")], options(provider, { tools: [spy], cwd: "/my/project", sandbox }));
  assert.deepEqual(seen, { cwd: "/my/project", sandbox });
});
