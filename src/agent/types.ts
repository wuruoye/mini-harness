import type { Message, Provider, StopReason, ToolCallBlock, ToolDefinition, UserMessage } from "../ai/types.ts";

/** 沙箱配置：bash 命令在沙箱里执行时，只能写这些目录 */
export interface SandboxPolicy {
  /** 可写的目录，工作目录和临时目录要包含在内 */
  writableDirs: string[];
  /** 是否允许联网 */
  allowNetwork: boolean;
}

export type PermissionDecision = { allowed: true } | { allowed: false; reason?: string };

/**
 * 判断一次工具调用是否允许；需要询问时由调用方（比如命令行界面）去问用户。
 * reason 是询问时额外显示给用户的说明，比如为什么要申请这个权限
 */
export type CheckPermission = (toolCall: ToolCallBlock, reason?: string) => Promise<PermissionDecision>;

export interface ToolContext {
  /** 工作目录，相对路径以它为准 */
  cwd: string;
  /** 设置了就表示当前在 auto 模式，bash 默认在沙箱里执行 */
  sandbox?: SandboxPolicy;
  /** 工具执行过程中需要额外申请权限时用，比如命令被沙箱拦下后申请在沙箱外重新执行 */
  checkPermission?: CheckPermission;
  /** 中止信号：用户中断这一轮时触发，耗时的工具应该尽快停下 */
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  /** 不填等于 false */
  isError?: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  /**
   * 执行工具。args 来自模型，不一定符合 schema，要自己检查。
   * 出错时可以直接抛异常，由主循环转成错误结果交给模型。
   */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type AgentEvent =
  /** 每往历史里新增一条消息发一次，传入的历史不算 */
  | { type: "message"; message: Message }
  /** 开始执行一个工具调用 */
  | { type: "toolStart"; toolCall: ToolCallBlock }
  /** 工具调用执行完。result 和随后加入历史的工具结果一致，isError 已经补全 */
  | { type: "toolEnd"; toolCall: ToolCallBlock; result: Required<ToolResult> };

export interface AgentOptions {
  provider: Provider;
  system: string;
  tools: Tool[];
  cwd: string;
  /** 最多请求模型几次，默认 DEFAULT_MAX_TURNS */
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
  /**
   * 执行每个工具调用之前调用，决定是否允许；不传就全部允许。
   * 怎么判断、要不要询问用户，由调用方（比如命令行界面）实现，主循环只等结果
   */
  checkPermission?: CheckPermission;
  /** 沙箱配置，原样放进每次工具调用的 context；不传表示不用沙箱 */
  sandbox?: SandboxPolicy;
  /** 中止信号：触发后尽快停下这一轮，返回 stopReason 为 "aborted" */
  signal?: AbortSignal;
  /**
   * 取出运行期间用户新输入、还没交给模型的消息，取出后队列清空。
   * 主循环在合适的时机把它们插进对话，模型不用等这一轮结束就能看到
   */
  getQueuedMessages?: () => UserMessage[];
}

export interface AgentResult {
  /** 完整历史：传入的消息加上这次新增的 */
  messages: Message[];
  /** 最后一条 assistant 消息的停止原因；因为请求次数用完而停下时为 "maxTurns"；被中断时为 "aborted" */
  stopReason: StopReason | "maxTurns" | "aborted";
}
