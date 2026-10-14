// 输入问题 → 直接请求 OpenAI Chat Completions API → 打印原始的流式数据块，并保存到 tmp/。
// 不经过适配器和主循环，用来观察 API 的真实响应。每个问题都是一次独立的请求，不带历史。
//
// 用法（在 mini-harness 目录下）：
//   pnpm explore:openai --models                       列出这个 key 能用的模型
//   pnpm explore:openai                                交互模式，逐条输入问题
//   pnpm explore:openai 用一句话介绍你自己               只问这一句
//   pnpm explore:openai --tool 读一下 package.json       带上 read_file 工具定义，观察模型怎么发起工具调用
//
// 改 OPENAI_BASE_URL 就能观察兼容 OpenAI 的其他服务。想逐个看数据块，在 for await 循环里打断点。

import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs, styleText } from "node:util";
import { parseSse } from "../src/ai/sse.ts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("缺少环境变量 OPENAI_API_KEY，先把 .env.example 复制为 .env 并填写");
  process.exit(1);
}
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

const { values, positionals } = parseArgs({
  options: {
    tool: { type: "boolean", default: false },
    models: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (values.models) {
  const response = await fetch(`${baseUrl}/models`, { headers });
  console.log(styleText("dim", `GET ${baseUrl}/models → HTTP ${response.status}`));
  if (!response.ok) {
    console.log(await response.text());
    process.exit(1);
  }
  const list = (await response.json()) as { data: { id: string; created?: number; owned_by?: string }[] };
  for (const m of list.data.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))) {
    const created = m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : "";
    console.log(`${m.id.padEnd(40)} ${styleText("dim", `${created} ${m.owned_by ?? ""}`)}`);
  }
  process.exit(0);
}

const model = process.env.OPENAI_MODEL;
if (!model) {
  console.error("缺少环境变量 OPENAI_MODEL。可以先运行 pnpm explore:openai --models 看看有哪些模型");
  process.exit(1);
}

const readFileTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "读取文本文件内容。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
  },
};

// 故意不写类型，方便随手加字段做实验，比如 reasoning_effort: "low"
function buildBody(question: string): Record<string, unknown> {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    ...(values.tool && { tools: [readFileTool] }),
    messages: [
      { role: "system", content: "你是编程助手。" },
      { role: "user", content: question },
    ],
  };
}

async function send(question: string): Promise<void> {
  const body = buildBody(question);
  console.log(styleText("dim", `POST ${baseUrl}/chat/completions`));
  console.log(styleText("dim", JSON.stringify(body, null, 2)));

  const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });

  console.log(`\nHTTP ${response.status}`);
  for (const [name, value] of response.headers) {
    if (name === "content-type" || name.startsWith("x-request-id") || name.startsWith("openai-")) {
      console.log(styleText("dim", `${name}: ${value}`));
    }
  }
  if (!response.ok || !response.body) {
    console.log(await response.text());
    return;
  }

  const saved: string[] = [];
  for await (const event of parseSse(response.body)) {
    saved.push(`data: ${event.data}\n\n`);
    // 最后一行是 [DONE]，不是 JSON，在这里打断点逐个查看数据块
    const shown = event.data === "[DONE]" ? event.data : JSON.stringify(JSON.parse(event.data));
    console.log(styleText("cyan", "data"), shown);
  }

  await mkdir("tmp", { recursive: true });
  const file = `tmp/openai-${Date.now()}.sse`;
  await writeFile(file, saved.join(""));
  console.log(styleText("dim", `\n原始数据已保存到 ${file}\n`));
}

const question = positionals.join(" ").trim();
if (question) {
  await send(question);
} else {
  console.log(styleText("dim", `模型 ${model}${values.tool ? "，带 read_file 工具" : ""}。输入问题后回车，Ctrl-D 退出。`));
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
