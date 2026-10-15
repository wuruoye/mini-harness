// 技能（skill）：一个目录，里面的 SKILL.md 开头是一段 YAML（name、description），后面是正文，
// 目录里还可以放脚本和参考资料，格式按 Agent Skills 的约定。
// 启动时只把名字和说明放进系统提示；模型用 skill 工具按名字加载正文，用户也可以输入 /skill:名字 主动使用。

import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { ToolDefinition } from "../ai/types.ts";
import type { Tool } from "./types.ts";

export const SKILL_FILE = "SKILL.md";
export const SKILL_TOOL_NAME = "skill";
/** 用户主动使用技能的命令前缀，后面跟技能名和参数 */
export const SKILL_COMMAND_PREFIX = "/skill:";

/** 递归找技能时最多往下几层，技能根目录本身是第 0 层 */
export const MAX_SKILL_DEPTH = 6;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径 */
  file: string;
  /** 技能目录，也就是 SKILL.md 所在的目录；正文里的相对路径按它解析 */
  dir: string;
}

/** 加载技能时发现的问题，启动时显示给用户 */
export interface SkillDiagnostic {
  file: string;
  message: string;
}

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

/**
 * 拆开 SKILL.md：开头用 --- 包住的 YAML 和后面的正文。
 * - 先把 \r\n 换成 \n，Windows 上写的文件也能解析
 * - 第一行必须正好是 ---，到下一个正好是 --- 的行结束。没有这样的开头时返回 undefined
 * - YAML 用 yaml 包解析；语法错误时抛异常；解析结果不是对象（比如是字符串、列表、空）时也抛异常
 * - body 是结束的 --- 之后的内容，去掉首尾空白
 */
export function parseSkillFile(content: string): { frontmatter: Record<string, unknown>; body: string } | undefined {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;
  const frontmatter: unknown = parse(lines.slice(1, end).join("\n"));
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("技能的 YAML 开头必须是包含字段的对象");
  }
  return { frontmatter: frontmatter as Record<string, unknown>, body: lines.slice(end + 1).join("\n").trim() };
}

/**
 * 检查 frontmatter 里的 name 和 description，合格时返回 undefined，否则返回问题说明。
 * - name 是字符串，只有小写字母、数字和连字符，不以连字符开头或结尾，没有连续的连字符，1 到 MAX_NAME_LENGTH 个字符
 * - description 是去掉首尾空白后不为空的字符串，不超过 MAX_DESCRIPTION_LENGTH 个字符
 * - 其他字段不检查
 */
export function validateSkill(frontmatter: Record<string, unknown>): string | undefined {
  const { name, description } = frontmatter;
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return `name 必须由小写字母、数字和连字符组成，长度为 1 到 ${MAX_NAME_LENGTH} 个字符，不能以连字符开头、结尾或含连续连字符`;
  }
  if (typeof description !== "string" || description.trim() === "" || description.length > MAX_DESCRIPTION_LENGTH) {
    return `description 必须是非空字符串，最多 ${MAX_DESCRIPTION_LENGTH} 个字符`;
  }
  return undefined;
}

/**
 * 在 root 下递归找技能。
 * - root 不存在或不是目录时返回空结果
 * - 目录里有 SKILL.md 就是一个技能，不再往它的子目录里找（子目录是它的脚本和资料）
 * - 跳过名字以 . 开头的目录（比如 .git）和 node_modules
 * - 跟随指向目录的符号链接，但同一个真实目录只进一次，避免循环
 * - 最多找到第 MAX_SKILL_DEPTH 层
 * - 同一层的子目录按名字排序，结果的顺序固定
 * - SKILL.md 读不出来、parseSkillFile 返回 undefined 或抛异常、validateSkill 不通过时，跳过这个技能，
 *   记一条 diagnostic，file 是 SKILL.md 的路径
 * - description 去掉首尾空白；file、dir 都是绝对路径
 */
export async function findSkills(root: string): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const visited = new Set<string>();

  async function visit(dir: string, depth: number): Promise<void> {
    const actual = await realpath(dir).catch(() => undefined);
    if (actual === undefined || visited.has(actual)) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) return;
    visited.add(actual);

    if (entries.some((entry) => entry.name === SKILL_FILE)) {
      const file = join(dir, SKILL_FILE);
      try {
        const parsed = parseSkillFile(await readFile(file, "utf8"));
        if (parsed === undefined) throw new Error("缺少以 --- 包围的 YAML 开头");
        const problem = validateSkill(parsed.frontmatter);
        if (problem !== undefined) throw new Error(problem);
        skills.push({
          name: parsed.frontmatter.name as string,
          description: (parsed.frontmatter.description as string).trim(),
          file,
          dir,
        });
      } catch (err) {
        diagnostics.push({ file, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (depth >= MAX_SKILL_DEPTH) return;
    const children = entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort();
    for (const name of children) await visit(join(dir, name), depth + 1);
  }

  await visit(resolve(root), 0);
  return { skills, diagnostics };
}

/**
 * 按顺序在多个目录里找技能，合并结果。
 * - 名字重复时保留先找到的，后面的跳过，记一条 diagnostic，file 是被跳过的那个 SKILL.md
 * - 同一个目录出现多次时只找一次
 */
export async function loadSkills(roots: string[]): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const visited = new Set<string>();
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    const path = resolve(root);
    const actual = await realpath(path).catch(() => path);
    if (visited.has(actual)) continue;
    visited.add(actual);
    const found = await findSkills(path);
    diagnostics.push(...found.diagnostics);
    for (const skill of found.skills) {
      const previous = byName.get(skill.name);
      if (previous) {
        diagnostics.push({ file: skill.file, message: `技能名 ${skill.name} 重复，已保留 ${previous.file}` });
      } else {
        byName.set(skill.name, skill);
        skills.push(skill);
      }
    }
  }
  return { skills, diagnostics };
}

/**
 * 到哪些目录找技能，越靠前越优先。
 * - 默认：home 下的 .mini-harness/skills
 * - extra：额外指定的目录（比如环境变量 MH_SKILL_DIRS 拆出来的），开头的 ~ 换成 home，相对路径按 cwd 解析
 */
export function skillRoots(options: { cwd: string; home: string; extra?: string[] }): string[] {
  const cwd = resolve(options.cwd);
  const home = resolve(options.home);
  const roots = [join(home, ".mini-harness", "skills")];
  for (const extra of options.extra ?? []) {
    if (extra !== "") roots.push(resolve(cwd, extra.replace(/^~(?=$|\/)/, home)));
  }
  return roots;
}

/**
 * 系统提示里的「技能」一节；没有技能时返回空字符串。例如：
 *
 *   # 技能
 *   下面这些技能提供特定任务的做法。任务和某个技能的说明对得上时，先用 skill 工具加载它，再按里面的说明做。
 *
 *   - pdf-tools：处理 PDF 文件
 *   - domain-modeling：整理项目的领域模型
 */
export function formatSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "# 技能",
    "下面这些技能提供特定任务的做法。任务和某个技能的说明对得上时，先用 skill 工具加载它，再按里面的说明做。",
    "",
    ...skills.map((skill) => `- ${skill.name}：${skill.description}`),
  ].join("\n");
}

export const SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: SKILL_TOOL_NAME,
  description: "按名字加载一个技能的完整说明。系统提示的「技能」一节列出了可用的技能，任务和某个技能对得上时先加载它。",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "技能的名字" } },
    required: ["name"],
  },
};

/**
 * 加载技能用的正文：每次都重新读 SKILL.md，技能改过之后不用重启。
 * 返回 `<skill name="名字" dir="技能目录">\n正文\n</skill>`；读不出来或解析失败时抛异常
 */
export async function renderSkill(skill: Skill): Promise<string> {
  try {
    const parsed = parseSkillFile(await readFile(skill.file, "utf8"));
    if (parsed === undefined) throw new Error("缺少以 --- 包围的 YAML 开头");
    return `<skill name="${skill.name}" dir="${skill.dir}">\n${parsed.body}\n</skill>`;
  } catch (err) {
    throw new Error(`加载技能 ${skill.name} 失败（${skill.file}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

function requireSkill(name: unknown, skills: Skill[]): Skill {
  const skill = skills.find((skill) => skill.name === name);
  if (skill === undefined) {
    throw new Error(`找不到技能：${String(name)}。可用技能：${skills.map((skill) => skill.name).join("、") || "无"}`);
  }
  return skill;
}

/**
 * skill 工具，definition 是 SKILL_TOOL_DEFINITION。
 * - name 不是 skills 里的技能时抛异常，信息里列出可用的技能名
 * - 返回 renderSkill 的结果，前面加一句说明：正文里的相对路径按 dir 解析
 */
export function createSkillTool(skills: Skill[]): Tool {
  return {
    definition: SKILL_TOOL_DEFINITION,
    async execute(args) {
      const skill = requireSkill(args.name, skills);
      return { content: `正文里的相对路径按技能目录 ${skill.dir} 解析。\n\n${await renderSkill(skill)}` };
    },
  };
}

/**
 * 用户输入 /skill:名字 参数 时，拼成发给模型的用户消息。
 * - 不以 SKILL_COMMAND_PREFIX 开头时返回 undefined
 * - 名字是前缀之后到第一个空白为止；找不到这个技能时抛异常，信息里列出可用的技能名
 * - 返回 renderSkill 的结果；参数（名字之后的内容，去掉首尾空白）不为空时，空一行接在后面
 */
export async function expandSkillCommand(input: string, skills: Skill[]): Promise<string | undefined> {
  if (!input.startsWith(SKILL_COMMAND_PREFIX)) return undefined;
  const command = input.slice(SKILL_COMMAND_PREFIX.length);
  const space = command.search(/\s/);
  const name = space === -1 ? command : command.slice(0, space);
  const args = space === -1 ? "" : command.slice(space).trim();
  const content = await renderSkill(requireSkill(name, skills));
  return args === "" ? content : `${content}\n\n${args}`;
}
