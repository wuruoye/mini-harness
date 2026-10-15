import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendHistory, loadHistory } from "./input-history.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mini-harness-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("文件不存在时为空；追加后按顺序读回，多行内容是一条", async (t) => {
  const file = join(await temporaryDirectory(t), "sub", "history.jsonl");
  assert.deepEqual(await loadHistory(file), []);
  await appendHistory(file, "第一条");
  await appendHistory(file, "第二条\n有两行");
  assert.deepEqual(await loadHistory(file), ["第一条", "第二条\n有两行"]);
});

test("跳过坏掉的行，只返回最新的 limit 条", async (t) => {
  const file = join(await temporaryDirectory(t), "history.jsonl");
  await writeFile(file, ['"一"', "坏掉的", "42", '"二"', '"三"', '"四'].join("\n"));
  assert.deepEqual(await loadHistory(file, 2), ["二", "三"]);
});

test("条数超过 limit 的两倍时，只保留最新的 limit 条写回文件", async (t) => {
  const file = join(await temporaryDirectory(t), "history.jsonl");
  for (const n of [1, 2, 3, 4, 5]) await appendHistory(file, String(n));
  assert.deepEqual(await loadHistory(file, 2), ["4", "5"]);
  assert.equal(await readFile(file, "utf8"), '"4"\n"5"\n');
});
