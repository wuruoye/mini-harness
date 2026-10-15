// 工具调用的权限规则，参考 opencode：每条规则是「工具 + 匹配模式 → 放行、询问或拒绝」。

import { isAbsolute, relative, resolve, sep } from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** 工具名，可以用 * 通配 */
  tool: string;
  /** 要匹配的内容：bash 是命令，文件类工具是路径；不填表示匹配所有 */
  pattern?: string;
  action: PermissionAction;
}

/** 默认规则。按顺序匹配，后面的覆盖前面的，所以从宽泛写到具体 */
export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "*", action: "ask" },
  { tool: "read_file", action: "allow" },
  { tool: "task", action: "allow" },
  { tool: "bash", pattern: "pwd", action: "allow" },
  { tool: "bash", pattern: "ls*", action: "allow" },
  { tool: "bash", pattern: "git status*", action: "allow" },
  { tool: "bash", pattern: "git diff*", action: "allow" },
  { tool: "bash", pattern: "git log*", action: "allow" },
  { tool: "bash", pattern: "rm -rf *", action: "deny" },
];

/**
 * 通配符匹配：pattern 里的 * 匹配任意长度的任意字符（包括没有字符），其他字符都按原样比较，
 * 正则表达式里的特殊字符（比如 . ( + ?）没有特殊含义；要求整个 text 从头到尾都匹配上。
 */
export function matchPattern(pattern: string, text: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + source + "$", "s").test(text);
}

/** 权限规则要匹配的内容：bash 取参数 command，其他工具取参数 path；参数不存在或不是字符串时为空字符串 */
export function permissionSubject(toolName: string, args: Record<string, unknown>): string {
  const subject = toolName === "bash" ? args.command : args.path;
  return typeof subject === "string" ? subject : "";
}

/**
 * 判断一次工具调用该放行、询问还是拒绝。
 *
 * - 按顺序检查所有规则：tool 匹配工具名，并且 pattern 不填或者匹配 permissionSubject 的结果，才算匹配上
 * - 匹配上的规则里，最后一条决定结果；一条都没匹配上时为 "ask"
 * - 安全兜底：bash 命令里只要含有 ; & | ` $( > < 或换行，结果为 "allow" 时也要降为 "ask"。
 *   因为「git status*」这样的规则会把「git status; rm -rf ~」也匹配上，拼接起来的命令不能自动放行。
 *   结果为 "deny" 时保持不变
 */
export function evaluatePermission(
  rules: PermissionRule[],
  toolName: string,
  args: Record<string, unknown>,
): PermissionAction {
  const subject = permissionSubject(toolName, args);
  let action: PermissionAction = "ask";

  for (const rule of rules) {
    if (matchPattern(rule.tool, toolName) && (rule.pattern === undefined || matchPattern(rule.pattern, subject))) {
      action = rule.action;
    }
  }

  if (toolName === "bash" && action === "allow" && /[;&|`><\r\n]|\$\(/.test(subject)) {
    return "ask";
  }
  return action;
}

/**
 * 权限模式，在规则判断的结果上再做调整：
 * - auto（默认）：项目里的文件操作和沙箱里的 bash 命令不再询问，项目外的按规则来
 * - bypass：跳过所有判断，包括规则禁止的操作
 */
export type PermissionMode = "auto" | "bypass";

export const PERMISSION_MODES: Record<PermissionMode, string> = {
  auto: "项目里的文件操作和沙箱里的命令不再询问，项目外的按规则来",
  bypass: "所有操作都不经确认直接执行，包括规则禁止的",
};

export function isPermissionMode(value: string): value is PermissionMode {
  return Object.hasOwn(PERMISSION_MODES, value);
}

/**
 * path 按 cwd 解析后，是否在 cwd 里面（cwd 自身也算）。
 * path 不是非空字符串时返回 false。
 * 不能用字符串前缀判断：cwd 为 /work 时，/work2/a.txt 不在里面；
 * 也不能简单看相对路径是否以 .. 开头：名字叫 ..notes.txt 的文件就在 cwd 里面。
 */
export function isInside(cwd: string, path: unknown): boolean {
  if (typeof path !== "string" || path === "") return false;
  const base = resolve(cwd);
  const fromCwd = relative(base, resolve(base, path));
  return fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd);
}

/**
 * 按模式调整规则判断的结果 action。
 * - auto：只把 ask 变成 allow，deny 不变，并且只在下面两种情况下：
 *   - read_file、edit、write_file 的参数 path 在 cwd 里面
 *   - bash 的参数 sandbox 不是 false，也就是命令会在沙箱里执行，写不了项目外的文件
 *   其他情况原样返回，比如项目外的文件、申请在沙箱外执行的 bash
 * - bypass：一律 allow
 */
export function applyMode(
  mode: PermissionMode,
  action: PermissionAction,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): PermissionAction {
  if (mode === "bypass") return "allow";
  if (action !== "ask") return action;

  if (toolName === "bash" && args.sandbox !== false) return "allow";
  if (["read_file", "edit", "write_file"].includes(toolName) && isInside(cwd, args.path)) return "allow";
  return action;
}
