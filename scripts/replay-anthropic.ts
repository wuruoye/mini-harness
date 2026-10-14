// 把 explore-anthropic.ts 保存的原始事件交给 readAnthropicStream 解析，打印得到的消息。
// 调试解析逻辑时用它，不用每次都请求 API。
//
// 用法：node scripts/replay-anthropic.ts tmp/anthropic-xxx.sse

import { readFile } from "node:fs/promises";
import { readAnthropicStream } from "../src/ai/anthropic.ts";
import { parseSse } from "../src/ai/sse.ts";

const file = process.argv[2];
if (!file) {
  console.error("用法：node scripts/replay-anthropic.ts <保存的 .sse 文件>");
  process.exit(1);
}

const bytes = await readFile(file);
async function* chunks() {
  yield bytes;
}

const message = await readAnthropicStream(parseSse(chunks()));
console.dir(message, { depth: null });
