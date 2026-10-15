// 把探索脚本保存的原始数据交给适配器的解析函数，打印得到的消息。
// 调试解析逻辑时用它，不用每次都请求 API。
// 文件名前缀 grok-、openai- 分别交给对应适配器，其余交给 readAnthropicStream。
//
// 用法：pnpm replay tmp/anthropic-xxx.sse

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { readAnthropicStream } from "../src/ai/anthropic.ts";
import { readOpenAIStream } from "../src/ai/openai.ts";
import { readGrokStream } from "../src/ai/grok.ts";
import { parseSse } from "../src/ai/sse.ts";

const file = process.argv[2];
if (!file) {
  console.error("用法：pnpm replay <保存的 .sse 文件>");
  process.exit(1);
}

const bytes = await readFile(file);
async function* chunks() {
  yield bytes;
}

const prefix = basename(file);
const read = prefix.startsWith("grok-") ? readGrokStream : prefix.startsWith("openai-") ? readOpenAIStream : readAnthropicStream;
const message = await read(parseSse(chunks()));
console.dir(message, { depth: null });
