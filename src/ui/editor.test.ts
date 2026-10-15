import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createEditor,
  editorReducer,
  layoutEditor,
  MAX_HISTORY,
  type EditorAction,
  type EditorState,
} from "./editor.ts";

/** 依次执行动作，返回最后的状态 */
function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

/** 内容为 text、光标在 cursor 的编辑器 */
function at(text: string, cursor = text.length, history: string[] = []): EditorState {
  return { ...createEditor(history), text, cursor };
}

const left: EditorAction = { type: "left" };
const right: EditorAction = { type: "right" };
const up: EditorAction = { type: "up" };
const down: EditorAction = { type: "down" };
const backspace: EditorAction = { type: "backspace" };
const submit: EditorAction = { type: "submit" };
const insert = (text: string): EditorAction => ({ type: "insert", text });

describe("createEditor", () => {
  test("空内容，复制历史，只保留最新的 MAX_HISTORY 条", () => {
    const history = ["一", "二"];
    const editor = createEditor(history);
    assert.deepEqual(editor, { text: "", cursor: 0, history: ["一", "二"], historyIndex: undefined, draft: "" });
    assert.notEqual(editor.history, history);

    const many = Array.from({ length: MAX_HISTORY + 2 }, (_, i) => String(i));
    const trimmed = createEditor(many).history;
    assert.equal(trimmed.length, MAX_HISTORY);
    assert.equal(trimmed[0], "2");
    assert.equal(trimmed.at(-1), String(MAX_HISTORY + 1));
  });
});

describe("editorReducer 编辑", () => {
  test("在光标处插入，光标移到插入内容之后", () => {
    const state = run(createEditor(), insert("ab"), left, insert("X"));
    assert.equal(state.text, "aXb");
    assert.equal(state.cursor, 2);
  });

  test("插入时统一换行符，去掉控制字符，保留制表符", () => {
    assert.equal(run(createEditor(), insert("1\r\n2\r3")).text, "1\n2\n3");
    assert.equal(run(createEditor(), insert("a\x1bb\x07c\x7f")).text, "abc");
    assert.equal(run(createEditor(), insert("a\tb")).text, "a\tb");
  });

  test("没有变化时返回同一个对象", () => {
    const empty = createEditor();
    for (const action of [insert("\x1b\x07"), backspace, { type: "delete" }, left, up, down] as EditorAction[]) {
      assert.equal(editorReducer(empty, action), empty, action.type);
    }
    const end = at("ab");
    assert.equal(editorReducer(end, right), end);
    assert.equal(editorReducer(end, { type: "delete" }), end);
    assert.equal(editorReducer(end, { type: "deleteToLineEnd" }), end);
    const start = at("ab", 0);
    assert.equal(editorReducer(start, { type: "deleteToLineStart" }), start);
  });

  test("不修改传入的状态", () => {
    const state = at("中文\nabc", 4, ["旧"]);
    const copy = structuredClone(state);
    for (const action of [insert("x"), backspace, up, down, submit, { type: "deleteWordBefore" }] as EditorAction[]) {
      editorReducer(state, action);
    }
    assert.deepEqual(state, copy);
  });

  test("左右移动、删除都按字素走", () => {
    const text = "a👍b";
    let state = at(text);
    state = editorReducer(state, left);
    assert.equal(state.cursor, 3);
    state = editorReducer(state, left);
    assert.equal(state.cursor, 1);
    state = editorReducer(state, right);
    assert.equal(state.cursor, 3);
    state = editorReducer(state, backspace);
    assert.deepEqual([state.text, state.cursor], ["ab", 1]);

    const family = "👨‍👩‍👧";
    assert.equal(editorReducer(at(`x${family}`), backspace).text, "x");
    assert.equal(editorReducer(at(`${family}x`, 0), { type: "delete" }).text, "x");
  });

  test("编辑后两侧合成一个字素时，光标落在整个字素之后", () => {
    const joined = editorReducer(at("👨👩", 2), insert("\u200d"));
    assert.deepEqual([joined.text, joined.cursor], ["👨‍👩", 5]);
    assert.equal(editorReducer(joined, backspace).text, "");

    const inserted = editorReducer(at("\u0301", 0), insert("e"));
    assert.deepEqual([inserted.text, inserted.cursor], ["e\u0301", 2]);
    const deleted = editorReducer(at("e\n\u0301", 2), backspace);
    assert.deepEqual([deleted.text, deleted.cursor], ["e\u0301", 2]);
  });

  test("换行，以及行首行尾", () => {
    const state = editorReducer(at("ab", 1), { type: "newline" });
    assert.deepEqual([state.text, state.cursor], ["a\nb", 2]);

    const lines = at("ab\ncd", 4);
    assert.equal(editorReducer(lines, { type: "lineStart" }).cursor, 3);
    assert.equal(editorReducer(lines, { type: "lineEnd" }).cursor, 5);
    assert.equal(editorReducer(at("ab\ncd", 1), { type: "lineEnd" }).cursor, 2);
  });

  test("按单词移动和删除，空白包括换行", () => {
    const text = "foo bar  baz";
    let state = at(text);
    state = editorReducer(state, { type: "wordLeft" });
    assert.equal(state.cursor, 9);
    state = editorReducer(state, { type: "wordLeft" });
    assert.equal(state.cursor, 4);
    assert.equal(editorReducer(state, { type: "wordRight" }).cursor, 7);

    const deleted = editorReducer(at(text), { type: "deleteWordBefore" });
    assert.deepEqual([deleted.text, deleted.cursor], ["foo bar  ", 9]);
    assert.equal(editorReducer(at("foo\nbar", 4), { type: "wordLeft" }).cursor, 0);
  });

  test("删除到行首、行尾", () => {
    const toStart = editorReducer(at("ab\ncd", 4), { type: "deleteToLineStart" });
    assert.deepEqual([toStart.text, toStart.cursor], ["ab\nd", 3]);
    const toEnd = editorReducer(at("ab\ncd", 1), { type: "deleteToLineEnd" });
    assert.deepEqual([toEnd.text, toEnd.cursor], ["a\ncd", 1]);
  });
});

describe("editorReducer 上下移动和历史", () => {
  test("多行时上下移动到同一列，列按显示宽度算", () => {
    assert.equal(editorReducer(at("中文\nabcd"), up).cursor, 2);
    assert.equal(editorReducer(at("abcd\n中文", 3), down).cursor, 6);
    assert.equal(editorReducer(at("abcd\nxy", 4), down).cursor, 7);
  });

  test("在第一行按上翻历史，翻到最新之后恢复草稿", () => {
    let state = run(createEditor(["一", "二"]), insert("草稿"));
    state = editorReducer(state, up);
    assert.deepEqual([state.text, state.cursor, state.historyIndex, state.draft], ["二", 1, 1, "草稿"]);
    state = editorReducer(state, up);
    assert.equal(state.text, "一");
    assert.equal(editorReducer(state, up), state);

    state = editorReducer(state, down);
    assert.equal(state.text, "二");
    state = editorReducer(state, down);
    assert.deepEqual([state.text, state.cursor, state.historyIndex, state.draft], ["草稿", 2, undefined, ""]);
    assert.equal(editorReducer(state, down), state);
  });

  test("多行内容先在行之间移动，到第一行才翻历史", () => {
    let state = at("a\nb", 3, ["旧"]);
    state = editorReducer(state, up);
    assert.deepEqual([state.text, state.cursor], ["a\nb", 1]);
    state = editorReducer(state, up);
    assert.equal(state.text, "旧");
  });

  test("翻历史时的编辑不改历史，翻到别的条目时丢弃", () => {
    let state = run(createEditor(["一", "二"]), up, insert("!"));
    assert.equal(state.text, "二!");
    state = editorReducer(state, up);
    assert.equal(state.text, "一");
    state = editorReducer(state, down);
    assert.equal(state.text, "二");
    assert.deepEqual(state.history, ["一", "二"]);
  });

  test("发送后清空，加进历史；空白和重复的不加", () => {
    let state = run(createEditor(["一"]), insert("问题"), submit);
    assert.deepEqual(state, { text: "", cursor: 0, history: ["一", "问题"], historyIndex: undefined, draft: "" });
    state = run(state, insert("问题"), submit, insert("  \n "), submit);
    assert.deepEqual(state.history, ["一", "问题"]);
    assert.equal(state.text, "");

    const browsing = run(createEditor(["一", "二"]), insert("草稿"), up, up, submit);
    assert.deepEqual([browsing.history, browsing.historyIndex, browsing.draft], [["一", "二", "一"], undefined, ""]);
  });

  test("历史超过 MAX_HISTORY 条时丢掉最旧的", () => {
    const full = Array.from({ length: MAX_HISTORY }, (_, i) => String(i));
    const history = run(createEditor(full), insert("新"), submit).history;
    assert.equal(history.length, MAX_HISTORY);
    assert.equal(history[0], "1");
    assert.equal(history.at(-1), "新");
  });
});

describe("layoutEditor", () => {
  test("空内容和不用折行的内容", () => {
    assert.deepEqual(layoutEditor("", 0, 10), { rows: [""], cursorRow: 0, cursorColumn: 0 });
    assert.deepEqual(layoutEditor("abc", 1, 10), { rows: ["abc"], cursorRow: 0, cursorColumn: 1 });
  });

  test("超过宽度时折行，光标在折行处显示在下一行开头，在行末时可以等于宽度", () => {
    assert.deepEqual(layoutEditor("abcdef", 6, 4), { rows: ["abcd", "ef"], cursorRow: 1, cursorColumn: 2 });
    assert.deepEqual(layoutEditor("abcdef", 4, 4), { rows: ["abcd", "ef"], cursorRow: 1, cursorColumn: 0 });
    assert.deepEqual(layoutEditor("abcd", 4, 4), { rows: ["abcd"], cursorRow: 0, cursorColumn: 4 });
    assert.deepEqual(layoutEditor("abcd\nxy", 4, 4), { rows: ["abcd", "xy"], cursorRow: 0, cursorColumn: 4 });
  });

  test("按 \\n 分行，空行也占一行", () => {
    assert.deepEqual(layoutEditor("ab\n\ncd", 3, 10), { rows: ["ab", "", "cd"], cursorRow: 1, cursorColumn: 0 });
    assert.deepEqual(layoutEditor("ab\n\ncd", 4, 10), { rows: ["ab", "", "cd"], cursorRow: 2, cursorColumn: 0 });
    assert.deepEqual(layoutEditor("ab\n", 3, 10), { rows: ["ab", ""], cursorRow: 1, cursorColumn: 0 });
  });

  test("按显示宽度折行，放不下的字素换到下一行", () => {
    assert.deepEqual(layoutEditor("中文字符", 3, 5), { rows: ["中文", "字符"], cursorRow: 1, cursorColumn: 2 });
    assert.deepEqual(layoutEditor("中文字符", 2, 5), { rows: ["中文", "字符"], cursorRow: 1, cursorColumn: 0 });
    assert.deepEqual(layoutEditor("a中", 2, 1), { rows: ["a", "中"], cursorRow: 1, cursorColumn: 2 });
    const family = "👨‍👩‍👧";
    assert.deepEqual(layoutEditor(`a${family}b`, 1 + family.length, 1), { rows: ["a", family, "b"], cursorRow: 2, cursorColumn: 0 });
  });
});
