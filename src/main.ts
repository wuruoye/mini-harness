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
import { appendCompaction, appendMessage, createSession, listSessions, loadSession, type Session } from "./agent/session.ts";
import { buildContext, compact, contextTokens } from "./agent/compaction.ts";

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

/** 启动参数：--mode 权限模式，--continue 接着上次的会话，--resume <id> 打开指定会话 */
function parseCli() {
  try {
    return parseArgs({
      options: {
        mode: { type: "string" },
        continue: { type: "boolean", default: false },
        resume: { type: "string" },
      },
    }).values;
  } catch (err) {
    fail(`启动参数有误：${err instanceof Error ? err.message : String(err)}`);
  }
}

const cli = parseCli();

/** 权限模式：启动参数 --mode 优先，其次是环境变量 MH_PERMISSION_MODE，都没有时为 auto */
function initialMode(): PermissionMode {
  // .env 里写了 MH_PERMISSION_MODE= 但没填值时，按没设置处理
  const value = cli.mode ?? (process.env.MH_PERMISSION_MODE || "auto");
  if (!isPermissionMode(value)) {
    fail(`权限模式只能是 ${Object.keys(PERMISSION_MODES).join("、")} 之一，现在是 ${value}`);
  }
  if (value === "auto" && process.platform !== "darwin") fail("auto 模式依赖 macOS 的沙箱，在其他系统上请用 --mode bypass");
  return value;
}

/**
 * auto 模式下 bash 的沙箱配置：可写的是工作目录、临时目录，以及 MH_SANDBOX_WRITABLE 里列出的目录（冒号分隔，可以用 ~）；
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
  if (mode === "auto") {
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

/** 读取正整数配置，没设置时用默认值 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} 必须是正整数，现在是 ${raw}`);
  return value;
}

/** 上下文估算超过 COMPACT_AT 个 token 时，发新问题前先压缩；压缩时保留最近大约 COMPACT_KEEP 个 token */
const COMPACT_AT = positiveInt("MH_COMPACT_AT", 100_000);
const COMPACT_KEEP = positiveInt("MH_COMPACT_KEEP", 20_000);

/** 会话文件放在 MH_SESSION_DIR，默认 ~/.mini-harness/sessions */
const SESSION_BASE = process.env.MH_SESSION_DIR || join(homedir(), ".mini-harness", "sessions");

/** 当前会话；新会话在发出第一条消息时才创建文件，避免留下空会话 */
let session: Session | undefined;

async function openInitialSession(): Promise<Session | undefined> {
  if (cli.continue && cli.resume) fail("--continue 和 --resume 只能用一个");
  if (cli.continue) {
    const [latest] = await listSessions(SESSION_BASE, cwd);
    if (!latest) {
      console.log(styleText("dim", "这个目录还没有会话，将开始新会话"));
      return undefined;
    }
    return loadSession(latest.file);
  }
  if (cli.resume) {
    const found = (await listSessions(SESSION_BASE, cwd)).find((info) => info.id === cli.resume);
    if (!found) fail(`在 ${cwd} 的会话里找不到 ${cli.resume}，运行后输入 /sessions 可以查看`);
    return loadSession(found.file);
  }
  return undefined;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

/** 压缩一次上下文并写进会话，返回是否真的压缩了 */
async function compactSession(target: Session): Promise<boolean> {
  const previous = target.compaction;
  console.log(styleText("dim", "正在压缩上下文……"));
  const result = await compact(provider, target.messages, previous, COMPACT_KEEP);
  if (!result) {
    console.log(styleText("dim", "没有可以压缩的内容"));
    return false;
  }
  await appendCompaction(target, result);
  const after = contextTokens(buildContext(target.messages, result));
  const replaced = result.firstKeptIndex - (previous?.firstKeptIndex ?? 0);
  console.log(styleText("dim", `[已压缩上下文：约 ${result.tokensBefore} → ${after} token，${replaced} 条消息换成了摘要]`));
  return true;
}

async function printSessions(): Promise<void> {
  const list = await listSessions(SESSION_BASE, cwd);
  if (list.length === 0) {
    console.log(styleText("dim", "这个目录还没有会话"));
    return;
  }
  for (const info of list) {
    const mark = info.id === session?.id ? "*" : " ";
    console.log(`${mark} ${info.id}  ${styleText("dim", `${formatTime(info.updatedAt)}  ${info.messageCount} 条`)}  ${info.preview}`);
  }
}

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

/** 按规则判断；需要询问时在命令行里问用户。reason 是工具额外给出的说明，询问前先显示 */
async function checkPermission(call: ToolCallBlock, reason?: string): Promise<PermissionDecision> {
  const action = applyMode(mode, evaluatePermission(rules, call.name, call.arguments), call.name, call.arguments, cwd);
  if (action === "allow") return { allowed: true };
  if (action === "deny") {
    console.log(styleText("red", "  权限规则禁止这个操作，已拒绝"));
    return { allowed: false, reason: "权限规则禁止这个操作" };
  }

  if (reason) console.log(styleText("yellow", `  ${reason}`));
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
  rl.setPrompt(mode === "auto" ? "> " : `[${mode}] > `);
  if (!closed) rl.prompt();
}

console.log(
  styleText(
    "dim",
    `模型 ${model}，工作目录 ${cwd}。输入 /exit 或按 Ctrl-D 退出，/mode 切换权限模式，/sessions 列出会话，/new 开新会话，/compact 压缩上下文。`,
  ),
);
console.log(describeMode());
session = await openInitialSession();
if (session) {
  console.log(styleText("dim", `已恢复会话 ${session.id}，共 ${session.messages.length} 条消息`));
}

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
    } else if (next === "auto" && process.platform !== "darwin") {
      console.log(styleText("red", "auto 模式依赖 macOS 的沙箱"));
    } else if (isPermissionMode(next)) {
      mode = next;
      console.log(describeMode());
    } else {
      console.log(styleText("red", `没有这个模式：${next}。输入 /mode 查看所有模式`));
    }
    continue;
  }
  if (input === "/sessions") {
    await printSessions();
    continue;
  }
  if (input === "/compact") {
    if (!session) console.log(styleText("dim", "还没有对话，不需要压缩"));
    else {
      try {
        await compactSession(session);
      } catch (err) {
        console.error(styleText("red", `压缩失败：${err instanceof Error ? err.message : String(err)}`));
      }
    }
    continue;
  }
  if (input === "/new") {
    session = undefined;
    console.log(styleText("dim", "已开始新会话"));
    continue;
  }
  if (input === "") continue;

  if (!session) {
    session = await createSession(SESSION_BASE, cwd);
    console.log(styleText("dim", `会话保存在 ${session.file}`));
  }
  const current = session;

  // 上下文太大时，发新问题前先压缩；压缩失败不影响这次提问
  if (contextTokens(buildContext(current.messages, current.compaction)) > COMPACT_AT) {
    try {
      await compactSession(current);
    } catch (err) {
      console.error(styleText("red", `压缩失败，这次先不压缩：${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 发给模型的是压缩后的上下文；会话里仍然保存全部消息
  const context = buildContext(current.messages, current.compaction);
  const userMessage: Message = { role: "user", content: input };
  // 每条新消息产生时立刻写进会话文件；写文件是异步的，先收集起来，这一轮结束后统一等待
  const writes: Promise<void>[] = [appendMessage(current, userMessage)];

  try {
    const result = await runAgent([...context, userMessage], {
      provider,
      system: SYSTEM_PROMPT,
      tools,
      cwd,
      onEvent: (event) => {
        printEvent(event);
        if (event.type === "message") writes.push(appendMessage(current, event.message));
      },
      checkPermission,
      sandbox: mode === "auto" ? sandboxPolicy : undefined,
    });
    const added = result.messages.slice(context.length);

    const usage = totalUsage(added);
    const turns = added.filter((m): m is AssistantMessage => m.role === "assistant").length;
    const parts = [
      `请求 ${turns} 次`,
      `输入 ${usage.inputTokens}`,
      `缓存读 ${usage.cacheReadTokens}`,
      `输出 ${usage.outputTokens} token`,
      `上下文约 ${contextTokens(result.messages)} token`,
    ];
    if (result.stopReason !== "stop") parts.push(`停止原因 ${result.stopReason}`);
    console.log(styleText("dim", `[${parts.join("，")}]`));
  } catch (err) {
    // 已经产生的消息都已写进会话，下次接着这些历史继续
    console.error(styleText("red", `出错了：${err instanceof Error ? err.message : String(err)}`));
  }
  try {
    await Promise.all(writes);
  } catch (err) {
    console.error(styleText("red", `保存会话失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

rl.close();
