import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash.ts";

let dir = "";

before(async () => {
  // macOS 的临时目录 /var 是 /private/var 的符号链接，pwd 输出的是真实路径
  dir = await realpath(await mkdtemp(join(tmpdir(), "mini-harness-bash-")));
});

after(() => rm(dir, { recursive: true, force: true }));

function run(args: Record<string, unknown>) {
  return bashTool.execute(args, { cwd: dir });
}

test("定义：名称是 bash，command 必填", () => {
  assert.equal(bashTool.definition.name, "bash");
  assert.deepEqual(bashTool.definition.parameters.required, ["command"]);
});

test("在工作目录里执行，返回输出和退出码", async () => {
  const result = await run({ command: "pwd" });
  assert.notEqual(result.isError, true);
  assert.ok(result.content.startsWith(`${dir}\n`));
  assert.match(result.content, /\[退出码 0\]/);
});

test("退出码不为 0 时 isError 为 true，输出里包括 stderr", async () => {
  const result = await run({ command: "echo oops >&2; exit 2" });
  assert.equal(result.isError, true);
  assert.match(result.content, /oops/);
  assert.match(result.content, /\[退出码 2\]/);
});

test("超时后结束命令，isError 为 true，内容里说明超时", async () => {
  const started = Date.now();
  const result = await run({ command: "sleep 5", timeout_ms: 200 });
  assert.equal(result.isError, true);
  assert.match(result.content, /超时/);
  assert.ok(Date.now() - started < 4000);
});

test("输出太长时中间省略", async () => {
  const result = await run({ command: "seq 1 20000" });
  assert.match(result.content, /省略/);
  assert.ok(result.content.startsWith("1\n"));
  assert.match(result.content, /20000\n/);
});

test("command 缺失、为空或不是字符串时抛异常，信息里提到 command", async () => {
  await assert.rejects(run({}), /\bcommand\b/);
  await assert.rejects(run({ command: "" }), /\bcommand\b/);
  await assert.rejects(run({ command: 1 }), /\bcommand\b/);
});

test("timeout_ms 不是正数时抛异常，信息里提到 timeout_ms", async () => {
  await assert.rejects(run({ command: "true", timeout_ms: 0 }), /timeout_ms/);
  await assert.rejects(run({ command: "true", timeout_ms: -1 }), /timeout_ms/);
  await assert.rejects(run({ command: "true", timeout_ms: "1000" }), /timeout_ms/);
});
