import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { ScreenStore, TerminalView, type ViewHandlers } from "./ink-terminal.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("ScreenStore", () => {
  test("流式片段：完整的行放进 lines，没写完的留在 partial", () => {
    const store = new ScreenStore();
    store.stream("第一");
    assert.deepEqual([store.get().lines, store.get().partial], [[], "第一"]);
    store.stream("行\n第二行\n第三");
    assert.deepEqual(store.get().lines.map((line) => line.text), ["第一行\n第二行"]);
    assert.equal(store.get().partial, "第三");
    store.endLine();
    assert.deepEqual(store.get().lines.map((line) => line.text), ["第一行\n第二行", "第三"]);
    assert.equal(store.get().partial, "");
  });

  test("print 先结束没写完的那一行；空字符串用空格占住一行", () => {
    const store = new ScreenStore();
    store.stream("半行");
    store.print("完整");
    store.print("");
    assert.deepEqual(store.get().lines.map((line) => line.text), ["半行", "完整", " "]);
    const ids = store.get().lines.map((line) => line.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("发送的内容留在输出里，多行时对齐；空输入只在回答询问时留下", () => {
    const store = new ScreenStore();
    store.echoInput("");
    store.echoInput("第一行\n第二行");
    store.update({ prompt: "  > ", recordHistory: false });
    store.echoInput("");
    assert.deepEqual(store.get().lines.map((line) => line.text), ["> 第一行\n  第二行", "  > "]);
  });
});

describe("TerminalView", () => {
  function setup(history: string[] = []) {
    const store = new ScreenStore();
    const calls: string[] = [];
    const handlers: ViewHandlers = {
      submit: (text) => calls.push(`submit:${text}`),
      interrupt: () => calls.push("interrupt"),
      close: () => calls.push("close"),
    };
    const view = render(h(TerminalView, { store, history, handlers }));
    return { store, calls, ...view };
  }

  /** 输入框里第一行的内容 */
  function inputLine(frame: string | undefined): string {
    const rows = (frame ?? "").split("\n");
    const top = rows.findIndex((row) => row.startsWith("─"));
    return rows[top + 1]?.trimEnd() ?? "";
  }

  test("输入后回车发送，输入框清空", async (t) => {
    const { stdin, lastFrame, calls, unmount } = setup();
    t.after(unmount);
    await tick();
    stdin.write("你好");
    await tick();
    assert.equal(inputLine(lastFrame()), "> 你好");
    stdin.write("\r");
    await tick();
    assert.deepEqual(calls, ["submit:你好"]);
    assert.equal(inputLine(lastFrame()), ">");
  });

  test("粘贴的多行内容整段进输入框，回车时作为一条发送", async (t) => {
    const { stdin, calls, unmount } = setup();
    t.after(unmount);
    await tick();
    stdin.write("\x1b[200~第一行\r\n第二行\x1b[201~");
    await tick();
    stdin.write("\r");
    await tick();
    assert.deepEqual(calls, ["submit:第一行\n第二行"]);
  });

  test("Ctrl+J、Option+Enter、Shift+Enter 和行尾反斜杠加回车都是换行", async (t) => {
    const { stdin, calls, unmount } = setup();
    t.after(unmount);
    await tick();
    for (const key of ["a", "\n", "b", "\x1b\r", "c", "\x1b[13;2u", "d\\", "\r", "e", "\r"]) {
      stdin.write(key);
      await tick();
    }
    assert.deepEqual(calls, ["submit:a\nb\nc\nd\ne"]);
  });

  test("Ctrl-C 有内容时清空，没内容时中断；Ctrl-D 没内容时结束输入", async (t) => {
    const { stdin, lastFrame, calls, unmount } = setup();
    t.after(unmount);
    await tick();
    stdin.write("草稿");
    await tick();
    stdin.write("\x03");
    await tick();
    assert.equal(inputLine(lastFrame()), ">");
    assert.deepEqual(calls, []);
    stdin.write("\x03");
    await tick();
    stdin.write("\x04");
    await tick();
    assert.deepEqual(calls, ["interrupt", "close"]);
  });

  test("按上翻出历史；回答询问时输入的内容不进历史", async (t) => {
    const { stdin, lastFrame, store, calls, unmount } = setup(["旧问题"]);
    t.after(unmount);
    await tick();
    stdin.write("\x1b[A");
    await tick();
    assert.equal(inputLine(lastFrame()), "> 旧问题");
    stdin.write("\r");
    await tick();

    store.update({ prompt: "  > ", recordHistory: false });
    await tick();
    stdin.write("y");
    await tick();
    stdin.write("\r");
    await tick();
    store.update({ prompt: "> ", recordHistory: true });
    await tick();
    stdin.write("\x1b[A");
    await tick();
    assert.equal(inputLine(lastFrame()), "> 旧问题");
    assert.deepEqual(calls, ["submit:旧问题", "submit:y"]);
  });

  test("写完的内容在上面，没写完的那一行、运行状态、输入框、状态栏依次在下面", async (t) => {
    const { stdin, lastFrame, store, unmount } = setup();
    t.after(unmount);
    store.print("已经写完");
    store.stream("还在写");
    store.update({ busy: true, footer: "auto · 模型" });
    await tick();
    stdin.write("a\tb");
    await tick();
    const rows = (lastFrame() ?? "").split("\n").map((row) => row.trimEnd());
    const top = rows.findIndex((row) => row.startsWith("─"));
    assert.deepEqual(rows.slice(top - 3), [
      "已经写完",
      "还在写",
      "运行中：回车插话，Ctrl-C 中断",
      rows[top],
      "> a    b",
      rows[top],
      "auto · 模型",
    ]);
  });
});
