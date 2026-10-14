// 输入问题 → 直接请求 Anthropic Messages API → 打印原始的流式事件，并保存到 tmp/。
// 不经过适配器和主循环，用来观察 API 的真实响应。每个问题都是一次独立的请求，不带历史。
//
// 用法（在 mini-harness 目录下）：
//   pnpm explore                               交互模式，逐条输入问题
//   pnpm explore 用一句话介绍你自己              只问这一句
//   pnpm explore --tool 读一下 package.json      带上 read_file 工具定义，观察模型怎么发起工具调用
//
// 想观察别的情况，直接改 buildBody 里的请求体；想逐个看事件，在 for await 循环里打断点。

import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs, styleText } from "node:util";
import { parseSse } from "../src/ai/sse.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("缺少环境变量 ANTHROPIC_API_KEY，先把 .env.example 复制为 .env 并填写");
  process.exit(1);
}
const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";

const { values, positionals } = parseArgs({
  options: { tool: { type: "boolean", default: false } },
  allowPositionals: true,
});
const withTool = values.tool;

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
function buildBody(question: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 4096,
    stream: true,
    system: "你是编程助手。",
    ...(withTool && { tools: [readFileTool] }),
    messages: [{ role: "user", content: question }],
  };
}

async function send(question: string): Promise<void> {
  const body = buildBody(question);
  console.log(styleText("dim", `POST ${baseUrl}/messages`));
  console.log(styleText("dim", JSON.stringify(body, null, 2)));

  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
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
    return;
  }

  const saved: string[] = [];
  for await (const event of parseSse(response.body)) {
    saved.push(`event: ${event.event}\ndata: ${event.data}\n\n`);
    const data: unknown = JSON.parse(event.data); // 在这里打断点，逐个查看事件
    console.log(styleText("cyan", event.event.padEnd(20)), JSON.stringify(data));
  }

  await mkdir("tmp", { recursive: true });
  const file = `tmp/anthropic-${Date.now()}.sse`;
  await writeFile(file, saved.join(""));
  console.log(styleText("dim", `\n原始事件已保存到 ${file}\n`));
}

const question = positionals.join(" ").trim();
if (question) {
  await send(question);
} else {
  console.log(styleText("dim", `模型 ${model}${withTool ? "，带 read_file 工具" : ""}。输入问题后回车，Ctrl-D 退出。`));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  rl.prompt();
  for await (const line of rl) {
    if (line.trim()) {
      try {
        await send(line.trim());
      } catch (err) {
        console.error(styleText("red", `请求失败：${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (!closed) rl.prompt();
  }
}
