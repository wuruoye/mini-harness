// 命令行入口：读取用户输入，交给主循环，把过程打印出来。

import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, styleText } from "node:util";
import { AnthropicProvider } from "./ai/anthropic.ts";
import type { AnthropicEffort } from "./ai/anthropic-types.ts";
import { OpenAIProvider } from "./ai/openai.ts";
import type { AssistantMessage, Message, Provider, ToolCallBlock, Usage } from "./ai/types.ts";
import { runAgent } from "./agent/loop.ts";
import {
  applyMode,
  DEFAULT_RULES,
  evaluatePermission,
  isPermissionMode,
  PERMISSION_MODES,
  permissionSubject,
  type PermissionMode,
  type PermissionRule,
} from "./agent/permission.ts";
import type { AgentEvent, PermissionDecision, SandboxPolicy } from "./agent/types.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { readFileTool } from "./tools/read-file.ts";
import { writeFileTool } from "./tools/write-file.ts";
import { loadProjectEnv } from "./env.ts";

loadProjectEnv();

const SYSTEM_PROMPT = `你是一个编程助手，在用户的项目目录里工作。
需要了解代码时，用工具读取文件，不要猜测文件内容。
修改已有文件用 edit，新建文件用 write_file，运行命令用 bash。改完代码后，能运行测试就运行测试确认。
用户拒绝某个操作时，按用户给的理由调整做法，不要换个方式重试同一件事。
回答使用中文，简洁直接。`;

const EFFORTS: AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

function fail(message: string): never {
  console.error(styleText("red", message));
  process.exit(1);
}

const RAW_DIR = join(import.meta.dirname, "..", "tmp");

/**
 * 设置了 MH_SAVE_RAW=1 时，返回一个会把原始响应另存一份的 fetch：
 * 每次请求的响应写到 mini-harness/tmp/<前缀>-<时间>.sse，可以用 pnpm replay 回放。
 * 没设置时返回 undefined，适配器用默认的 fetch。
 */
function rawSavingFetch(prefix: string): typeof fetch | undefined {
  if (process.env.MH_SAVE_RAW !== "1") return undefined;
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.body) return response;
    // tee 把响应流分成两份：一份照常交给适配器解析，一份写进文件
    const [forCaller, forFile] = response.body.tee();
    const file = join(RAW_DIR, `${prefix}-${Date.now()}.sse`);
    mkdir(RAW_DIR, { recursive: true })
      .then(() => writeFile(file, forFile))
      .then(() => console.error(styleText("dim", `[原始响应已保存到 ${file}]`)))
      .catch((err: unknown) => console.error(styleText("red", `保存原始响应失败：${String(err)}`)));
    return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
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
      fetch: rawSavingFetch("anthropic"),
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
      fetch: rawSavingFetch("openai"),
    });
    return { provider, model: `openai ${model}` };
  }

  fail(`LLM_PROVIDER 只能是 anthropic 或 openai，现在是 ${name}`);
}

const { provider, model } = createProvider();
const tools = [readFileTool, bashTool, editTool, writeFileTool];
// 本次会话的权限规则；回答「本次会话都允许」时会往后追加
const rules: PermissionRule[] = [...DEFAULT_RULES];
const cwd = process.cwd();

/** 权限模式：启动参数 --mode 优先，其次是环境变量 MH_PERMISSION_MODE，都没有时为 default */
function initialMode(): PermissionMode {
  let fromArgs: string | undefined;
  try {
    fromArgs = parseArgs({ options: { mode: { type: "string" } } }).values.mode;
  } catch (err) {
    fail(`启动参数有误：${err instanceof Error ? err.message : String(err)}`);
  }
  // .env 里写了 MH_PERMISSION_MODE= 但没填值时，按没设置处理
  const value = fromArgs ?? (process.env.MH_PERMISSION_MODE || "default");
  if (!isPermissionMode(value)) {
    fail(`权限模式只能是 ${Object.keys(PERMISSION_MODES).join("、")} 之一，现在是 ${value}`);
  }
  if (value === "sandbox" && process.platform !== "darwin") fail("sandbox 模式目前只支持 macOS");
  return value;
}

/**
 * sandbox 模式下 bash 的沙箱配置：可写的是工作目录、临时目录，以及 MH_SANDBOX_WRITABLE 里列出的目录（冒号分隔，可以用 ~）；
 * MH_SANDBOX_NETWORK=off 时禁止联网
 */
const sandboxPolicy: SandboxPolicy = {
  writableDirs: [
    cwd,
    tmpdir(),
    "/tmp",
    ...(process.env.MH_SANDBOX_WRITABLE ?? "")
      .split(":")
      .map((dir) => dir.trim())
      .filter((dir) => dir !== "")
      .map((dir) => resolve(cwd, dir.replace(/^~(?=$|\/)/, homedir()))),
  ],
  allowNetwork: process.env.MH_SANDBOX_NETWORK !== "off",
};

let mode = initialMode();

function describeMode(): string {
  const text = `权限模式 ${mode}：${PERMISSION_MODES[mode]}`;
  if (mode === "bypass") return styleText("red", `${text}。建议只在容器或临时目录里这样用`);
  if (mode === "sandbox") {
    const network = sandboxPolicy.allowNetwork ? "可以联网" : "禁止联网";
    return styleText("dim", `${text}。沙箱里可写：${sandboxPolicy.writableDirs.join("、")}；${network}`);
  }
  return styleText("dim", text);
}

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

// 所有输入行进同一个队列，主循环读问题、权限询问读回答，都按顺序从这里取。
// 这样运行中提前输入的内容，或者管道一次送进来的多行，都不会被读错位置
const pendingLines: string[] = [];
const waiting: ((line: string | undefined) => void)[] = [];
// 按 Ctrl-D（或管道输入读完）后 readline 关闭，之后读不到新的行
let closed = false;
rl.on("line", (line) => {
  const resolve = waiting.shift();
  if (resolve) resolve(line);
  else pendingLines.push(line);
});
rl.on("close", () => {
  closed = true;
  for (const resolve of waiting.splice(0)) resolve(undefined);
});

/** 取下一行输入；输入已经关闭且没有剩余时返回 undefined */
function nextLine(): Promise<string | undefined> {
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
  if (closed) return Promise.resolve(undefined);
  return new Promise((resolve) => waiting.push(resolve));
}

/** 显示问题，读用户的回答 */
function ask(query: string): Promise<string | undefined> {
  process.stdout.write(query);
  return nextLine();
}

/** 按规则判断；需要询问时在命令行里问用户 */
async function checkPermission(call: ToolCallBlock): Promise<PermissionDecision> {
  const action = applyMode(mode, evaluatePermission(rules, call.name, call.arguments), call.name, call.arguments, cwd);
  if (action === "allow") return { allowed: true };
  if (action === "deny") {
    console.log(styleText("red", "  权限规则禁止这个操作，已拒绝"));
    return { allowed: false, reason: "权限规则禁止这个操作" };
  }

  const subject = permissionSubject(call.name, call.arguments);
  const always = subject ? `本次会话都允许「${subject}」` : `本次会话都允许 ${call.name}`;
  const answer = await ask(
    styleText("yellow", `  需要确认：[y] 允许  [a] ${always}  [n] 拒绝，或者直接输入拒绝的理由\n  `) + "> ",
  );
  if (answer === undefined) return { allowed: false, reason: "没有办法向用户确认" };

  const reply = answer.trim();
  if (reply === "y") return { allowed: true };
  if (reply === "a") {
    rules.push({ tool: call.name, ...(subject && { pattern: subject }), action: "allow" });
    return { allowed: true };
  }
  if (reply === "" || reply === "n") return { allowed: false };
  return { allowed: false, reason: reply };
}

function prompt(): void {
  // 不是默认模式时，在提示符前面标出来
  rl.setPrompt(mode === "default" ? "> " : `[${mode}] > `);
  if (!closed) rl.prompt();
}

console.log(styleText("dim", `模型 ${model}，工作目录 ${cwd}。输入 /exit 或按 Ctrl-D 退出，/mode 切换权限模式。`));
console.log(describeMode());

while (true) {
  prompt();
  const line = await nextLine();
  if (line === undefined) break;
  const input = line.trim();
  if (input === "/exit") break;
  if (input === "/mode" || input.startsWith("/mode ")) {
    const next = input.slice("/mode".length).trim();
    if (next === "") {
      for (const [name, text] of Object.entries(PERMISSION_MODES)) {
        console.log(`${name === mode ? "*" : " "} ${name.padEnd(12)} ${styleText("dim", text)}`);
      }
    } else if (next === "sandbox" && process.platform !== "darwin") {
      console.log(styleText("red", "sandbox 模式目前只支持 macOS"));
    } else if (isPermissionMode(next)) {
      mode = next;
      console.log(describeMode());
    } else {
      console.log(styleText("red", `没有这个模式：${next}。输入 /mode 查看所有模式`));
    }
    continue;
  }
  if (input === "") continue;

  try {
    const result = await runAgent([...history, { role: "user", content: input }], {
      provider,
      system: SYSTEM_PROMPT,
      tools,
      cwd,
      onEvent: printEvent,
      checkPermission,
      sandbox: mode === "sandbox" ? sandboxPolicy : undefined,
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
}

rl.close();
