import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSystemPrompt, detectEnvironment, findGitRoot, loadInstructionFiles, MAX_INSTRUCTION_CHARS, readInstructionFile } from "./system-prompt.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mini-harness-instructions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("仓库根目录：向上查找，支持 .git 目录、文件和嵌套仓库", async (t) => {
  const base = await temporaryDirectory(t);
  assert.equal(await findGitRoot(base), undefined);
  const repo = join(base, "repo");
  const child = join(repo, "src", "child");
  await mkdir(child, { recursive: true });
  await mkdir(join(repo, ".git"));
  assert.equal(await findGitRoot(child), repo);
  await rm(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git"), "gitdir: /worktrees/example");
  assert.equal(await findGitRoot(child), repo);
  await writeFile(join(child, ".git"), "gitdir: /submodules/example");
  assert.equal(await findGitRoot(child), child);
});

test("指令文件：文件名优先级、空文件、读取失败与截断", async (t) => {
  const dir = await temporaryDirectory(t);
  const agents = join(dir, "AGENTS.md");
  const claude = join(dir, "CLAUDE.md");
  assert.equal(await readInstructionFile(dir), undefined);
  await writeFile(agents, "  优先读取  \n");
  await writeFile(claude, "备用指令");
  assert.deepEqual(await readInstructionFile(dir), { path: agents, content: "优先读取" });
  await writeFile(agents, " \n\t");
  assert.equal(await readInstructionFile(dir), undefined);
  await rm(agents);
  await mkdir(agents);
  assert.deepEqual(await readInstructionFile(dir), { path: claude, content: "备用指令" });
  await rm(agents, { recursive: true });
  await writeFile(agents, "长".repeat(MAX_INSTRUCTION_CHARS + 5));
  const truncated = await readInstructionFile(dir);
  assert.ok(truncated);
  assert.ok(truncated.content.startsWith("长".repeat(MAX_INSTRUCTION_CHARS)));
  assert.match(truncated.content, /省略 5 个字符/);
  if (process.getuid?.() !== 0 && process.platform !== "win32") {
    await chmod(agents, 0o000);
    assert.deepEqual(await readInstructionFile(dir), { path: claude, content: "备用指令" });
  }
});

test("全局到项目逐层读取、路径去重，没有仓库根目录时只读工作目录", async (t) => {
  const base = await temporaryDirectory(t);
  const globalDir = join(base, "global");
  const repo = join(base, "repo");
  const middle = join(repo, "src");
  const cwd = join(middle, "feature");
  await mkdir(globalDir);
  await mkdir(cwd, { recursive: true });
  const paths = [join(globalDir, "AGENTS.md"), join(repo, "AGENTS.md"), join(middle, "CLAUDE.md"), join(cwd, "AGENTS.md")];
  await Promise.all(paths.map((path, index) => writeFile(path, `第 ${index} 层`)));
  const files = await loadInstructionFiles({ cwd, gitRoot: repo, globalDir });
  assert.deepEqual(files.map((file) => file.path), paths);
  const deduplicated = await loadInstructionFiles({ cwd, gitRoot: repo, globalDir: repo });
  assert.deepEqual(deduplicated.map((file) => file.path), paths.slice(1));
  const withoutRoot = await loadInstructionFiles({ cwd, globalDir });
  assert.deepEqual(withoutRoot.map((file) => file.path), [paths[0], paths[3]]);
  await assert.rejects(loadInstructionFiles({ cwd, gitRoot: globalDir, globalDir }), /gitRoot/);
});

test("环境使用本地日期，系统提示按固定顺序拼接并处理无指令、无仓库", async (t) => {
  const dir = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await mkdir(join(dir, ".git"));
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const env = await detectEnvironment(dir, new Date("2026-10-16T03:30:00Z"));
    assert.equal(env.cwd, dir);
    assert.equal(env.platform, process.platform);
    assert.equal(env.date, "2026-10-15");
    assert.equal(env.gitRoot, dir);
    const files = [{ path: join(dir, "AGENTS.md"), content: "项目规则" }];
    const prompt = buildSystemPrompt(files, env);
    assert.ok(prompt.startsWith("# 项目指令\n"));
    assert.ok(prompt.includes(`<instructions path="${files[0]!.path}">\n项目规则\n</instructions>\n\n# 环境\n`));
    assert.ok(prompt.includes("- 日期：2026-10-15"));
    assert.equal(buildSystemPrompt(files, env), prompt);
    const noGit = await detectEnvironment(outside, new Date("2026-10-16T03:30:00Z"));
    const plain = buildSystemPrompt([], noGit);
    assert.equal(noGit.gitRoot, undefined);
    assert.equal(plain.includes("# 项目指令"), false);
    assert.ok(plain.startsWith("# 环境\n"));
    assert.ok(plain.endsWith("- 不是 git 仓库"));
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("没有指令文件的层跳过，工作目录就是仓库根目录时只读一次", async (t) => {
  const base = await temporaryDirectory(t);
  const globalDir = join(base, "global");
  const repo = join(base, "repo");
  const cwd = join(repo, "a", "b");
  await mkdir(globalDir);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "最里层");
  assert.deepEqual(await loadInstructionFiles({ cwd, gitRoot: repo, globalDir }), [{ path: join(cwd, "AGENTS.md"), content: "最里层" }]);
  await writeFile(join(repo, "AGENTS.md"), "根目录");
  const atRoot = await loadInstructionFiles({ cwd: repo, gitRoot: repo, globalDir });
  assert.deepEqual(atRoot, [{ path: join(repo, "AGENTS.md"), content: "根目录" }]);
});

test("日期的月和日补齐两位", async (t) => {
  const dir = await temporaryDirectory(t);
  const env = await detectEnvironment(dir, new Date(2026, 0, 5, 12));
  assert.equal(env.date, "2026-01-05");
});

test("系统提示的完整格式：指令文件按顺序排列，最后是环境信息", () => {
  const env = { cwd: "/p/proj", platform: "darwin", date: "2026-10-15", gitRoot: "/p" };
  const files = [
    { path: "/h/AGENTS.md", content: "全局" },
    { path: "/p/proj/AGENTS.md", content: "项目" },
  ];
  assert.equal(
    buildSystemPrompt(files, env),
    [
      "# 项目指令",
      "下面是用户和项目提供的指令，越靠后越具体。",
      "",
      '<instructions path="/h/AGENTS.md">',
      "全局",
      "</instructions>",
      "",
      '<instructions path="/p/proj/AGENTS.md">',
      "项目",
      "</instructions>",
      "",
      "# 环境",
      "- 工作目录：/p/proj",
      "- 平台：darwin",
      "- 日期：2026-10-15",
      "- git 仓库根目录：/p",
    ].join("\n"),
  );
});
