import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_READ_CHARS, readFileTool } from "./read-file.ts";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-harness-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "hello.txt"), "你好\n世界\n");
});

after(() => rm(dir, { recursive: true, force: true }));

function run(args: Record<string, unknown>) {
  return readFileTool.execute(args, { cwd: dir });
}

test("定义：名称是 read_file，path 必填", () => {
  assert.equal(readFileTool.definition.name, "read_file");
  assert.deepEqual(readFileTool.definition.parameters.required, ["path"]);
});

test("按工作目录解析相对路径", async () => {
  const result = await run({ path: "sub/hello.txt" });
  assert.equal(result.content, "你好\n世界\n");
  assert.notEqual(result.isError, true);
});

test("支持绝对路径", async () => {
  const result = await run({ path: join(dir, "sub", "hello.txt") });
  assert.equal(result.content, "你好\n世界\n");
});

test("文件不存在时抛异常，错误信息里有文件路径", async () => {
  await assert.rejects(run({ path: "nope.txt" }), /nope\.txt/);
});

test("path 缺失或不是字符串时抛异常，错误信息提到 path", async () => {
  await assert.rejects(run({}), /\bpath\b/);
  await assert.rejects(run({ path: 42 }), /\bpath\b/);
});

test("超过 MAX_READ_CHARS 时截断并注明", async () => {
  const big = "a".repeat(MAX_READ_CHARS + 100);
  await writeFile(join(dir, "big.txt"), big);
  const { content } = await run({ path: "big.txt" });

  assert.ok(content.startsWith(big.slice(0, MAX_READ_CHARS)));
  assert.ok(!content.includes(big));
  assert.match(content, /截断/);
});
