// 执行 shell 命令的底层封装：超时后结束整组进程，输出太长时只保留开头和结尾。

import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  /** 超时毫秒数，到时先发 SIGTERM，2 秒后还没退出就发 SIGKILL */
  timeoutMs: number;
  /** 输出最多保留多少个字符，超出时保留开头和结尾各一半，中间省略 */
  maxOutputChars: number;
}

export interface RunResult {
  /** 正常退出时的退出码；被信号结束时为 null */
  exitCode: number | null;
  /** 结束进程的信号，比如超时后的 "SIGTERM"；正常退出时为 null */
  signal: string | null;
  timedOut: boolean;
  /** stdout 和 stderr 按到达顺序合在一起，超长时中间部分已省略 */
  output: string;
  /** 实际产生的输出总字符数，大于 output 的长度说明有省略 */
  totalChars: number;
}

const KILL_GRACE_MS = 2000;

/**
 * 用 bash -c 执行命令。
 * - 在独立的进程组里运行，超时时连同它启动的子进程一起结束，避免留下后台进程
 * - stdin 直接关闭，等待输入的命令会立刻读到结束，不会一直卡住
 */
export function runCommand(command: string, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const half = Math.floor(options.maxOutputChars / 2);
    let head = "";
    let tail = "";
    let totalChars = 0;
    const append = (text: string) => {
      totalChars += text.length;
      if (head.length < half) {
        const room = half - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (text) tail = (tail + text).slice(-half);
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      // pid 取负数表示整个进程组
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // 进程组已经不存在
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const omitted = totalChars - head.length - tail.length;
      const output = omitted > 0 ? `${head}\n…（中间省略 ${omitted} 个字符）…\n${tail}` : head + tail;
      resolve({ exitCode, signal, timedOut, output, totalChars });
    });
  });
}
