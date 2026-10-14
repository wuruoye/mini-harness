import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "./write-file.ts";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-harness-write-"));
});

after(() => rm(dir, { recursive: true, force: true }));

function run(args: Record<string, unknown>) {
  return writeFileTool.execute(args, { cwd: dir });
}

test("定义：名称是 write_file，path、content 必填", () => {
  assert.equal(writeFileTool.definition.name, "write_file");
  assert.deepEqual(writeFileTool.definition.parameters.required, ["path", "content"]);
});

test("新建文件，自动创建上级目录，结果里说明是新建", async () => {
  const result = await run({ path: "src/deep/new.txt", content: "你好\n" });
  assert.equal(await readFile(join(dir, "src/deep/new.txt"), "utf8"), "你好\n");
  assert.match(result.content, /新建/);
  assert.match(result.content, /new\.txt/);
});

test("覆盖已有文件，结果里说明是覆盖", async () => {
  await writeFile(join(dir, "old.txt"), "旧内容");
  const result = await run({ path: join(dir, "old.txt"), content: "新内容" });
  assert.equal(await readFile(join(dir, "old.txt"), "utf8"), "新内容");
  assert.match(result.content, /覆盖/);
});

test("content 可以是空字符串", async () => {
  await run({ path: "empty.txt", content: "" });
  assert.equal(await readFile(join(dir, "empty.txt"), "utf8"), "");
});

test("参数缺失、为空或类型不对时抛异常，信息里提到参数名", async () => {
  await assert.rejects(run({ content: "x" }), /\bpath\b/);
  await assert.rejects(run({ path: "", content: "x" }), /\bpath\b/);
  await assert.rejects(run({ path: "x.txt" }), /\bcontent\b/);
  await assert.rejects(run({ path: "x.txt", content: 1 }), /\bcontent\b/);
});
