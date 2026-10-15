import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand, type RunOptions } from "./process.ts";
import type { SandboxPolicy } from "../agent/types.ts";

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

test("中止信号触发后结束整组进程，aborted 为 true", async () => {
  const controller = new AbortController();
  const marker = join(dir, "abort-marker");
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const result = await runCommand(`(sleep 1; touch ${marker}) & sleep 10`, { ...options, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 3000);
  await new Promise((r) => setTimeout(r, 1500));
  await assert.rejects(realpath(marker));
});

test("信号已经中止时不执行命令", async () => {
  const marker = join(dir, "never-created");
  const result = await runCommand(`touch ${marker}`, { ...options, signal: AbortSignal.abort() });
  assert.equal(result.aborted, true);
  await assert.rejects(realpath(marker));
});

test("正常结束时 aborted 为 false", async () => {
  const result = await runCommand("true", { ...options, signal: new AbortController().signal });
  assert.equal(result.aborted, false);
});

describe("沙箱", { skip: process.platform !== "darwin" && "沙箱只支持 macOS" }, () => {
  let project = "";
  let outside = "";
  let server: Server;
  let port = 0;

  before(async () => {
    // 故意不解析符号链接，检查 runCommand 自己会处理 /var → /private/var
    const root = await mkdtemp(join(tmpdir(), "mini-harness-sbx-"));
    project = join(root, "project");
    outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  after(async () => {
    server.close();
    await rm(dirname(project), { recursive: true, force: true });
  });

  const policy = (allowNetwork = true): SandboxPolicy => ({ writableDirs: [project], allowNetwork });
  const run = (command: string, sandbox: SandboxPolicy) => runCommand(command, { cwd: project, timeoutMs: 5000, maxOutputChars: 2000, sandbox });

  test("可写目录里能写，目录外写不了", async () => {
    const inside = await run("echo hi > a.txt && cat a.txt", policy());
    assert.equal(inside.exitCode, 0);
    assert.equal(inside.output, "hi\n");

    const denied = await run(`echo hi > ${outside}/b.txt`, policy());
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.output, /Operation not permitted/);
    await assert.rejects(readFile(join(outside, "b.txt")));
  });

  test("可以读目录外的文件", async () => {
    const result = await run("head -c 1 /etc/hosts > /dev/null && echo read", policy());
    assert.equal(result.output, "read\n");
  });

  test("allowNetwork 控制能不能联网", async () => {
    const curl = `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/`;
    assert.equal((await run(curl, policy(true))).output, "200");
    const blocked = await run(curl, policy(false));
    assert.notEqual(blocked.exitCode, 0);
  });

  test("不设置 sandbox 时不受限制", async () => {
    const result = await runCommand(`echo hi > ${outside}/c.txt && cat ${outside}/c.txt`, { cwd: project, timeoutMs: 5000, maxOutputChars: 2000 });
    assert.equal(result.output, "hi\n");
  });
});
