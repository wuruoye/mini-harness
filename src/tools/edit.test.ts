import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit.ts";

let dir = "";
let file = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-harness-edit-"));
  file = join(dir, "a.txt");
});

beforeEach(() => writeFile(file, "alpha\nbeta\ngamma\nbeta\n"));

after(() => rm(dir, { recursive: true, force: true }));

function run(args: Record<string, unknown>) {
  return editTool.execute(args, { cwd: dir });
}

const read = () => readFile(file, "utf8");

test("定义：名称是 edit，path、old_string、new_string 必填", () => {
  assert.equal(editTool.definition.name, "edit");
  assert.deepEqual(editTool.definition.parameters.required, ["path", "old_string", "new_string"]);
});

test("替换只出现一次的原文，相对路径按工作目录解析", async () => {
  const result = await run({ path: "a.txt", old_string: "alpha", new_string: "ALPHA" });
  assert.equal(await read(), "ALPHA\nbeta\ngamma\nbeta\n");
  assert.match(result.content, /a\.txt/);
  assert.notEqual(result.isError, true);
});

test("可以跨行匹配", async () => {
  await run({ path: file, old_string: "alpha\nbeta\n", new_string: "one\n" });
  assert.equal(await read(), "one\ngamma\nbeta\n");
});

test("原文出现多次且没设 replace_all 时抛异常，信息里有次数，文件不变", async () => {
  await assert.rejects(run({ path: "a.txt", old_string: "beta", new_string: "BETA" }), /2/);
  assert.equal(await read(), "alpha\nbeta\ngamma\nbeta\n");
});

test("replace_all 替换全部，结果里有替换的处数", async () => {
  const result = await run({ path: "a.txt", old_string: "beta", new_string: "BETA", replace_all: true });
  assert.equal(await read(), "alpha\nBETA\ngamma\nBETA\n");
  assert.match(result.content, /2/);
});

test("找不到原文时抛异常，信息里有路径，文件不变", async () => {
  await assert.rejects(run({ path: "a.txt", old_string: "delta", new_string: "x" }), /a\.txt/);
  assert.equal(await read(), "alpha\nbeta\ngamma\nbeta\n");
});

test("文件不存在时抛异常，信息里有路径", async () => {
  await assert.rejects(run({ path: "missing.txt", old_string: "a", new_string: "b" }), /missing\.txt/);
});

test("old_string 和 new_string 相同时抛异常", async () => {
  await assert.rejects(run({ path: "a.txt", old_string: "alpha", new_string: "alpha" }));
});

test("new_string 里的 $& 和 $1 原样写入", async () => {
  await run({ path: "a.txt", old_string: "gamma", new_string: "price: $& and $1" });
  assert.equal(await read(), "alpha\nbeta\nprice: $& and $1\nbeta\n");
});

test("参数缺失、为空或类型不对时抛异常，信息里提到参数名", async () => {
  await assert.rejects(run({ old_string: "a", new_string: "b" }), /\bpath\b/);
  await assert.rejects(run({ path: "a.txt", new_string: "b" }), /old_string/);
  await assert.rejects(run({ path: "a.txt", old_string: "", new_string: "b" }), /old_string/);
  await assert.rejects(run({ path: "a.txt", old_string: "alpha", new_string: 1 }), /new_string/);
});
