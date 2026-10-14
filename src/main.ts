// 命令行入口：读取用户输入，交给主循环，把过程打印出来。

import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { AnthropicProvider } from "./ai/anthropic.ts";
import type { AnthropicEffort } from "./ai/anthropic-types.ts";
import { OpenAIProvider } from "./ai/openai.ts";
import type { AssistantMessage, Message, Provider, Usage } from "./ai/types.ts";
import { runAgent } from "./agent/loop.ts";
import type { AgentEvent } from "./agent/types.ts";
import { readFileTool } from "./tools/read-file.ts";
import { loadProjectEnv } from "./env.ts";

loadProjectEnv();

const SYSTEM_PROMPT = `你是一个编程助手，在用户的项目目录里工作。
需要了解代码时，用工具读取文件，不要猜测文件内容。
回答使用中文，简洁直接。`;

const EFFORTS: AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

function fail(message: string): never {
  console.error(styleText("red", message));
  process.exit(1);
}

/** 根据 LLM_PROVIDER 选择厂商，返回 provider 和用于显示的模型名 */
function createProvider(): { provider: Provider; model: string } {
  const name = process.env.LLM_PROVIDER || "anthropic";

  if (name === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) fail("缺少环境变量 ANTHROPIC_API_KEY。可以写进项目根目录的 .env 文件，格式见 .env.example");
    const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
    const effort = process.env.ANTHROPIC_EFFORT || undefined;
    if (effort !== undefined && !EFFORTS.includes(effort as AnthropicEffort)) {
      fail(`ANTHROPIC_EFFORT 只能是 ${EFFORTS.join("、")} 之一，现在是 ${effort}`);
    }
    const provider = new AnthropicProvider({
      apiKey,
      model,
      baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
      effort: effort as AnthropicEffort | undefined,
    });
    return { provider, model: `anthropic ${model}` };
  }

  if (name === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) fail("缺少环境变量 OPENAI_API_KEY。可以写进项目根目录的 .env 文件，格式见 .env.example");
    const model = process.env.OPENAI_MODEL;
    if (!model) fail("缺少环境变量 OPENAI_MODEL。可以先运行 pnpm explore:openai --models 查看能用的模型");
    const provider = new OpenAIProvider({
      apiKey,
      model,
      baseUrl: process.env.OPENAI_BASE_URL || undefined,
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT || undefined,
    });
    return { provider, model: `openai ${model}` };
  }

  fail(`LLM_PROVIDER 只能是 anthropic 或 openai，现在是 ${name}`);
}

const { provider, model } = createProvider();
const tools = [readFileTool];
const cwd = process.cwd();

function preview(text: string, max = 120): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "message": {
      if (event.message.role !== "assistant") return;
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) console.log(block.text);
        else if (block.type === "thinking" && block.thinking) console.log(styleText("dim", block.thinking));
      }
      return;
    }
    case "toolStart":
      console.log(styleText("cyan", `→ ${event.toolCall.name} ${JSON.stringify(event.toolCall.arguments)}`));
      return;
    case "toolEnd": {
      const { content, isError } = event.result;
      if (isError) console.log(styleText("red", `  ✗ ${preview(content)}`));
      else console.log(styleText("dim", `  ✓ ${content.length} 个字符`));
      return;
    }
  }
}

function totalUsage(messages: Message[]): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    total.inputTokens += m.usage.inputTokens;
    total.outputTokens += m.usage.outputTokens;
    total.cacheReadTokens += m.usage.cacheReadTokens;
    total.cacheWriteTokens += m.usage.cacheWriteTokens;
  }
  return total;
}

let history: Message[] = [];

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
// 第 6 个里程碑再做中断，现在按 Ctrl-C 直接退出
rl.on("SIGINT", () => process.exit(130));

// 模型回复期间按 Ctrl-D（或管道输入读完）时 readline 已经关闭，不能再显示提示符
let closed = false;
rl.on("close", () => {
  closed = true;
});
function prompt(): void {
  if (!closed) rl.prompt();
}

console.log(styleText("dim", `模型 ${model}，工作目录 ${cwd}。输入 /exit 或按 Ctrl-D 退出。`));
prompt();

for await (const line of rl) {
  const input = line.trim();
  if (input === "/exit") break;
  if (input === "") {
    prompt();
    continue;
  }

  try {
    const result = await runAgent([...history, { role: "user", content: input }], {
      provider,
      system: SYSTEM_PROMPT,
      tools,
      cwd,
      onEvent: printEvent,
    });
    const added = result.messages.slice(history.length);
    history = result.messages;

    const usage = totalUsage(added);
    const turns = added.filter((m): m is AssistantMessage => m.role === "assistant").length;
    const parts = [`请求 ${turns} 次`, `输入 ${usage.inputTokens}`, `缓存读 ${usage.cacheReadTokens}`, `输出 ${usage.outputTokens} token`];
    if (result.stopReason !== "stop") parts.push(`停止原因 ${result.stopReason}`);
    console.log(styleText("dim", `[${parts.join("，")}]`));
  } catch (err) {
    // 这一轮的输入不进历史，下次重新输入即可
    console.error(styleText("red", `出错了：${err instanceof Error ? err.message : String(err)}`));
  }
  prompt();
}

rl.close();
