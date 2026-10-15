import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import type { Message, ToolResultMessage } from "../ai/types.ts";
import {
  collectNestedInstructions,
  formatNestedInstructions,
  loadedFromHistory,
  NESTED_INSTRUCTIONS_HEADING,
  withNestedInstructions,
} from "./nested-instructions.ts";
import type { Tool, ToolResult } from "./types.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
  // macOS 的临时目录经过符号链接，取真实路径，实现里用不用 realpath 都能对上
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mini-harness-nested-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 按「相对路径 → 内容」建文件，自动创建上级目录 */
async function createFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** 一个假工具：返回固定结果，或者抛出异常；记录被调用的次数 */
function fakeTool(result: ToolResult | Error): Tool & { calls: number } {
  const tool = {
    calls: 0,
    definition: { name: "fake_read", description: "假工具", parameters: { type: "object" } },
    async execute(): Promise<ToolResult> {
      tool.calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return tool;
}

function toolResult(content: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: "t", toolName: "read_file", content, isError: false };
}

describe("collectNestedInstructions", () => {
  test("从工作目录的下一层往里逐层查找，按从外到内返回，并记进 loaded", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, {
      "AGENTS.md": "工作目录这一层",
      "a/AGENTS.md": "a 层",
      "a/b/CLAUDE.md": "b 层",
      "a/b/c/file.ts": "",
    });
    const loaded = new Set<string>();
    const files = await collectNestedInstructions("a/b/c/file.ts", cwd, loaded);
    assert.deepEqual(files, [
      { path: join(cwd, "a/AGENTS.md"), content: "a 层" },
      { path: join(cwd, "a/b/CLAUDE.md"), content: "b 层" },
    ]);
    assert.deepEqual([...loaded].sort(), [join(cwd, "a/AGENTS.md"), join(cwd, "a/b/CLAUDE.md")].sort());

    assert.deepEqual(await collectNestedInstructions(join(cwd, "a/b/c/file.ts"), cwd, loaded), []);
  });

  test("loaded 里已有的跳过，只返回新的", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/AGENTS.md": "a 层", "a/b/AGENTS.md": "b 层" });
    const loaded = new Set([join(cwd, "a/AGENTS.md")]);
    const files = await collectNestedInstructions("a/b/x.ts", cwd, loaded);
    assert.deepEqual(files.map((f) => f.path), [join(cwd, "a/b/AGENTS.md")]);
    assert.equal(loaded.size, 2);
  });

  test("工作目录这一层和工作目录外面的文件不加载", async (t) => {
    const base = await temporaryDirectory(t);
    const cwd = join(base, "proj");
    await createFiles(base, {
      "proj/AGENTS.md": "工作目录这一层",
      "other/AGENTS.md": "旁边的目录",
      // 名字以工作目录开头，但不在工作目录里面
      "proj-other/AGENTS.md": "名字相近的目录",
    });
    const loaded = new Set<string>();
    assert.deepEqual(await collectNestedInstructions("README.md", cwd, loaded), []);
    assert.deepEqual(await collectNestedInstructions("../other/x.ts", cwd, loaded), []);
    assert.deepEqual(await collectNestedInstructions(join(base, "other/x.ts"), cwd, loaded), []);
    assert.deepEqual(await collectNestedInstructions(join(base, "proj-other/x.ts"), cwd, loaded), []);
    assert.equal(loaded.size, 0);
  });

  test("直接读某一层的指令文件时，记为已加载但不返回；外层的照常返回", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/AGENTS.md": "a 层", "a/b/CLAUDE.md": "b 层" });
    const loaded = new Set<string>();
    const files = await collectNestedInstructions("a/b/CLAUDE.md", cwd, loaded);
    assert.deepEqual(files.map((f) => f.path), [join(cwd, "a/AGENTS.md")]);
    assert.ok(loaded.has(join(cwd, "a/b/CLAUDE.md")));
    assert.deepEqual(await collectNestedInstructions("a/b/x.ts", cwd, loaded), []);
  });

  test("没有指令文件、目录不存在时返回空数组", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/x.ts": "" });
    const loaded = new Set<string>();
    assert.deepEqual(await collectNestedInstructions("a/x.ts", cwd, loaded), []);
    assert.deepEqual(await collectNestedInstructions("new/dir/x.ts", cwd, loaded), []);
    assert.equal(loaded.size, 0);
  });
});

describe("formatNestedInstructions", () => {
  test("第一行是标题，指令文件按顺序放在 instructions 标签里", () => {
    const text = formatNestedInstructions([
      { path: "/p/a/AGENTS.md", content: "a 层" },
      { path: "/p/a/b/AGENTS.md", content: "b 层" },
    ]);
    assert.ok(text.startsWith(`${NESTED_INSTRUCTIONS_HEADING}\n`));
    const first = text.indexOf('<instructions path="/p/a/AGENTS.md">\na 层\n</instructions>');
    const second = text.indexOf('<instructions path="/p/a/b/AGENTS.md">\nb 层\n</instructions>');
    assert.ok(first > 0 && second > first);
  });
});

describe("withNestedInstructions", () => {
  test("definition 不变；执行成功后把新的指令接在结果后面，相对路径以 context.cwd 为准", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/AGENTS.md": "a 层" });
    const loaded = new Set<string>();
    const inner = fakeTool({ content: "文件内容" });
    const tool = withNestedInstructions(inner, "path", loaded);
    assert.deepEqual(tool.definition, inner.definition);

    const result = await tool.execute({ path: "a/x.ts" }, { cwd });
    const expected = formatNestedInstructions([{ path: join(cwd, "a/AGENTS.md"), content: "a 层" }]);
    assert.equal(result.content, `文件内容\n\n${expected}`);
    assert.ok(!result.isError);
    assert.ok(loaded.has(join(cwd, "a/AGENTS.md")));

    // 同一个目录再访问一次，没有新的指令，结果原样返回
    assert.deepEqual(await tool.execute({ path: "a/y.ts" }, { cwd }), { content: "文件内容" });
    assert.equal(inner.calls, 2);
  });

  test("结果出错或抛异常时不加载指令", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/AGENTS.md": "a 层" });
    const loaded = new Set<string>();

    const failed = { content: "找不到文件", isError: true };
    assert.deepEqual(await withNestedInstructions(fakeTool(failed), "path", loaded).execute({ path: "a/x.ts" }, { cwd }), failed);

    const throwing = withNestedInstructions(fakeTool(new Error("读取失败")), "path", loaded);
    await assert.rejects(throwing.execute({ path: "a/x.ts" }, { cwd }), /读取失败/);
    assert.equal(loaded.size, 0);
  });

  test("按 pathArg 取路径；路径不是非空字符串时结果原样返回", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/AGENTS.md": "a 层" });
    const loaded = new Set<string>();
    const tool = withNestedInstructions(fakeTool({ content: "结果" }), "file", loaded);

    for (const args of [{}, { file: "" }, { file: 42 }, { path: "a/x.ts" }]) {
      assert.deepEqual(await tool.execute(args, { cwd }), { content: "结果" });
    }
    assert.equal(loaded.size, 0);

    const result = await tool.execute({ file: "a/x.ts" }, { cwd });
    assert.ok(result.content.includes(NESTED_INSTRUCTIONS_HEADING));
  });
});

describe("loadedFromHistory", () => {
  test("只取工具结果里标题后面的路径，按出现顺序去重", () => {
    const section = (...paths: string[]) => formatNestedInstructions(paths.map((path) => ({ path, content: "规则" })));
    const messages: Message[] = [
      { role: "user", content: `${section("/user/AGENTS.md")}` },
      toolResult(`文件里的 <instructions path="/in-file/AGENTS.md">\n\n${section("/p/a/AGENTS.md", "/p/b/AGENTS.md")}`),
      { role: "assistant", content: [{ type: "text", text: section("/assistant/AGENTS.md") }], stopReason: "stop", provider: "fake", model: "fake" },
      toolResult("普通结果，没有指令"),
      toolResult(`内容\n\n${section("/p/a/AGENTS.md", "/p/c/AGENTS.md")}`),
    ];
    assert.deepEqual(loadedFromHistory(messages), ["/p/a/AGENTS.md", "/p/b/AGENTS.md", "/p/c/AGENTS.md"]);
    assert.deepEqual(loadedFromHistory([]), []);
  });

  test("包装后的工具结果放进历史，能还原出同样的已加载路径", async (t) => {
    const cwd = await temporaryDirectory(t);
    await createFiles(cwd, { "a/AGENTS.md": "a 层", "a/b/AGENTS.md": "b 层" });
    const loaded = new Set<string>();
    const tool = withNestedInstructions(fakeTool({ content: '读到的内容里有 <instructions path="/fake">' }), "path", loaded);
    const result = await tool.execute({ path: "a/b/x.ts" }, { cwd });
    assert.deepEqual(loadedFromHistory([toolResult(result.content)]), [...loaded]);
  });
});
