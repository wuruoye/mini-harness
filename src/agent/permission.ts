// 工具调用的权限规则，参考 opencode：每条规则是「工具 + 匹配模式 → 放行、询问或拒绝」。

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
  throw new Error("未实现");
}

/** 权限规则要匹配的内容：bash 取参数 command，其他工具取参数 path；参数不存在或不是字符串时为空字符串 */
export function permissionSubject(toolName: string, args: Record<string, unknown>): string {
  throw new Error("未实现");
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
  throw new Error("未实现");
}
