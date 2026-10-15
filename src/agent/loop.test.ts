import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, fakeReply, hangUntilAborted, text, thinking, toolCall } from "../ai/fake.ts";
import type { AssistantMessage, Message, Provider, StreamDelta, ToolCallBlock, ToolResultMessage, UserMessage } from "../ai/types.ts";
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
  assert.equal(seen?.cwd, "/my/project");
  assert.deepEqual(seen?.sandbox, sandbox);
});

test("checkPermission 也放进工具的 context，工具执行中可以再申请权限", async () => {
  let seen: ToolContext | undefined;
  const spy: Tool = {
    definition: { name: "spy", description: "", parameters: { type: "object", properties: {} } },
    async execute(_args, context) {
      seen = context;
      return { content: "" };
    },
  };
  const checkPermission = async (): Promise<PermissionDecision> => ({ allowed: true });
  const provider = new FakeProvider([fakeReply([toolCall("1", "spy")]), fakeReply([text("ok")])]);
  await runAgent([user("x")], options(provider, { tools: [spy], checkPermission }));
  assert.equal(seen?.checkPermission, checkPermission);
});

describe("中断", () => {
  test("开始前已经中止：不请求模型，历史不变", async () => {
    const provider = new FakeProvider([]);
    const input = [user("hi")];
    const result = await runAgent(input, options(provider, { signal: AbortSignal.abort() }));
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(result, { messages: input, stopReason: "aborted" });
  });

  test("请求模型时被中止：不抛异常，丢掉这次请求", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([hangUntilAborted()]);
    setTimeout(() => controller.abort(), 20);
    const result = await runAgent([user("hi")], options(provider, { signal: controller.signal }));
    assert.deepEqual(result, { messages: [user("hi")], stopReason: "aborted" });
  });

  test("不是中止导致的错误照常抛出", async () => {
    const provider = new FakeProvider([]);
    await assert.rejects(runAgent([user("hi")], options(provider, { signal: new AbortController().signal })), /FakeProvider/);
  });

  test("signal 传给模型请求和工具", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let toolSignal: AbortSignal | undefined;
    const spy: Tool = {
      definition: { name: "spy", description: "", parameters: { type: "object", properties: {} } },
      async execute(_args, context) {
        toolSignal = context.signal;
        return { content: "" };
      },
    };
    const provider = new FakeProvider([
      (_request, signal) => {
        providerSignal = signal;
        return fakeReply([toolCall("1", "spy")]);
      },
      fakeReply([text("ok")]),
    ]);
    await runAgent([user("x")], options(provider, { tools: [spy], signal: controller.signal }));
    assert.equal(providerSignal, controller.signal);
    assert.equal(toolSignal, controller.signal);
  });

  test("等待权限确认时被中止：即使允许也不再执行工具", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const provider = new FakeProvider([fakeReply([toolCall("1", "echo")])]);
    const result = await runAgent([user("x")], options(provider, {
      tools: [recordingTool("echo", executed)],
      signal: controller.signal,
      checkPermission: async () => {
        controller.abort();
        return { allowed: true };
      },
    }));

    assert.deepEqual(executed, []);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.stopReason, "aborted");
    const message = result.messages.at(-1);
    assert.ok(message?.role === "toolResult");
    assert.equal(message.toolCallId, "1");
    assert.equal(message.isError, true);
    assert.match(message.content, /中断/);
  });

  test("工具执行中被中止：剩下的工具调用不执行，补上中断的结果，不再请求模型", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const stopper: Tool = {
      definition: { name: "stopper", description: "", parameters: { type: "object", properties: {} } },
      async execute() {
        executed.push("stopper");
        controller.abort();
        return { content: "我执行完了" };
      },
    };
    const first = fakeReply([toolCall("1", "stopper"), toolCall("2", "echo", { text: "a" }), toolCall("3", "echo", { text: "b" })]);
    const provider = new FakeProvider([first]);
    const events: AgentEvent[] = [];
    const result = await runAgent([user("x")], options(provider, {
      tools: [stopper, recordingTool("echo", executed)],
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    }));

    assert.deepEqual(executed, ["stopper"]);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.stopReason, "aborted");
    const results = result.messages.slice(2);
    assert.deepEqual(results.map((m) => m.role === "toolResult" && m.toolCallId), ["1", "2", "3"]);
    assert.deepEqual(results[0], toolResult("1", "stopper", "我执行完了"));
    for (const skipped of results.slice(1)) {
      assert.ok(skipped.role === "toolResult");
      assert.equal(skipped.isError, true);
      assert.match(skipped.content, /中断/);
    }
    // 跳过的调用只发 message 事件
    assert.deepEqual(events.map((e) => e.type), ["message", "toolStart", "toolEnd", "message", "message", "message"]);
  });
});

describe("排队的消息", () => {
  /** 按顺序返回预先准备的几批消息，用完后返回空数组 */
  function queue(...batches: UserMessage[][]) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      getQueuedMessages: () => {
        calls++;
        return batches.shift() ?? [];
      },
    };
  }

  test("一轮工具结果之后插进对话，下一次请求就能看到", async () => {
    const first = fakeReply([toolCall("1", "echo", { text: "a" })]);
    const provider = new FakeProvider([first, fakeReply([text("好的")])]);
    const q = queue([user("顺便看下 b")]);
    const events: AgentEvent[] = [];
    const result = await runAgent([user("看下 a")], options(provider, {
      getQueuedMessages: q.getQueuedMessages,
      onEvent: (event) => events.push(event),
    }));

    const expected = [user("看下 a"), first, toolResult("1", "echo", "a"), user("顺便看下 b")];
    assert.deepEqual(provider.requests[1]!.messages, expected);
    assert.equal(result.stopReason, "stop");
    assert.ok(events.some((e) => e.type === "message" && e.message.role === "user"));
  });

  test("模型本来要结束时有排队的消息，就接着请求", async () => {
    const provider = new FakeProvider([fakeReply([text("答一")]), fakeReply([text("答二")])]);
    const q = queue([user("再问一句")]);
    const result = await runAgent([user("问一")], options(provider, { getQueuedMessages: q.getQueuedMessages }));

    assert.equal(provider.requests.length, 2);
    assert.deepEqual(provider.requests[1]!.messages, [user("问一"), fakeReply([text("答一")]), user("再问一句")]);
    assert.deepEqual(result.messages.at(-1), fakeReply([text("答二")]));
  });

  test("请求次数用完或被中断时不再取", async () => {
    const q1 = queue([user("不会被取走")]);
    const provider1 = new FakeProvider([fakeReply([toolCall("1", "echo", { text: "a" })])]);
    const r1 = await runAgent([user("x")], options(provider1, { maxTurns: 1, getQueuedMessages: q1.getQueuedMessages }));
    assert.equal(r1.stopReason, "maxTurns");
    assert.equal(q1.calls, 0);

    const controller = new AbortController();
    const q2 = queue([user("不会被取走")]);
    const stopper: Tool = {
      definition: { name: "stopper", description: "", parameters: { type: "object", properties: {} } },
      async execute() {
        controller.abort();
        return { content: "" };
      },
    };
    const provider2 = new FakeProvider([fakeReply([toolCall("1", "stopper")])]);
    await runAgent([user("x")], options(provider2, { tools: [stopper], signal: controller.signal, getQueuedMessages: q2.getQueuedMessages }));
    assert.equal(q2.calls, 0);
  });
});

describe("流式增量", () => {
  /**
   * 按顺序处理每次请求的假 provider：先通过 onDelta 吐出给定的增量，再返回完整消息。
   * 没用 FakeProvider，是为了让这几个测试只依赖主循环自己
   */
  function streamingProvider(...turns: { deltas: StreamDelta[]; reply: AssistantMessage }[]): Provider {
    return {
      async complete(_request, options) {
        const turn = turns.shift();
        if (!turn) throw new Error("没有更多的回复了");
        for (const delta of turn.deltas) options?.onDelta?.(delta);
        return structuredClone(turn.reply);
      },
    };
  }

  test("provider 的增量转成 delta 事件", async () => {
    const provider = streamingProvider({
      deltas: [{ type: "thinking", text: "嗯" }, { type: "text", text: "你" }, { type: "text", text: "好" }],
      reply: fakeReply([text("你好")]),
    });
    const events: AgentEvent[] = [];
    await runAgent([user("hi")], { provider, system: "", tools: [], cwd: "/", onEvent: (e) => events.push(e) });
    assert.deepEqual(
      events.filter((e) => e.type === "delta"),
      [
        { type: "delta", delta: { type: "thinking", text: "嗯" } },
        { type: "delta", delta: { type: "text", text: "你" } },
        { type: "delta", delta: { type: "text", text: "好" } },
      ],
    );
  });

  test("同一条回复的 delta 事件都在它的 message 事件之前", async () => {
    const provider = streamingProvider(
      {
        deltas: [{ type: "text", text: "我来" }, { type: "toolCallStart", id: "1", name: "echo" }],
        reply: fakeReply([text("我来"), toolCall("1", "echo", { text: "x" })]),
      },
      { deltas: [{ type: "text", text: "好了" }], reply: fakeReply([text("好了")]) },
    );
    const types: string[] = [];
    await runAgent([user("hi")], {
      provider,
      system: "",
      tools: [echoTool],
      cwd: "/",
      onEvent: (e) => types.push(e.type === "message" ? `message:${e.message.role}` : e.type),
    });
    assert.deepEqual(types, [
      "delta",
      "delta",
      "message:assistant",
      "toolStart",
      "toolEnd",
      "message:toolResult",
      "delta",
      "message:assistant",
    ]);
  });

  test("被中断时已经发出的增量不影响历史", async () => {
    const controller = new AbortController();
    const provider: Provider = {
      complete: (_request, options) =>
        new Promise((_resolve, reject) => {
          options?.onDelta?.({ type: "text", text: "说到一半" });
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          setTimeout(() => controller.abort(), 20);
        }),
    };
    const events: AgentEvent[] = [];
    const result = await runAgent([user("hi")], {
      provider,
      system: "",
      tools: [],
      cwd: "/",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    assert.deepEqual(result, { messages: [user("hi")], stopReason: "aborted" });
    assert.deepEqual(events, [{ type: "delta", delta: { type: "text", text: "说到一半" } }]);
  });
});
