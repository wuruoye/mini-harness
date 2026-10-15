import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeProvider, fakeReply, hangUntilAborted, text, thinking, toolCall } from "../ai/fake.ts";
import type { ToolCallBlock } from "../ai/types.ts";
import { runAgent } from "./loop.ts";
import {
  createTaskTool,
  SUBAGENT_SYSTEM_SUFFIX,
  TASK_TOOL_DEFINITION,
  TASK_TOOL_NAME,
  type TaskToolOptions,
} from "./subagent.ts";
import type { AgentEvent, Tool, ToolContext } from "./types.ts";

const SYSTEM = "主代理的系统提示";
const ARGS = { description: "查找定义", prompt: "找出 foo 的定义在哪个文件" };

/** 原样返回 text 参数，并记下每次拿到的 context */
function echoTool(contexts: ToolContext[] = []): Tool {
  return {
    definition: { name: "echo", description: "原样返回 text", parameters: { type: "object", properties: {} } },
    async execute(args, context) {
      contexts.push(context);
      return { content: String(args.text) };
    },
  };
}

function taskTool(provider: FakeProvider, extra: Partial<TaskToolOptions> = {}): Tool {
  return createTaskTool({ provider, system: SYSTEM, createTools: () => [echoTool()], ...extra });
}

describe("createTaskTool", () => {
  test("工具定义；参数不是非空字符串时报错，不请求模型", async () => {
    const tool = taskTool(new FakeProvider([]));
    assert.deepEqual(tool.definition, TASK_TOOL_DEFINITION);
    assert.equal(tool.definition.name, TASK_TOOL_NAME);
    await assert.rejects(tool.execute({ prompt: "x" }, { cwd: "/work" }), /description/);
    await assert.rejects(tool.execute({ description: 1, prompt: "x" }, { cwd: "/work" }), /description/);
    await assert.rejects(tool.execute({ description: "  ", prompt: "x" }, { cwd: "/work" }), /description/);
    await assert.rejects(tool.execute({ description: "d", prompt: "" }, { cwd: "/work" }), /prompt/);
    await assert.rejects(tool.execute({ description: "d", prompt: "\n " }, { cwd: "/work" }), /prompt/);
  });

  test("子代理只看到任务说明；系统提示加上子代理说明；工具里去掉 task", async () => {
    const provider = new FakeProvider([fakeReply([text("定义在 src/foo.ts:3")])]);
    const nested: Tool = { definition: TASK_TOOL_DEFINITION, execute: async () => ({ content: "" }) };
    const tool = taskTool(provider, { createTools: () => [echoTool(), nested] });

    const result = await tool.execute(ARGS, { cwd: "/work" });
    assert.deepEqual(result, { content: "定义在 src/foo.ts:3", isError: false });
    const [request] = provider.requests;
    assert.deepEqual(request?.messages, [{ role: "user", content: ARGS.prompt }]);
    assert.equal(request?.system, `${SYSTEM}\n\n${SUBAGENT_SYSTEM_SUFFIX}`);
    assert.deepEqual(request?.tools.map((t) => t.name), ["echo"]);
  });

  test("子代理可以调用工具；汇报取最后一条回复里的文本块；事件带上任务说明", async () => {
    const provider = new FakeProvider([
      fakeReply([text("先看看"), toolCall("c1", "echo", { text: "文件内容" })]),
      fakeReply([thinking("想想"), text("第一段"), text("第二段")]),
    ]);
    const events: [AgentEvent["type"], string][] = [];
    const tool = taskTool(provider, { onEvent: (event, description) => events.push([event.type, description]) });

    const result = await tool.execute(ARGS, { cwd: "/work" });
    assert.deepEqual(result, { content: "第一段\n第二段", isError: false });
    assert.equal(provider.requests[1]?.messages.length, 3);
    const types = events.map(([type]) => type);
    assert.ok(types.includes("toolStart") && types.includes("toolEnd") && types.includes("message"));
    assert.ok(events.every(([, description]) => description === ARGS.description));
  });

  test("context 原样交给子代理：工作目录、沙箱、权限询问和中断信号", async () => {
    const provider = new FakeProvider([fakeReply([toolCall("c1", "echo", { text: "x" })]), fakeReply([text("好了")])]);
    const contexts: ToolContext[] = [];
    const asked: ToolCallBlock[] = [];
    const context: ToolContext = {
      cwd: "/work",
      sandbox: { writableDirs: ["/work"], allowNetwork: false },
      checkPermission: async (call) => {
        asked.push(call);
        return { allowed: true };
      },
      signal: new AbortController().signal,
    };
    const tool = taskTool(provider, { createTools: () => [echoTool(contexts)] });

    await tool.execute(ARGS, context);
    assert.deepEqual(asked.map((call) => call.name), ["echo"]);
    const [seen] = contexts;
    assert.equal(seen?.cwd, "/work");
    assert.deepEqual(seen?.sandbox, context.sandbox);
    assert.equal(seen?.checkPermission, context.checkPermission);
    assert.equal(seen?.signal, context.signal);
  });

  test("权限被拒绝时，子代理收到错误结果，照常继续", async () => {
    const provider = new FakeProvider([fakeReply([toolCall("c1", "echo", { text: "x" })]), fakeReply([text("被拒绝了")])]);
    const tool = taskTool(provider);
    const result = await tool.execute(ARGS, { cwd: "/work", checkPermission: async () => ({ allowed: false }) });
    assert.deepEqual(result, { content: "被拒绝了", isError: false });
    const toolResult = provider.requests[1]?.messages.at(-1);
    assert.equal(toolResult?.role === "toolResult" && toolResult.isError, true);
  });

  test("每次执行都重新创建一份工具", async () => {
    let created = 0;
    const provider = new FakeProvider([fakeReply([text("一")]), fakeReply([text("二")])]);
    const tool = taskTool(provider, {
      createTools: () => {
        created++;
        return [echoTool()];
      },
    });
    await tool.execute(ARGS, { cwd: "/work" });
    await tool.execute(ARGS, { cwd: "/work" });
    assert.equal(created, 2);
  });

  test("没有汇报时说明没有汇报", async () => {
    const tool = taskTool(new FakeProvider([fakeReply([thinking("只想不说")])]));
    assert.deepEqual(await tool.execute(ARGS, { cwd: "/work" }), { content: "子代理没有给出汇报", isError: false });
  });

  test("没做完时是错误结果，说明没有完成，附上已有的汇报", async () => {
    const turnsUsed = taskTool(new FakeProvider([fakeReply([text("还没查完"), toolCall("c1", "echo", { text: "x" })])]), {
      maxTurns: 1,
    });
    const first = await turnsUsed.execute(ARGS, { cwd: "/work" });
    assert.equal(first.isError, true);
    assert.match(first.content, /没有完成/);
    assert.match(first.content, /还没查完/);

    const truncated = taskTool(new FakeProvider([fakeReply([text("写到一半")], "length")]));
    const second = await truncated.execute(ARGS, { cwd: "/work" });
    assert.equal(second.isError, true);
    assert.match(second.content, /没有完成/);
    assert.match(second.content, /写到一半/);

    const refused = taskTool(new FakeProvider([fakeReply([text("无法处理")], "refusal")]));
    const third = await refused.execute(ARGS, { cwd: "/work" });
    assert.equal(third.isError, true);
    assert.match(third.content, /没有完成.*refusal/);
    assert.match(third.content, /无法处理/);
  });

  test("默认最多请求 30 次，达到上限时附上最后一条回复", async () => {
    const provider = new FakeProvider(Array.from({ length: 30 }, (_, index) =>
      fakeReply([text(`进度 ${index + 1}`), toolCall(`c${index}`, "echo", { text: "继续" })]),
    ));
    const result = await taskTool(provider).execute(ARGS, { cwd: "/work" });
    assert.equal(provider.requests.length, 30);
    assert.equal(result.isError, true);
    assert.match(result.content, /maxTurns/);
    assert.match(result.content, /进度 30/);
  });

  test("中断时子代理一起停下，返回错误结果", async () => {
    const controller = new AbortController();
    const tool = taskTool(new FakeProvider([hangUntilAborted()]));
    setTimeout(() => controller.abort(), 10);
    const result = await tool.execute(ARGS, { cwd: "/work", signal: controller.signal });
    assert.equal(result.isError, true);
    assert.match(result.content, /中断/);
  });

  test("模型请求出错时抛出，交给主循环处理", async () => {
    const tool = taskTool(
      new FakeProvider([
        () => {
          throw new Error("网络断了");
        },
      ]),
    );
    await assert.rejects(tool.execute(ARGS, { cwd: "/work" }), /网络断了/);
  });

  test("放进主循环：主代理的历史里只有 task 调用和汇报，看不到子代理的过程", async () => {
    // 主代理和子代理共用一个假模型，按请求的先后顺序回复
    const provider = new FakeProvider([
      fakeReply([toolCall("t1", TASK_TOOL_NAME, ARGS)]),
      fakeReply([toolCall("c1", "echo", { text: "很长的文件内容" })]),
      fakeReply([text("定义在 src/foo.ts:3")]),
      fakeReply([text("找到了")]),
    ]);
    const parentEvents: AgentEvent[] = [];
    const result = await runAgent([{ role: "user", content: "foo 定义在哪" }], {
      provider,
      system: SYSTEM,
      tools: [echoTool(), taskTool(provider)],
      cwd: "/work",
      onEvent: (event) => parentEvents.push(event),
    });

    assert.equal(result.stopReason, "stop");
    assert.deepEqual(
      result.messages.map((m) => m.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    const toolResult = result.messages[2];
    assert.equal(toolResult?.role === "toolResult" && toolResult.content, "定义在 src/foo.ts:3");
    assert.equal(provider.requests[3]?.messages.length, 3);
    assert.equal(JSON.stringify(provider.requests[3]).includes("很长的文件内容"), false);
    assert.equal(parentEvents.filter((event) => event.type === "toolStart").length, 1);
  });
});
