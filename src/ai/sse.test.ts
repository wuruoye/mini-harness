import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse } from "./sse.ts";

const encoder = new TextEncoder();

/** 把文本按固定字节数切块，模拟网络分包 */
async function* chunked(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

function parse(text: string, chunkSize = 1024) {
  return Array.fromAsync(parseSse(chunked(text, chunkSize)));
}

test("解析 event 和 data", async () => {
  const events = await parse("event: ping\ndata: {\"a\":1}\n\n");
  assert.deepEqual(events, [{ event: "ping", data: "{\"a\":1}" }]);
});

test("没有 event 行时类型为 message", async () => {
  const events = await parse("data: hello\n\n");
  assert.deepEqual(events, [{ event: "message", data: "hello" }]);
});

test("多行 data 用换行连接", async () => {
  const events = await parse("data: a\ndata: b\n\n");
  assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("冒号后只去掉一个空格", async () => {
  const events = await parse("data:no-space\n\ndata:  two-spaces\n\n");
  assert.deepEqual(events.map((e) => e.data), ["no-space", " two-spaces"]);
});

test("忽略注释行、未知字段和没有 data 的事件", async () => {
  const events = await parse(": heartbeat\n\nid: 1\nretry: 100\nfoo: bar\n\nevent: x\n\ndata: ok\n\n");
  assert.deepEqual(events, [{ event: "message", data: "ok" }]);
});

test("支持 \\r\\n 和 \\r 换行", async () => {
  const events = await parse("data: a\r\n\r\ndata: b\r\rdata: c\n\n");
  assert.deepEqual(events.map((e) => e.data), ["a", "b", "c"]);
});

test("流结束时丢弃没有以空行结尾的事件", async () => {
  const events = await parse("data: done\n\ndata: cut");
  assert.deepEqual(events.map((e) => e.data), ["done"]);
});

test("在任意字节处切块，结果都一样", async () => {
  // 包含中文（多字节 UTF-8）和 \r\n，切块时会把它们从中间切开
  const text = "event: delta\r\ndata: {\"text\":\"你好，世界\"}\r\n\r\nevent: stop\ndata: {}\n\n";
  const expected = await parse(text);
  assert.equal(expected.length, 2);
  for (let size = 1; size <= 8; size++) {
    assert.deepEqual(await parse(text, size), expected, `chunk size ${size}`);
  }
});

test("解析 Anthropic 风格的流", async () => {
  const stream = [
    "event: message_start",
    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}",
    "",
    "event: content_block_delta",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}",
    "",
    "event: message_stop",
    "data: {\"type\":\"message_stop\"}",
    "",
    "",
  ].join("\n");
  const events = await parse(stream, 7);
  assert.deepEqual(events.map((e) => e.event), ["message_start", "content_block_delta", "message_stop"]);
  const delta = JSON.parse(events[1]!.data);
  assert.equal(delta.delta.text, "Hi");
});
