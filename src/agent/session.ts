// 会话存储：每个会话一个 JSONL 文件，每行一条记录，只追加、不改写。
// 文件放在 <baseDir>/<项目目录编码>/<会话 id>.jsonl，第一行是会话信息，后面每行一条消息。

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message } from "../ai/types.ts";

export const SESSION_VERSION = 1;

/** 会话文件里的一行 */
export type SessionEntry =
  | { type: "session"; version: number; id: string; cwd: string; createdAt: string }
  | { type: "message"; message: Message; timestamp: string };

export interface Session {
  id: string;
  /** 会话文件的绝对路径 */
  file: string;
  cwd: string;
  createdAt: string;
  /** 按顺序排列的全部消息 */
  messages: Message[];
}

export interface SessionInfo {
  id: string;
  file: string;
  createdAt: string;
  /** 最后一条记录的时间 */
  updatedAt: string;
  messageCount: number;
  /** 第一条用户消息的第一行，最多 50 个字符，超出部分用「…」代替；没有用户消息时为空字符串 */
  preview: string;
}

const pendingWrites = new WeakMap<Session, Promise<void>>();

/**
 * 某个项目的会话目录：baseDir 下面，以 cwd 编码后的名字命名的子目录。
 * 编码规则：cwd 里除了字母、数字、点、下划线、短横线以外的字符都换成短横线，
 * 比如 /Users/a/my proj → -Users-a-my-proj
 */
export function sessionDir(baseDir: string, cwd: string): string {
  return join(baseDir, cwd.replace(/[^a-zA-Z0-9._-]/g, "-"));
}

/**
 * 新建会话：生成 id，创建目录，写入第一行 session 记录，返回 messages 为空的 Session。
 * id 的格式是「UTC 时间-6 位十六进制随机数」，比如 20261014T083015Z-a1b2c3，
 * 按字符串排序就是按创建时间排序；createdAt 用 now.toISOString()
 */
export async function createSession(baseDir: string, cwd: string, now = new Date()): Promise<Session> {
  const createdAt = now.toISOString();
  const time = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dir = resolve(sessionDir(baseDir, cwd));
  await mkdir(dir, { recursive: true });

  while (true) {
    const id = `${time}-${randomBytes(3).toString("hex")}`;
    const file = join(dir, `${id}.jsonl`);
    const entry: SessionEntry = { type: "session", version: SESSION_VERSION, id, cwd, createdAt };
    try {
      await writeFile(file, JSON.stringify(entry) + "\n", { encoding: "utf8", flag: "wx" });
      return { id, file, cwd, createdAt, messages: [] };
    } catch (err) {
      // id 碰撞时换一个，避免覆盖已有会话。
      if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err;
    }
  }
}

/**
 * 追加一条消息：先把消息加到 session.messages（在函数里第一次 await 之前，调用一返回就能看到），
 * 再往文件末尾写一行 { type: "message", message, timestamp: now.toISOString() }。
 * 调用方可能不等上一次写完就接着调用（比如在同步的事件回调里），多次调用也要按调用顺序写入文件
 * 单次写入失败会报告给该次调用，后续调用仍会尝试写入。
 */
export async function appendMessage(session: Session, message: Message, now = new Date()): Promise<void> {
  session.messages.push(message);
  const entry: SessionEntry = { type: "message", message, timestamp: now.toISOString() };
  const line = JSON.stringify(entry) + "\n";
  const pending = (pendingWrites.get(session) ?? Promise.resolve())
    .catch(() => {})
    .then(() => appendFile(session.file, line, "utf8"));
  pendingWrites.set(session, pending);
  await pending;
}

/** 列表只读取记录；恢复会话时才修复文件尾部。 */
async function readSessionRecords(file: string, repair = false): Promise<{
  header: Extract<SessionEntry, { type: "session" }>;
  messages: Extract<SessionEntry, { type: "message" }>[];
}> {
  const contents = await readFile(file);
  let header: Extract<SessionEntry, { type: "session" }> | undefined;
  const messages: Extract<SessionEntry, { type: "message" }>[] = [];
  let offset = 0;
  let lineNumber = 0;

  while (offset < contents.length) {
    lineNumber++;
    const newline = contents.indexOf(0x0a, offset);
    const end = newline === -1 ? contents.length : newline;
    const line = contents.subarray(offset, end).toString("utf8").trim();
    if (line !== "") {
      let entry: SessionEntry;
      try {
        entry = JSON.parse(line);
      } catch (err) {
        if (newline === -1 && header) {
          // offset 是字节位置，中文等多字节内容也能正确截断。
          if (repair) await truncate(file, offset);
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`读取会话 ${file} 第 ${lineNumber} 行失败：${message}`);
      }

      if (header === undefined) {
        if (entry?.type !== "session") throw new Error(`会话 ${file} 的第一条记录必须是 session`);
        header = entry;
      } else {
        if (entry?.type !== "message") throw new Error(`会话 ${file} 第 ${lineNumber} 行必须是 message 记录`);
        messages.push(entry);
      }
      if (newline === -1 && repair) await appendFile(file, "\n", "utf8");
    }
    offset = newline === -1 ? contents.length : newline + 1;
  }

  if (header === undefined) throw new Error(`会话 ${file} 缺少 session 记录`);
  return { header, messages };
}

/**
 * 读取会话文件，还原成 Session。
 * - 第一条记录必须是 session，否则抛异常，信息里提到 session
 * - 空行跳过
 * - 文件最后一行如果不完整（写到一半时程序崩溃，没有换行结尾并且解析失败），忽略这一行，
 *   并把文件截掉这一段，免得之后追加的内容接在半行后面
 * - 其他解析失败的行抛异常，信息里带上行号，比如「第 3 行」
 */
export async function loadSession(file: string): Promise<Session> {
  const fullPath = resolve(file);
  const { header, messages } = await readSessionRecords(fullPath, true);
  return {
    id: header.id,
    file: fullPath,
    cwd: header.cwd,
    createdAt: header.createdAt,
    messages: messages.map((entry) => entry.message),
  };
}

/** 列出某个项目的所有会话，按 updatedAt 从新到旧排列；目录不存在时返回空数组 */
export async function listSessions(baseDir: string, cwd: string): Promise<SessionInfo[]> {
  const dir = resolve(sessionDir(baseDir, cwd));
  const files = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  });

  const sessions = await Promise.all(files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry): Promise<SessionInfo> => {
      const file = join(dir, entry.name);
      const { header, messages } = await readSessionRecords(file);
      const firstUser = messages.find((entry) => entry.message.role === "user")?.message;
      const firstLine = firstUser?.role === "user" ? firstUser.content.split(/\r\n?|\n/, 1)[0] ?? "" : "";
      return {
        id: header.id,
        file,
        createdAt: header.createdAt,
        updatedAt: messages.at(-1)?.timestamp ?? header.createdAt,
        messageCount: messages.length,
        preview: firstLine.length > 50 ? firstLine.slice(0, 50) + "…" : firstLine,
      };
    }));
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
