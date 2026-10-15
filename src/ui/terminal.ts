// 命令行界面和 main.ts 之间的接口。main.ts 只通过它输出和读输入，不直接碰 stdout 和 readline。
// 有两种实现：终端里用 Ink（./ink-terminal.ts），输入框固定在底部；输入不是终端时（比如管道）用这里的 LineTerminal 按行读写。

import { createInterface, type Interface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export interface Terminal {
  /** 输出完整的内容，末尾自动换行；流式输出的那一行还没结束时，先换行 */
  print(text: string): void;
  /** 输出错误信息，规则同 print */
  error(text: string): void;
  /** 输出流式片段，可能停在一行中间 */
  stream(text: string): void;
  /** 流式输出的那一行还没结束时，补一个换行 */
  endLine(): void;
  /** 设置输入提示。history 为 false 时，接下来输入的内容不进历史，比如权限询问的回答 */
  setPrompt(label: string, options?: { history?: boolean }): void;
  /** 开始等待输入：按行读写时显示提示符；Ink 的输入框一直在，不用做什么 */
  showPrompt(): void;
  /** 是否有一轮正在运行 */
  setBusy(busy: boolean): void;
  /** 底部状态栏，比如权限模式和模型 */
  setFooter(text: string): void;
  /** 用户输入了一行（可能有多行内容，用 \n 分隔） */
  onLine(handler: (line: string) => void): void;
  /** 用户按了 Ctrl-C */
  onInterrupt(handler: () => void): void;
  /** 输入结束：按了 Ctrl-D，或者管道里的输入读完了 */
  onClose(handler: () => void): void;
  /** 结束界面，恢复终端 */
  close(): Promise<void>;
}

/** 按行读写，输入不是终端时用 */
export class LineTerminal implements Terminal {
  private readonly rl: Interface;
  private lineOpen = false;
  private closed = false;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    this.rl.on("close", () => {
      this.closed = true;
    });
  }

  print(text: string): void {
    this.endLine();
    process.stdout.write(`${text}\n`);
  }

  error(text: string): void {
    this.endLine();
    process.stderr.write(`${text}\n`);
  }

  stream(text: string): void {
    if (text === "") return;
    process.stdout.write(text);
    const visible = stripVTControlCharacters(text);
    if (visible !== "") this.lineOpen = !visible.endsWith("\n");
  }

  endLine(): void {
    if (this.lineOpen) process.stdout.write("\n");
    this.lineOpen = false;
  }

  setPrompt(label: string): void {
    this.rl.setPrompt(label);
  }

  showPrompt(): void {
    if (!this.closed) this.rl.prompt();
  }

  setBusy(): void {}

  setFooter(): void {}

  onLine(handler: (line: string) => void): void {
    this.rl.on("line", handler);
  }

  onInterrupt(handler: () => void): void {
    // 在终端里 Ctrl-C 由 readline 收到；输入来自管道时，是进程收到 SIGINT 信号
    this.rl.on("SIGINT", handler);
    process.on("SIGINT", handler);
  }

  onClose(handler: () => void): void {
    this.rl.on("close", handler);
  }

  async close(): Promise<void> {
    this.rl.close();
  }
}
