// 系统提示的拼接：项目指令文件（AGENTS.md）+ 环境信息。
// 启动时生成一次，进程运行期间不变。系统提示在每次请求的最开头，它不变，提示缓存才能一直命中。

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 每层目录按这个顺序找，取第一个存在的文件 */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];

/** 单个指令文件最多保留的字符数，超出部分截断，避免一个大文件占满上下文 */
export const MAX_INSTRUCTION_CHARS = 20_000;

export interface InstructionFile {
  /** 文件的绝对路径 */
  path: string;
  /** 文件内容，超长时已经截断 */
  content: string;
}

export interface Environment {
  cwd: string;
  /** process.platform，比如 darwin、linux */
  platform: string;
  /** 本地日期，格式 YYYY-MM-DD */
  date: string;
  /** git 仓库根目录；不在 git 仓库里时不填 */
  gitRoot?: string;
}

/**
 * 从 dir 开始一层层往上找 git 仓库根目录，找不到返回 undefined。
 * - 哪一层有 .git 就是根目录。.git 可能是目录，也可能是文件（git worktree 和 submodule 里是文件）
 * - 到了文件系统根目录还没找到，就算不在 git 仓库里
 */
export async function findGitRoot(dir: string): Promise<string | undefined> {
  let current = resolve(dir);
  while (true) {
    const git = await stat(join(current, ".git")).catch(() => undefined);
    if (git?.isFile() || git?.isDirectory()) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 在一个目录里按 INSTRUCTION_FILE_NAMES 的顺序找指令文件，返回第一个存在的；都没有返回 undefined。
 * - 读不出来的（不存在、是目录、没有读权限）当作不存在，接着找下一个文件名
 * - 找到的文件去掉首尾空白后是空的，当作这一层没有指令文件，返回 undefined
 * - 内容超过 MAX_INSTRUCTION_CHARS 时只保留开头，末尾注明截断了多少字符
 */
export async function readInstructionFile(dir: string): Promise<InstructionFile | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = resolve(dir, name);
    let content: string;
    try {
      if (!(await stat(path)).isFile()) continue;
      content = (await readFile(path, "utf8")).trim();
    } catch {
      continue;
    }
    if (content === "") return undefined;
    const omitted = content.length - MAX_INSTRUCTION_CHARS;
    if (omitted > 0) {
      content = `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[内容已截断，省略 ${omitted} 个字符]`;
    }
    return { path, content };
  }
  return undefined;
}

/**
 * 按「全局 → 仓库根目录 → … → cwd」的顺序读取指令文件，越靠后越具体。
 * - 全局：globalDir 里的指令文件，比如 ~/.mini-harness
 * - 项目：有 gitRoot 时，从 gitRoot 一层层往下到 cwd，每层最多一个；没有 gitRoot 时只看 cwd
 * - 同一个路径只出现一次，比如 globalDir 正好是项目里的某一层
 */
export async function loadInstructionFiles(options: {
  cwd: string;
  /** detectEnvironment 得到的 git 仓库根目录 */
  gitRoot?: string;
  globalDir: string;
}): Promise<InstructionFile[]> {
  const cwd = resolve(options.cwd);
  const root = options.gitRoot === undefined ? cwd : resolve(options.gitRoot);
  const projectDirs = [cwd];
  let current = cwd;
  while (current !== root) {
    const parent = dirname(current);
    if (parent === current) throw new Error("gitRoot 必须是 cwd 的上级目录或自身");
    projectDirs.unshift(parent);
    current = parent;
  }
  const dirs = new Set([resolve(options.globalDir), ...projectDirs]);
  const files = await Promise.all([...dirs].map(readInstructionFile));
  return files.filter((file): file is InstructionFile => file !== undefined);
}

/**
 * 收集环境信息，gitRoot 用 findGitRoot 查。
 * - now 由调用方传入，测试时可以固定
 * - date 用本地时区的年月日。toISOString 给的是 UTC 时间，在美国晚上会差一天
 */
export async function detectEnvironment(cwd: string, now: Date): Promise<Environment> {
  const fullPath = resolve(cwd);
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  const gitRoot = await findGitRoot(fullPath);
  return { cwd: fullPath, platform: process.platform, date, ...(gitRoot === undefined ? {} : { gitRoot }) };
}

/**
 * 拼出最终的系统提示：项目指令、环境信息两部分，之间空一行。
 * - 没有指令文件时，不出现「项目指令」这一部分
 * - 每个指令文件放在 <instructions path="绝对路径"> 和 </instructions> 之间，按 files 的顺序排列
 * - 环境信息每项一行；不在 git 仓库里时，git 那一行写「不是 git 仓库」
 * - 只放进程运行期间不变的内容。时间、git status 这类会变的内容放进来，每次请求开头都不一样，缓存会失效
 * - 同样的输入得到完全相同的字符串
 *
 * 例如：
 *
 *   # 项目指令
 *   下面是用户和项目提供的指令，越靠后越具体。
 *
 *   <instructions path="/Users/me/.mini-harness/AGENTS.md">
 *   ……
 *   </instructions>
 *
 *   <instructions path="/Users/me/proj/AGENTS.md">
 *   ……
 *   </instructions>
 *
 *   # 环境
 *   - 工作目录：/Users/me/proj
 *   - 平台：darwin
 *   - 日期：2026-10-15
 *   - git 仓库根目录：/Users/me/proj
 */
export function buildSystemPrompt(files: InstructionFile[], env: Environment): string {
  const parts: string[] = [];
  if (files.length > 0) {
    const instructions = files.map((file) => `<instructions path="${file.path}">\n${file.content}\n</instructions>`);
    parts.push([
      "# 项目指令\n下面是用户和项目提供的指令，越靠后越具体。",
      ...instructions,
    ].join("\n\n"));
  }
  parts.push([
    "# 环境",
    `- 工作目录：${env.cwd}`,
    `- 平台：${env.platform}`,
    `- 日期：${env.date}`,
    env.gitRoot ? `- git 仓库根目录：${env.gitRoot}` : "- 不是 git 仓库",
  ].join("\n"));
  return parts.join("\n\n");
}
