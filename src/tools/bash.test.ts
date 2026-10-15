import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, SANDBOX_ESCALATION_REASON } from "./bash.ts";
import type { CheckPermission, PermissionDecision, SandboxPolicy } from "../agent/types.ts";
import type { ToolCallBlock } from "../ai/types.ts";

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

test("中断时尽快结束命令，注明被用户中断", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  const result = await bashTool.execute({ command: "sleep 5" }, { cwd: dir, signal: controller.signal });
  assert.equal(result.isError, true);
  assert.match(result.content, /\[已被用户中断\]/);
  assert.ok(Date.now() - started < 3000);
});

test("定义里有 sandbox 参数", () => {
  const properties = bashTool.definition.parameters.properties as Record<string, unknown>;
  assert.ok("sandbox" in properties);
});

describe("沙箱", { skip: process.platform !== "darwin" && "沙箱只支持 macOS" }, () => {
  let project = "";
  let outside = "";
  let sandbox: SandboxPolicy;

  before(async () => {
    project = join(dir, "project");
    outside = join(dir, "outside");
    await mkdir(project);
    await mkdir(outside);
    sandbox = { writableDirs: [project], allowNetwork: true };
  });

  test("context 里有 sandbox 时在沙箱里执行，写不了项目外的文件", async () => {
    const result = await bashTool.execute({ command: `echo hi > ${outside}/a.txt` }, { cwd: project, sandbox });
    assert.equal(result.isError, true);
    assert.match(result.content, /Operation not permitted/);
    await assert.rejects(readFile(join(outside, "a.txt")));
  });

  test("沙箱里可以写项目目录", async () => {
    const result = await bashTool.execute({ command: "echo hi > in.txt && cat in.txt" }, { cwd: project, sandbox });
    assert.notEqual(result.isError, true);
    assert.match(result.content, /^hi\n/);
  });

  test("sandbox 为 false 时在沙箱外执行", async () => {
    const result = await bashTool.execute({ command: `echo hi > ${outside}/b.txt`, sandbox: false }, { cwd: project, sandbox });
    assert.notEqual(result.isError, true);
    assert.equal(await readFile(join(outside, "b.txt"), "utf8"), "hi\n");
  });

  /** 记录申请的假 checkPermission，按给定的决定回答 */
  function recorder(decision: PermissionDecision) {
    const calls: { toolCall: ToolCallBlock; reason: string | undefined }[] = [];
    const checkPermission: CheckPermission = async (toolCall, reason) => {
      calls.push({ toolCall, reason });
      return decision;
    };
    return { calls, checkPermission };
  }

  test("命令被中断后，即使输出里有沙箱错误也不申请重跑", async () => {
    const controller = new AbortController();
    const { calls, checkPermission } = recorder({ allowed: true });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await bashTool.execute({ command: `echo hi > ${outside}/interrupted.txt; sleep 5` }, {
        cwd: project, sandbox, checkPermission, signal: controller.signal,
      });
      assert.equal(result.isError, true);
      assert.match(result.content, /Operation not permitted/);
      assert.match(result.content, /\[已被用户中断\]$/);
      assert.equal(calls.length, 0);
      await assert.rejects(readFile(join(outside, "interrupted.txt")));
    } finally {
      clearTimeout(timer);
    }
  });

  test("被沙箱拦下时申请在沙箱外重新执行，同意后重新执行", async () => {
    const { calls, checkPermission } = recorder({ allowed: true });
    const command = `echo hi > ${outside}/escalate.txt && echo 写好了`;
    const result = await bashTool.execute({ command, timeout_ms: 5000 }, { cwd: project, sandbox, checkPermission });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.toolCall, {
      type: "toolCall",
      id: "sandbox-escalation",
      name: "bash",
      arguments: { command, timeout_ms: 5000, sandbox: false },
    });
    assert.equal(calls[0]!.reason, SANDBOX_ESCALATION_REASON);
    assert.notEqual(result.isError, true);
    assert.match(result.content, /^\[沙箱里被拦下，经用户同意在沙箱外重新执行\]\n/);
    assert.match(result.content, /写好了/);
    assert.equal(await readFile(join(outside, "escalate.txt"), "utf8"), "hi\n");
  });

  test("不同意时返回沙箱里那次的结果，并注明用户没有同意和理由", async () => {
    const { checkPermission } = recorder({ allowed: false, reason: "不要动项目外的文件" });
    const result = await bashTool.execute({ command: `echo hi > ${outside}/refused.txt` }, { cwd: project, sandbox, checkPermission });

    assert.equal(result.isError, true);
    assert.match(result.content, /Operation not permitted/);
    assert.match(result.content, /\n\[沙箱拦下了这个操作，用户没有同意在沙箱外执行：不要动项目外的文件\]$/);
    await assert.rejects(readFile(join(outside, "refused.txt")));
  });

  test("不是被沙箱拦下的失败、执行成功、已经在沙箱外，都不申请", async () => {
    const { calls, checkPermission } = recorder({ allowed: true });
    await bashTool.execute({ command: "exit 3" }, { cwd: project, sandbox, checkPermission });
    await bashTool.execute({ command: "echo ok" }, { cwd: project, sandbox, checkPermission });
    await bashTool.execute({ command: `echo hi > ${outside}/direct.txt`, sandbox: false }, { cwd: project, sandbox, checkPermission });
    await bashTool.execute({ command: "echo 'Operation not permitted'; exit 1" }, { cwd: project, checkPermission });
    assert.equal(calls.length, 0);
  });

  test("context 里没有 sandbox 时不用沙箱", async () => {
    const result = await bashTool.execute({ command: `echo hi > ${outside}/c.txt` }, { cwd: project });
    assert.notEqual(result.isError, true);
    assert.equal(await readFile(join(outside, "c.txt"), "utf8"), "hi\n");
  });
});
