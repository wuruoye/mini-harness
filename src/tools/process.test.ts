import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type RunOptions } from "./process.ts";

let dir = "";
let options: RunOptions;

before(async () => {
  // macOS 的临时目录 /var 是 /private/var 的符号链接，pwd 输出的是真实路径
  dir = await realpath(await mkdtemp(join(tmpdir(), "mini-harness-proc-")));
  options = { cwd: dir, timeoutMs: 5000, maxOutputChars: 1000 };
});

after(() => rm(dir, { recursive: true, force: true }));

test("返回退出码和输出，在指定目录运行", async () => {
  const result = await runCommand("pwd; echo hi", options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `${dir}\nhi\n`);
  assert.equal(result.timedOut, false);
});

test("stdout 和 stderr 合在一起，非 0 退出码原样返回", async () => {
  const result = await runCommand("echo out; echo err >&2; exit 3", options);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
});

test("超时后结束整组进程，包括它启动的子进程", async () => {
  const marker = join(dir, "still-running");
  const started = Date.now();
  // 子进程睡 1 秒后创建文件；进程组被结束的话，文件不会出现
  const result = await runCommand(`(sleep 1; touch ${marker}) & sleep 10`, { ...options, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 3000);
  await new Promise((r) => setTimeout(r, 1500));
  await assert.rejects(realpath(marker));
});

test("输出超长时保留开头和结尾，中间注明省略了多少", async () => {
  const result = await runCommand("for i in $(seq 1 500); do echo line$i; done", options);
  assert.ok(result.totalChars > 1000);
  assert.ok(result.output.startsWith("line1\n"));
  assert.ok(result.output.endsWith("line500\n"));
  assert.match(result.output, /省略 \d+ 个字符/);
  assert.ok(result.output.length < 1100);
});

test("stdin 是关闭的，等待输入的命令不会卡住", async () => {
  const result = await runCommand("cat; echo done", options);
  assert.equal(result.output, "done\n");
});
