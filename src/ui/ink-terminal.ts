// 用 Ink 实现的界面：输入框固定在底部，输出出现在它上面。
// 写完的行放进 <Static>，只输出一次，进入终端自己的滚动记录；底部反复重画的只有没写完的那一行输出、
// 运行状态、输入框和状态栏。组件手写 createElement，不用 JSX，Node 可以直接运行。

import { styleText } from "node:util";
import { Box, render, Static, Text, useCursor, useInput, usePaste, useWindowSize, type Instance, type Key } from "ink";
import { createElement as h, useReducer, useRef, useSyncExternalStore } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { createEditor, editorReducer, layoutEditor, type EditorAction, type EditorState } from "./editor.ts";
import { appendHistory } from "./input-history.ts";
import type { Terminal } from "./terminal.ts";

/** 制表符显示成几个空格；发出去的内容里仍然是制表符 */
const TAB = "    ";

export interface Line {
  id: number;
  text: string;
}

export interface Screen {
  /** 写完的内容，交给 <Static> */
  lines: Line[];
  /** 流式输出里还没写完的那一行 */
  partial: string;
  prompt: string;
  /** 这次输入的内容进不进历史 */
  recordHistory: boolean;
  busy: boolean;
  footer: string;
}

/** 界面要显示的内容。main.ts 通过 InkTerminal 改它，组件订阅它重新渲染 */
export class ScreenStore {
  private screen: Screen = { lines: [], partial: "", prompt: "> ", recordHistory: true, busy: false, footer: "" };
  private readonly listeners = new Set<() => void>();
  private nextId = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): Screen => this.screen;

  update(change: Partial<Screen>): void {
    this.screen = { ...this.screen, ...change };
    for (const listener of this.listeners) listener();
  }

  /** 输出完整的内容；没写完的那一行先结束 */
  print(text: string): void {
    const lines = [...this.screen.lines];
    if (this.screen.partial !== "") lines.push(this.line(this.screen.partial));
    lines.push(this.line(text));
    this.update({ lines, partial: "" });
  }

  /** 流式片段：完整的行放进 lines，最后没写完的部分留在 partial */
  stream(text: string): void {
    if (text === "") return;
    const all = this.screen.partial + text;
    const end = all.lastIndexOf("\n");
    if (end === -1) {
      this.update({ partial: all });
      return;
    }
    this.update({ lines: [...this.screen.lines, this.line(all.slice(0, end))], partial: all.slice(end + 1) });
  }

  /**
   * 输入框发送后就清空了，把发送的内容留在输出里：提示加内容，多行时后面的行和第一行对齐。
   * 空的输入不留，除非是在回答询问（不进历史的输入）
   */
  echoInput(text: string): void {
    const { prompt, recordHistory } = this.screen;
    if (text === "" && recordHistory) return;
    const [first = "", ...rest] = text.split("\n");
    const indent = " ".repeat(stringWidth(prompt));
    this.print([styleText("dim", prompt) + first, ...rest.map((line) => indent + line)].join("\n"));
  }

  endLine(): void {
    if (this.screen.partial === "") return;
    this.update({ lines: [...this.screen.lines, this.line(this.screen.partial)], partial: "" });
  }

  private line(text: string): Line {
    // 空字符串在 Ink 里不占行，用一个空格占住
    return { id: this.nextId++, text: text === "" ? " " : text };
  }
}

/** 界面的回调 */
export interface ViewHandlers {
  /** 按回车发送；text 可能是空字符串 */
  submit(text: string): void;
  interrupt(): void;
  close(): void;
}

type InputAction = EditorAction | { type: "reset" };

function inputReducer(state: EditorState, action: InputAction): EditorState {
  if (action.type !== "reset") return editorReducer(state, action);
  return state.text === "" && state.historyIndex === undefined ? state : createEditor(state.history);
}

/** 把按键换成编辑动作；返回 undefined 表示不处理 */
function keyToAction(input: string, key: Key, state: EditorState): InputAction | "submit" | undefined {
  if (key.return) {
    if (key.meta || key.shift) return { type: "newline" };
    // 光标前是反斜杠时，回车表示换行：去掉反斜杠再换行由调用方分两步做
    return state.text[state.cursor - 1] === "\\" ? undefined : "submit";
  }
  if (input === "\n" || (key.ctrl && input === "j")) return { type: "newline" };
  if (key.backspace) return { type: key.meta ? "deleteWordBefore" : "backspace" };
  if (key.delete) return { type: "delete" };
  if (key.leftArrow) return { type: key.meta || key.ctrl ? "wordLeft" : "left" };
  if (key.rightArrow) return { type: key.meta || key.ctrl ? "wordRight" : "right" };
  if (key.upArrow) return { type: "up" };
  if (key.downArrow) return { type: "down" };
  if (key.home) return { type: "lineStart" };
  if (key.end) return { type: "lineEnd" };
  if (key.meta && input === "b") return { type: "wordLeft" };
  if (key.meta && input === "f") return { type: "wordRight" };
  if (key.ctrl) {
    const actions: Record<string, InputAction> = {
      a: { type: "lineStart" },
      e: { type: "lineEnd" },
      b: { type: "left" },
      f: { type: "right" },
      u: { type: "deleteToLineStart" },
      k: { type: "deleteToLineEnd" },
      w: { type: "deleteWordBefore" },
    };
    return actions[input];
  }
  if (key.escape || key.tab || key.meta || input === "") return undefined;
  return { type: "insert", text: input };
}

export interface ViewProps {
  store: ScreenStore;
  history: string[];
  handlers: ViewHandlers;
}

/** 整个界面：<Static> 里是写完的内容，下面依次是没写完的一行、运行状态、输入框和状态栏 */
export function TerminalView({ store, history, handlers }: ViewProps) {
  const screen = useSyncExternalStore(store.subscribe, store.get);
  const { columns } = useWindowSize();
  const { setCursorPosition } = useCursor();

  // 编辑状态放在 ref 里：同一批输入里连续的按键要基于最新状态，回车时也要读到刚输入的内容
  const editor = useRef(createEditor(history));
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const apply = (action: InputAction) => {
    const next = inputReducer(editor.current, action);
    if (next === editor.current) return;
    editor.current = next;
    rerender();
  };

  useInput((input, key) => {
    const state = editor.current;
    if (key.ctrl && input === "c") {
      if (state.text !== "") apply({ type: "reset" });
      else handlers.interrupt();
      return;
    }
    if (key.ctrl && input === "d") {
      if (state.text === "") handlers.close();
      else apply({ type: "delete" });
      return;
    }
    const action = keyToAction(input, key, state);
    if (action === "submit") {
      const text = state.text;
      apply(screen.recordHistory ? { type: "submit" } : { type: "reset" });
      handlers.submit(text);
    } else if (action) {
      apply(action);
    } else if (key.return) {
      apply({ type: "backspace" });
      apply({ type: "newline" });
    }
  });
  usePaste((text) => apply({ type: "insert", text }));

  const partialRows =
    screen.partial === "" ? [] : wrapAnsi(screen.partial, columns, { trim: false, hard: true }).split("\n");
  const labelWidth = stringWidth(screen.prompt);
  const { text, cursor } = editor.current;
  const layout = layoutEditor(
    text.replaceAll("\t", TAB),
    text.slice(0, cursor).replaceAll("\t", TAB).length,
    Math.max(1, columns - labelWidth - 1),
  );
  const busyRows = screen.busy ? 1 : 0;
  setCursorPosition({ x: labelWidth + layout.cursorColumn, y: partialRows.length + busyRows + 1 + layout.cursorRow });

  const rule = styleText("dim", "─".repeat(columns));
  const row = (key: string, content: string) => h(Text, { key, wrap: "truncate-end" }, content === "" ? " " : content);
  return h(
    Box,
    { flexDirection: "column" },
    h(Static<Line>, { items: screen.lines, children: (line) => h(Text, { key: line.id }, line.text) }),
    ...partialRows.map((content, index) => row(`partial-${index}`, content)),
    screen.busy ? row("busy", styleText("dim", "运行中：回车插话，Ctrl-C 中断")) : null,
    row("top", rule),
    ...layout.rows.map((content, index) =>
      row(`input-${index}`, (index === 0 ? styleText("dim", screen.prompt) : " ".repeat(labelWidth)) + content),
    ),
    row("bottom", rule),
    screen.footer === "" ? null : row("footer", styleText("dim", screen.footer)),
  );
}

/** 终端里用的界面 */
export class InkTerminal implements Terminal {
  private readonly store = new ScreenStore();
  private readonly instance: Instance;
  private readonly lineHandlers: ((line: string) => void)[] = [];
  private readonly interruptHandlers: (() => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private readonly historyFile: string;
  private closed = false;
  private closing: Promise<void> | undefined;

  /** history 是之前的输入历史；historyFile 是新输入追加到的文件 */
  constructor(history: string[], historyFile: string) {
    this.historyFile = historyFile;
    let lastSaved = history.at(-1);
    const handlers: ViewHandlers = {
      submit: (text) => {
        const { recordHistory } = this.store.get();
        this.store.echoInput(text);
        if (recordHistory && text.trim() !== "" && text !== lastSaved) {
          lastSaved = text;
          appendHistory(this.historyFile, text).catch((err: unknown) =>
            this.error(styleText("red", `保存输入历史失败：${err instanceof Error ? err.message : String(err)}`)),
          );
        }
        for (const handler of this.lineHandlers) handler(text);
      },
      interrupt: () => {
        for (const handler of this.interruptHandlers) handler();
      },
      close: () => this.finishInput(),
    };
    this.instance = render(h(TerminalView, { store: this.store, history, handlers }), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      kittyKeyboard: { mode: "auto" },
    });
  }

  print(text: string): void {
    this.store.print(text);
  }

  error(text: string): void {
    this.store.print(text);
  }

  stream(text: string): void {
    this.store.stream(text);
  }

  endLine(): void {
    this.store.endLine();
  }

  setPrompt(label: string, options: { history?: boolean } = {}): void {
    this.store.update({ prompt: label, recordHistory: options.history ?? true });
  }

  showPrompt(): void {}

  setBusy(busy: boolean): void {
    this.store.update({ busy });
  }

  setFooter(text: string): void {
    this.store.update({ footer: text });
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onInterrupt(handler: () => void): void {
    this.interruptHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): Promise<void> {
    // Ctrl-C 退出和主循环结束都会调用，只关一次
    this.closing ??= (async () => {
      this.finishInput();
      this.instance.unmount();
      await this.instance.waitUntilExit();
    })();
    return this.closing;
  }

  private finishInput(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
}
