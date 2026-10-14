import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, fakeReply, text, toolCall } from "./fake.ts";
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
