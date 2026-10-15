import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, fakeReply, hangUntilAborted, text, toolCall } from "./fake.ts";
import type { Message, ModelRequest } from "./types.ts";

function request(messages: Message[]): ModelRequest {
  return { system: "", messages, tools: [] };
}

test("按顺序返回脚本里的回复", async () => {
  const provider = new FakeProvider([fakeReply([text("一")]), fakeReply([text("二")])]);
  assert.deepEqual((await provider.complete(request([]))).content, [text("一")]);
  assert.deepEqual((await provider.complete(request([]))).content, [text("二")]);
});

test("记下的请求不受调用方后续修改影响", async () => {
  const provider = new FakeProvider([fakeReply([text("ok")])]);
  const history: Message[] = [{ role: "user", content: "hi" }];
  await provider.complete(request(history));
  history.push({ role: "user", content: "later" });
  assert.equal(provider.requests[0]!.messages.length, 1);
});

test("脚本用完后再请求会抛异常", async () => {
  const provider = new FakeProvider([]);
  await assert.rejects(provider.complete(request([])), /FakeProvider/);
});

test("根据有没有工具调用自动设置 stopReason", () => {
  assert.equal(fakeReply([text("hi")]).stopReason, "stop");
  assert.equal(fakeReply([toolCall("1", "echo")]).stopReason, "toolUse");
  assert.equal(fakeReply([text("hi")], "length").stopReason, "length");
});

test("信号已经中止时不发请求，直接抛出中止的原因", async () => {
  const provider = new FakeProvider([fakeReply([text("ok")])]);
  await assert.rejects(provider.complete(request([]), { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(provider.requests.length, 0);
});

test("hangUntilAborted 一直等到被中止", async () => {
  const provider = new FakeProvider([hangUntilAborted()]);
  const controller = new AbortController();
  const pending = provider.complete(request([]), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
});

test("回复函数可以是异步的，并能拿到信号", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const provider = new FakeProvider([
    async (_request, signal) => {
      seen = signal;
      return fakeReply([text("异步")]);
    },
  ]);
  const reply = await provider.complete(request([]), { signal: controller.signal });
  assert.deepEqual(reply.content, [text("异步")]);
  assert.equal(seen, controller.signal);
});
