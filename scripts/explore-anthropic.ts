// 直接请求 Anthropic Messages API，打印原始的流式事件并保存到 tmp/，用来观察真实数据。
// 不依赖 src/ai/anthropic.ts，适配器还没写好时也能用。
//
// 用法（在 mini-harness 目录下）：
//   node --env-file=.env scripts/explore-anthropic.ts        普通问答
//   node --env-file=.env scripts/explore-anthropic.ts tool   让模型调用工具
//
// 想观察别的情况，直接改下面的请求体；想逐个看事件，在 for await 循环里打断点。

import { mkdir, writeFile } from "node:fs/promises";
import { styleText } from "node:util";
import { parseSse } from "../src/ai/sse.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("缺少环境变量 ANTHROPIC_API_KEY，先把 .env.example 复制为 .env 并填写");
  process.exit(1);
}
const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
const scenario = process.argv[2] === "tool" ? "tool" : "text";

const readFileTool = {
  name: "read_file",
  description: "读取文本文件内容。",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "文件路径" } },
    required: ["path"],
  },
};

// 故意不写类型，方便随手加字段做实验。比如加上下面这行，就能看到思考内容的摘要：
//   thinking: { type: "adaptive", display: "summarized" },
const body: Record<string, unknown> =
  scenario === "tool"
    ? {
        model,
        max_tokens: 4096,
        stream: true,
        system: "你是编程助手。需要了解文件内容时用 read_file 读取。",
        tools: [readFileTool],
        messages: [{ role: "user", content: "读一下 package.json，告诉我项目名" }],
      }
    : {
        model,
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "用一句话介绍你自己" }],
      };

console.log(styleText("dim", `POST ${baseUrl}/messages`));
console.log(styleText("dim", JSON.stringify(body, null, 2)));

const response = await fetch(`${baseUrl}/messages`, {
  method: "POST",
  headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify(body),
});

console.log(`\nHTTP ${response.status}`);
for (const [name, value] of response.headers) {
  if (name === "content-type" || name === "request-id" || name.startsWith("anthropic-")) {
    console.log(styleText("dim", `${name}: ${value}`));
  }
}
if (!response.ok || !response.body) {
  console.log(await response.text());
  process.exit(1);
}

const saved: string[] = [];
for await (const event of parseSse(response.body)) {
  saved.push(`event: ${event.event}\ndata: ${event.data}\n\n`);
  const data: unknown = JSON.parse(event.data); // 在这里打断点，逐个查看事件
  console.log(styleText("cyan", event.event.padEnd(20)), JSON.stringify(data));
}

await mkdir("tmp", { recursive: true });
const file = `tmp/anthropic-${scenario}-${Date.now()}.sse`;
await writeFile(file, saved.join(""));
console.log(styleText("dim", `\n原始事件已保存到 ${file}，可以用 scripts/replay-anthropic.ts 回放`));
