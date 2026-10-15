// 执行 shell 命令的底层封装：超时后结束整组进程，输出太长时只保留开头和结尾；可以放进沙箱里执行。

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { SandboxPolicy } from "../agent/types.ts";

export interface RunOptions {
  cwd: string;
  /** 超时毫秒数，到时先发 SIGTERM，2 秒后还没退出就发 SIGKILL */
  timeoutMs: number;
  /** 输出最多保留多少个字符，超出时保留开头和结尾各一半，中间省略 */
  maxOutputChars: number;
  /** 设置了就在沙箱里执行，目前只支持 macOS */
  sandbox?: SandboxPolicy;
  /** 中止信号：触发后像超时一样结束整组进程，结果里 aborted 为 true */
  signal?: AbortSignal;
}

export interface RunResult {
  /** 正常退出时的退出码；被信号结束时为 null */
  exitCode: number | null;
  /** 结束进程的信号，比如超时后的 "SIGTERM"；正常退出时为 null */
  signal: string | null;
  timedOut: boolean;
  /** 是否因为中止信号被结束；信号在开始前就已触发时，命令根本不会执行 */
  aborted: boolean;
  /** stdout 和 stderr 按到达顺序合在一起，超长时中间部分已省略 */
  output: string;
  /** 实际产生的输出总字符数，大于 output 的长度说明有省略 */
  totalChars: number;
}

const KILL_GRACE_MS = 2000;

/** 沙箱按真实路径匹配，/var 这类符号链接要先解析成 /private/var；目录不存在时原样使用 */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * 生成 macOS sandbox-exec 的启动参数。
 * 配置用的是 Apple 的 SBPL 语言：默认全部允许，再禁止所有写文件，然后只放开可写目录和几个设备文件。
 * 目录通过 -D 传参，不直接拼进配置文本，路径里有引号等特殊字符也不会出错。
 */
export function sandboxExecArgs(policy: SandboxPolicy): string[] {
  const dirs = policy.writableDirs.map(realDir);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...dirs.map((_, i) => `  (subpath (param "W${i}"))`),
    '  (literal "/dev/null") (literal "/dev/zero")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(policy.allowNetwork ? [] : ["(deny network*)"]),
  ].join("\n");
  return [...dirs.flatMap((dir, i) => ["-D", `W${i}=${dir}`]), "-p", profile];
}

/**
 * 用 bash -c 执行命令。
 * - 在独立的进程组里运行，超时时连同它启动的子进程一起结束，避免留下后台进程
 * - stdin 直接关闭，等待输入的命令会立刻读到结束，不会一直卡住
 */
export function runCommand(command: string, options: RunOptions): Promise<RunResult> {
  if (options.sandbox && process.platform !== "darwin") {
    return Promise.reject(new Error(`沙箱目前只支持 macOS，当前系统是 ${process.platform}`));
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ exitCode: null, signal: null, timedOut: false, aborted: true, output: "", totalChars: 0 });
  }
  const [file, args] = options.sandbox
    ? ["/usr/bin/sandbox-exec", [...sandboxExecArgs(options.sandbox), "bash", "-c", command]]
    : ["bash", ["-c", command]];

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
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
    // 超时和中止都走这里：先礼貌地请进程退出，过一会儿还不退就强制结束
    const stop = () => {
      if (killTimer) return;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      const omitted = totalChars - head.length - tail.length;
      const output = omitted > 0 ? `${head}\n…（中间省略 ${omitted} 个字符）…\n${tail}` : head + tail;
      resolve({ exitCode, signal, timedOut, aborted, output, totalChars });
    });
  });
}
