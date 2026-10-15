import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  createSkillTool,
  expandSkillCommand,
  findSkills,
  formatSkillsSection,
  loadSkills,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SKILL_DEPTH,
  parseSkillFile,
  renderSkill,
  SKILL_TOOL_DEFINITION,
  SKILL_TOOL_NAME,
  skillRoots,
  validateSkill,
  type Skill,
} from "./skills.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mini-harness-skills-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function skillFile(name: string, description = `${name} 的说明`, body = `${name} 的正文`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/** 在 root 下按「相对目录 → SKILL.md 内容」建技能 */
async function createSkills(root: string, skills: Record<string, string>): Promise<void> {
  for (const [dir, content] of Object.entries(skills)) {
    const file = join(root, dir, "SKILL.md");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

function names(skills: Skill[]): string[] {
  return skills.map((skill) => skill.name);
}

describe("parseSkillFile", () => {
  test("拆出 YAML 和正文，支持列表、嵌套字段、带引号的值和 \\r\\n", () => {
    const parsed = parseSkillFile(
      '---\r\nname: pdf\r\ndescription: "处理 PDF: 拆分、合并"\r\nallowed-tools:\r\n  - Read\r\nmetadata:\r\n  version: "2"\r\n---\r\n\r\n# 正文\r\n内容\r\n',
    );
    assert.deepEqual(parsed?.frontmatter, {
      name: "pdf",
      description: "处理 PDF: 拆分、合并",
      "allowed-tools": ["Read"],
      metadata: { version: "2" },
    });
    assert.equal(parsed?.body, "# 正文\n内容");
  });

  test("没有开头的 --- 时返回 undefined", () => {
    assert.equal(parseSkillFile("# 只有正文"), undefined);
    assert.equal(parseSkillFile("text\n---\nname: a\n---\n"), undefined);
    assert.equal(parseSkillFile("---\nname: a\n没有结束"), undefined);
  });

  test("YAML 有语法错误或者不是对象时抛异常", () => {
    assert.doesNotThrow(() => parseSkillFile("---\nname: a\n---\n正文"));
    assert.throws(() => parseSkillFile("---\nname: [a\n---\n正文"));
    assert.throws(() => parseSkillFile("---\n- a\n- b\n---\n正文"));
    assert.throws(() => parseSkillFile("---\n---\n正文"));
  });
});

describe("validateSkill", () => {
  test("合格的名字和说明", () => {
    assert.equal(validateSkill({ name: "pdf-tools2", description: "说明", license: "MIT" }), undefined);
    assert.equal(validateSkill({ name: "a".repeat(MAX_NAME_LENGTH), description: "x".repeat(MAX_DESCRIPTION_LENGTH) }), undefined);
  });

  test("名字和说明不合格时返回问题说明", () => {
    for (const name of ["", "PDF", "pdf_tools", "-pdf", "pdf-", "pdf--tools", "a".repeat(MAX_NAME_LENGTH + 1), 42, undefined]) {
      assert.equal(typeof validateSkill({ name, description: "说明" }), "string", String(name));
    }
    for (const description of [undefined, "", "  ", 42, "x".repeat(MAX_DESCRIPTION_LENGTH + 1)]) {
      assert.equal(typeof validateSkill({ name: "ok", description }), "string", String(description));
    }
  });
});

describe("findSkills", () => {
  test("递归查找，找到 SKILL.md 后不再往这个技能的子目录里找", async (t) => {
    const root = await temporaryDirectory(t);
    await createSkills(root, {
      alpha: skillFile("alpha"),
      "users/skills/beta": skillFile("beta"),
      "alpha/scripts/inner": skillFile("inner"),
      "zeta/deep": skillFile("gamma"),
    });
    const { skills, diagnostics } = await findSkills(root);
    assert.deepEqual(names(skills), ["alpha", "beta", "gamma"]);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(skills[1], {
      name: "beta",
      description: "beta 的说明",
      file: join(root, "users/skills/beta/SKILL.md"),
      dir: join(root, "users/skills/beta"),
    });
  });

  test("跳过 . 开头的目录和 node_modules，超过最大深度的不找", async (t) => {
    const root = await temporaryDirectory(t);
    const tooDeep = Array.from({ length: MAX_SKILL_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
    const deepest = Array.from({ length: MAX_SKILL_DEPTH }, (_, i) => `d${i}`).join("/");
    await createSkills(root, {
      ".git/hidden": skillFile("hidden"),
      "node_modules/dep": skillFile("dep"),
      [tooDeep]: skillFile("too-deep"),
      [`x/${deepest.split("/").slice(1).join("/")}`]: skillFile("deepest"),
    });
    assert.deepEqual(names((await findSkills(root)).skills), ["deepest"]);
  });

  test("跟随符号链接，同一个真实目录只进一次", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await createSkills(outside, { linked: skillFile("linked") });
    await symlink(outside, join(root, "link"));
    await symlink(root, join(root, "loop"));
    assert.deepEqual(names((await findSkills(root)).skills), ["linked"]);
  });

  test("不合格的技能跳过并记下问题，root 不存在时为空", async (t) => {
    const root = await temporaryDirectory(t);
    await createSkills(root, {
      good: skillFile("good", "  前后有空白  "),
      "bad-name": skillFile("Bad_Name"),
      "no-frontmatter": "# 没有开头的 YAML",
      "broken-yaml": "---\nname: [x\n---\n",
      "no-description": "---\nname: no-description\n---\n正文",
    });
    const { skills, diagnostics } = await findSkills(root);
    assert.deepEqual(names(skills), ["good"]);
    assert.equal(skills[0]?.description, "前后有空白");
    assert.deepEqual(
      diagnostics.map((d) => d.file).sort(),
      ["bad-name", "broken-yaml", "no-description", "no-frontmatter"].map((dir) => join(root, dir, "SKILL.md")),
    );
    assert.ok(diagnostics.every((d) => d.message !== ""));
    assert.deepEqual(await findSkills(join(root, "missing")), { skills: [], diagnostics: [] });
  });
});

describe("loadSkills 和 skillRoots", () => {
  test("名字重复时保留先找到的，同一个目录只找一次", async (t) => {
    const first = await temporaryDirectory(t);
    const second = await temporaryDirectory(t);
    await createSkills(first, { a: skillFile("shared", "第一个") });
    await createSkills(second, { b: skillFile("shared", "第二个"), c: skillFile("other") });
    const { skills, diagnostics } = await loadSkills([first, second, first, join(first, "missing")]);
    assert.deepEqual(names(skills), ["shared", "other"]);
    assert.equal(skills[0]?.description, "第一个");
    assert.deepEqual(diagnostics.map((d) => d.file), [join(second, "b", "SKILL.md")]);
  });

  test("默认使用自己的技能目录，再追加显式指定的额外目录", () => {
    assert.deepEqual(
      skillRoots({ cwd: "/repo/src/app", home: "/home/me", extra: ["~/skills", "shared", "/abs"] }),
      [
        "/home/me/.mini-harness/skills",
        "/home/me/skills",
        "/repo/src/app/shared",
        "/abs",
      ],
    );
    assert.deepEqual(skillRoots({ cwd: "/tmp/x", home: "/home/me" }), [
      "/home/me/.mini-harness/skills",
    ]);
  });
});

describe("使用技能", () => {
  async function setup(t: TestContext): Promise<Skill[]> {
    const root = await temporaryDirectory(t);
    await createSkills(root, { pdf: skillFile("pdf", "处理 PDF", "运行 scripts/split.py") });
    return (await findSkills(root)).skills;
  }

  test("系统提示里只列名字和说明；没有技能时为空", () => {
    const skills: Skill[] = [
      { name: "pdf-tools", description: "处理 PDF 文件", file: "/s/pdf-tools/SKILL.md", dir: "/s/pdf-tools" },
      { name: "domain-modeling", description: "整理项目的领域模型", file: "/s/d/SKILL.md", dir: "/s/d" },
    ];
    assert.equal(
      formatSkillsSection(skills),
      [
        "# 技能",
        "下面这些技能提供特定任务的做法。任务和某个技能的说明对得上时，先用 skill 工具加载它，再按里面的说明做。",
        "",
        "- pdf-tools：处理 PDF 文件",
        "- domain-modeling：整理项目的领域模型",
      ].join("\n"),
    );
    assert.equal(formatSkillsSection([]), "");
  });

  test("加载时每次重新读 SKILL.md，带上技能目录", async (t) => {
    const [skill] = await setup(t);
    assert.ok(skill);
    assert.equal(await renderSkill(skill), `<skill name="pdf" dir="${skill.dir}">\n运行 scripts/split.py\n</skill>`);
    await writeFile(skill.file, skillFile("pdf", "处理 PDF", "改过的正文"));
    assert.match(await renderSkill(skill), /改过的正文/);
  });

  test("skill 工具按名字返回正文；找不到时列出可用的技能", async (t) => {
    const skills = await setup(t);
    const tool = createSkillTool(skills);
    assert.deepEqual(tool.definition, SKILL_TOOL_DEFINITION);
    assert.equal(tool.definition.name, SKILL_TOOL_NAME);
    const result = await tool.execute({ name: "pdf" }, { cwd: "/work" });
    assert.ok(result.content.endsWith(await renderSkill(skills[0]!)));
    assert.match(result.content, new RegExp(skills[0]!.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await assert.rejects(tool.execute({ name: "nope" }, { cwd: "/work" }), /pdf/);
  });

  test("/skill:名字 参数 拼成用户消息", async (t) => {
    const skills = await setup(t);
    const rendered = await renderSkill(skills[0]!);
    assert.equal(await expandSkillCommand("普通问题", skills), undefined);
    assert.equal(await expandSkillCommand("/skill:pdf", skills), rendered);
    assert.equal(await expandSkillCommand("/skill:pdf  拆分 report.pdf  ", skills), `${rendered}\n\n拆分 report.pdf`);
    await assert.rejects(expandSkillCommand("/skill:nope 参数", skills), /pdf/);
  });
});
