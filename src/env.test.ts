import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectEnv } from "./env.ts";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-harness-env-"));
  await writeFile(join(dir, ".env"), "MH_TEST_FROM_FILE=file\nMH_TEST_EXISTING=file\n");
});

after(async () => {
  delete process.env.MH_TEST_FROM_FILE;
  delete process.env.MH_TEST_EXISTING;
  await rm(dir, { recursive: true, force: true });
});

test("读取 .env 里的变量", () => {
  loadProjectEnv(join(dir, ".env"));
  assert.equal(process.env.MH_TEST_FROM_FILE, "file");
});

test("已经存在的环境变量不被覆盖", () => {
  process.env.MH_TEST_EXISTING = "shell";
  loadProjectEnv(join(dir, ".env"));
  assert.equal(process.env.MH_TEST_EXISTING, "shell");
});

test("文件不存在时什么都不做", () => {
  assert.doesNotThrow(() => loadProjectEnv(join(dir, "nope.env")));
});
