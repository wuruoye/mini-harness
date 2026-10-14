import type { Tool } from "../agent/types.ts";
import { runCommand } from "./process.ts";

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_CHARS = 30_000;

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description:
      `在工作目录里用 bash 执行一条命令，返回输出和退出码。` +
      `每次调用都是一个新的 shell，cd 和环境变量不会保留到下一次调用。` +
      `默认 ${BASH_DEFAULT_TIMEOUT_MS / 1000} 秒超时，可以用 timeout_ms 调整，最多 ${BASH_MAX_TIMEOUT_MS / 1000} 秒。` +
      `输出超过 ${BASH_MAX_OUTPUT_CHARS} 个字符时只保留开头和结尾。不要执行需要交互输入的命令。` +
      `在 sandbox 权限模式下，命令默认在沙箱里执行，只能写项目目录和临时目录，写别处会报 Operation not permitted；` +
      `确实需要写项目外的文件时（比如安装依赖要写全局缓存），把 sandbox 设为 false，这需要用户确认。`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout_ms: { type: "number", description: "超时毫秒数，可选" },
        sandbox: { type: "boolean", description: "是否在沙箱里执行，只在 sandbox 权限模式下有效，默认 true" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },

  /**
   * - command 缺失、不是字符串或为空时抛异常，错误信息里提到 command
   * - timeout_ms 不填用 BASH_DEFAULT_TIMEOUT_MS；填了但不是正数时抛异常，信息里提到 timeout_ms；超过上限按上限算
   * - 用 runCommand（./process.ts）在 context.cwd 里执行，输出上限是 BASH_MAX_OUTPUT_CHARS
   * - content 是命令输出，后面另起一行注明结果：正常退出写「[退出码 N]」；
   *   超时写「[超时，已在 N 毫秒后结束]」；被其他信号结束写「[被信号 X 结束]」
   * - 退出码不为 0、超时、被信号结束时，isError 为 true
   * - 待实现：context.sandbox 有值，并且 args.sandbox 不是 false 时，把 context.sandbox 传给 runCommand，
   *   在沙箱里执行；其他情况不用沙箱
   */
  async execute(args, context) {
    const { command, timeout_ms: requestedTimeout = BASH_DEFAULT_TIMEOUT_MS } = args;
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("command 必须是非空字符串");
    }
    if (typeof requestedTimeout !== "number" || !Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new Error("timeout_ms 必须是有限正数");
    }

    const timeoutMs = Math.min(requestedTimeout, BASH_MAX_TIMEOUT_MS);
    const result = await runCommand(command, {
      cwd: context.cwd,
      timeoutMs,
      maxOutputChars: BASH_MAX_OUTPUT_CHARS,
    });
    const status = result.timedOut
      ? `[超时，已在 ${timeoutMs} 毫秒后结束]`
      : result.signal !== null
        ? `[被信号 ${result.signal} 结束]`
        : `[退出码 ${result.exitCode}]`;
    const separator = result.output !== "" && !result.output.endsWith("\n") ? "\n" : "";
    return {
      content: result.output + separator + status,
      isError: result.exitCode !== 0 || result.timedOut || result.signal !== null,
    };
  },
};
