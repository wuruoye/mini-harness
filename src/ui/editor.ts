// 输入框的编辑逻辑：输入的内容、光标、历史，以及按终端宽度折行后光标在哪里。
// 不碰终端，也不依赖 React：按键由界面换成 EditorAction，交给 editorReducer 算出新状态，
// 可以直接用作 React 的 useReducer。

import { displayWidth } from "./markdown.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 最多保留多少条历史 */
export const MAX_HISTORY = 1000;

export interface EditorState {
  /** 输入的内容，可以有多行，用 \n 分隔 */
  text: string;
  /** 光标位置，是 text 的下标（UTF-16），总是落在两个字素之间 */
  cursor: number;
  /** 历史输入，从旧到新 */
  history: string[];
  /** 正在看的历史是 history 的第几条；没在翻历史时为 undefined */
  historyIndex: number | undefined;
  /** 开始翻历史时正在写的内容，翻回最新的时候恢复 */
  draft: string;
}

export type EditorAction =
  /** 打字或粘贴 */
  | { type: "insert"; text: string }
  | { type: "newline" }
  /** 删除光标前一个字素 */
  | { type: "backspace" }
  /** 删除光标后一个字素 */
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "wordLeft" }
  | { type: "wordRight" }
  | { type: "up" }
  | { type: "down" }
  | { type: "lineStart" }
  | { type: "lineEnd" }
  | { type: "deleteWordBefore" }
  | { type: "deleteToLineStart" }
  | { type: "deleteToLineEnd" }
  /** 发送：调用方先取走 text，再派发 submit */
  | { type: "submit" };

/** 空的编辑器。history 复制一份，超过 MAX_HISTORY 条时只保留最新的 */
export function createEditor(history: string[] = []): EditorState {
  return { text: "", cursor: 0, history: history.slice(-MAX_HISTORY), historyIndex: undefined, draft: "" };
}

function moveCursor(state: EditorState, cursor: number): EditorState {
  return cursor === state.cursor ? state : { ...state, cursor };
}

function replaceText(state: EditorState, text: string, cursor: number): EditorState {
  // 插入组合字符、删除分隔字符后，两侧可能合成一个字素；光标移到这个字素后面。
  const part = segmenter.segment(text).containing(cursor);
  if (part && part.index < cursor) cursor = part.index + part.segment.length;
  return text === state.text && cursor === state.cursor ? state : { ...state, text, cursor };
}

function lineStart(text: string, cursor: number): number {
  return cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const end = text.indexOf("\n", cursor);
  return end === -1 ? text.length : end;
}

function wordBoundary(text: string, cursor: number, direction: -1 | 1): number {
  const parts = segmenter.segment(text);
  for (const whitespace of [true, false]) {
    while (direction === -1 ? cursor > 0 : cursor < text.length) {
      const part = parts.containing(direction === -1 ? cursor - 1 : cursor);
      if (!part || /^\s+$/u.test(part.segment) !== whitespace) break;
      cursor = direction === -1 ? part.index : part.index + part.segment.length;
    }
  }
  return cursor;
}

/** 在目标行里取不超过显示列的最靠右位置，始终停在字素之间。 */
function cursorAtColumn(text: string, start: number, end: number, column: number): number {
  let cursor = start;
  let width = 0;
  for (const part of segmenter.segment(text.slice(start, end))) {
    const nextWidth = width + displayWidth(part.segment);
    if (nextWidth > column) break;
    width = nextWidth;
    cursor = start + part.index + part.segment.length;
  }
  return cursor;
}

/**
 * 按动作算出新状态，不修改传入的 state。没有任何变化时返回传入的同一个对象，React 就不会重新渲染。
 *
 * 字素：用户看到的一个字，用 Intl.Segmenter 的 grapheme 划分，比如 👍、👨‍👩‍👧 各算一个；
 * 换行符 \n 也算一个字素。左右移动、backspace、delete 都按字素走，光标不会停在一个字素中间。
 * 行：按 \n 分开的逻辑行，不管终端折行。
 *
 * - insert：先把 \r\n 和单独的 \r 换成 \n，再去掉除 \n 和 \t 以外的控制字符（U+0000–U+001F、U+007F）；
 *   插在光标处，光标移到插入内容之后。清理后为空字符串时不变
 * - newline：在光标处插入 \n
 * - backspace、delete：删除光标前、后一个字素；在开头、末尾时不变
 * - left、right：移动一个字素；在开头、末尾时不变
 * - wordLeft：先往左跳过空白（包括 \n），再往左跳过非空白字符；wordRight 方向相反
 * - lineStart、lineEnd：移到当前行的开头、末尾
 * - deleteWordBefore：删除从 wordLeft 的位置到光标之间的内容
 * - deleteToLineStart、deleteToLineEnd：删除光标到当前行开头、末尾之间的内容；没有可删的时不变
 * - up：
 *   - 光标不在第一行时，移到上一行的同一列。列按显示宽度算（displayWidth，中文占 2 格）：
 *     取上一行里宽度不超过这一列的最靠右的位置
 *   - 在第一行时翻到上一条历史：没在翻历史时，先把当前内容存进 draft，从最新一条开始；
 *     已经是最旧的一条或者没有历史时不变。翻到的内容放进 text，光标放在末尾
 * - down：
 *   - 光标不在最后一行时，移到下一行的同一列，规则同 up
 *   - 在最后一行、正在翻历史时翻到下一条；已经是最新一条时恢复 draft，退出翻历史，draft 清空；
 *     没在翻历史时不变
 * - 翻历史时编辑的是 text 里的副本，history 本身不变；再翻到别的条目时，这次编辑丢弃
 * - submit：text 去掉首尾空白后不为空、并且和最新一条历史不同时，加到历史末尾，超过 MAX_HISTORY 时丢掉最旧的；
 *   然后清空 text，光标归零，退出翻历史，draft 清空
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { text, cursor } = state;
  switch (action.type) {
    case "insert":
    case "newline": {
      const inserted = action.type === "newline"
        ? "\n"
        : action.text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (inserted === "") return state;
      return replaceText(state, text.slice(0, cursor) + inserted + text.slice(cursor), cursor + inserted.length);
    }
    case "left":
    case "backspace": {
      const previous = segmenter.segment(text).containing(cursor - 1)?.index ?? 0;
      return action.type === "left"
        ? moveCursor(state, previous)
        : replaceText(state, text.slice(0, previous) + text.slice(cursor), previous);
    }
    case "right":
    case "delete": {
      const part = segmenter.segment(text).containing(cursor);
      const next = part ? part.index + part.segment.length : text.length;
      return action.type === "right"
        ? moveCursor(state, next)
        : replaceText(state, text.slice(0, cursor) + text.slice(next), cursor);
    }
    case "wordLeft":
      return moveCursor(state, wordBoundary(text, cursor, -1));
    case "wordRight":
      return moveCursor(state, wordBoundary(text, cursor, 1));
    case "lineStart":
      return moveCursor(state, lineStart(text, cursor));
    case "lineEnd":
      return moveCursor(state, lineEnd(text, cursor));
    case "deleteWordBefore": {
      const start = wordBoundary(text, cursor, -1);
      return replaceText(state, text.slice(0, start) + text.slice(cursor), start);
    }
    case "deleteToLineStart": {
      const start = lineStart(text, cursor);
      return replaceText(state, text.slice(0, start) + text.slice(cursor), start);
    }
    case "deleteToLineEnd":
      return replaceText(state, text.slice(0, cursor) + text.slice(lineEnd(text, cursor)), cursor);
    case "up": {
      const start = lineStart(text, cursor);
      if (start > 0) {
        const end = start - 1;
        const column = displayWidth(text.slice(start, cursor));
        return moveCursor(state, cursorAtColumn(text, lineStart(text, end), end, column));
      }
      const index = state.historyIndex === undefined ? state.history.length - 1 : state.historyIndex - 1;
      if (index < 0) return state;
      const previous = state.history[index]!;
      return {
        ...state,
        text: previous,
        cursor: previous.length,
        historyIndex: index,
        draft: state.historyIndex === undefined ? text : state.draft,
      };
    }
    case "down": {
      const end = lineEnd(text, cursor);
      if (end < text.length) {
        const start = end + 1;
        const column = displayWidth(text.slice(lineStart(text, cursor), cursor));
        return moveCursor(state, cursorAtColumn(text, start, lineEnd(text, start), column));
      }
      if (state.historyIndex === undefined) return state;
      const index = state.historyIndex + 1;
      if (index < state.history.length) {
        const next = state.history[index]!;
        return { ...state, text: next, cursor: next.length, historyIndex: index };
      }
      return { ...state, text: state.draft, cursor: state.draft.length, historyIndex: undefined, draft: "" };
    }
    case "submit": {
      const history = text.trim() !== "" && text !== state.history.at(-1)
        ? [...state.history, text].slice(-MAX_HISTORY)
        : state.history;
      if (text === "" && cursor === 0 && history === state.history && state.historyIndex === undefined && state.draft === "") {
        return state;
      }
      return { ...state, text: "", cursor: 0, history, historyIndex: undefined, draft: "" };
    }
  }
}

export interface EditorLayout {
  /** 折行后的每一行 */
  rows: string[];
  /** 光标在第几行（rows 的下标） */
  cursorRow: number;
  /** 光标在这一行的第几列，按显示宽度算 */
  cursorColumn: number;
}

/**
 * 按宽度把内容折成多行，并算出光标的位置。界面把 rows 逐行显示，不再让 Ink 折行，
 * 这样光标位置和显示的内容一定对得上；中文输入法的候选框跟着终端光标走，位置要准。
 * - 先按 \n 分成逻辑行，每一行再按显示宽度折行：加上下一个字素会超过 width 时换到新的一行。
 *   一个字素本身比 width 还宽时，单独占一行
 * - 空的逻辑行也占一行
 * - 光标正好在自动折行的位置时，显示在下一行开头；在逻辑行末尾时，显示在这一行的最后，
 *   这时列号可能等于 width，调用方要给光标留出一列
 */
export function layoutEditor(text: string, cursor: number, width: number): EditorLayout {
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    rows.push("");
    let column = 0;
    for (const part of segmenter.segment(line)) {
      const size = displayWidth(part.segment);
      if (rows.at(-1) !== "" && column + size > width) {
        rows.push("");
        column = 0;
      }
      // 先折行再记录，自动折行处的光标就落在下一行开头。
      if (cursor === offset + part.index) {
        cursorRow = rows.length - 1;
        cursorColumn = column;
      }
      rows[rows.length - 1] += part.segment;
      column += size;
    }
    if (cursor === offset + line.length) {
      cursorRow = rows.length - 1;
      cursorColumn = column;
    }
    offset += line.length + 1;
  }
  return { rows, cursorRow, cursorColumn };
}
