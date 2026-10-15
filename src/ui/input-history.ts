// 输入历史存成 JSONL 文件，每行一条 JSON 字符串，多行的输入也是一条。

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_HISTORY } from "./editor.ts";

/**
 * 读取历史，从旧到新，最多 limit 条。文件不存在时返回空数组，坏掉的行跳过。
 * 文件里的条数超过 limit 的两倍时，只保留最新的 limit 条重新写回，避免文件一直变大
 */
export async function loadHistory(file: string, limit = MAX_HISTORY): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "string") entries.push(value);
    } catch {
      // 写到一半的行，跳过
    }
  }
  const kept = entries.slice(-limit);
  if (entries.length > limit * 2) {
    await writeFile(file, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  }
  return kept;
}

/** 追加一条历史，目录不存在时先创建 */
export async function appendHistory(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(text)}\n`);
}
