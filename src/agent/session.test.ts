import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fakeReply, text, thinking, toolCall } from "../ai/fake.ts";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "../ai/types.ts";
import { appendCompaction, appendMessage, createSession, listSessions, loadSession, SESSION_VERSION, sessionDir } from "./session.ts";
import type { Compaction } from "./compaction.ts";

let base = "";
const cwd = "/Users/a/my proj";

before(async () => {
  base = await mkdtemp(join(tmpdir(), "mini-harness-session-"));
});

after(() => rm(base, { recursive: true, force: true }));

const user = (content: string): UserMessage => ({ role: "user", content });
const assistant: AssistantMessage = {
  ...fakeReply([thinking("想一想", "sig-1"), text("我来读"), toolCall("call_1", "read_file", { path: "a.txt" })]),
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "第一行\n第二行", isError: false };

async function lines(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
}

describe("sessionDir", () => {
  test("cwd 里的特殊字符换成短横线", () => {
    assert.equal(sessionDir("/base", "/Users/a/my proj"), join("/base", "-Users-a-my-proj"));
    assert.equal(sessionDir("/base", "/a/b_c.d-e"), join("/base", "-a-b_c.d-e"));
  });
});

describe("createSession", () => {
  test("创建目录和文件，第一行是会话信息", async () => {
    const now = new Date("2026-10-14T08:30:15.123Z");
    const session = await createSession(base, cwd, now);

    assert.match(session.id, /^20261014T083015Z-[0-9a-f]{6}$/);
    assert.equal(session.file, join(sessionDir(base, cwd), `${session.id}.jsonl`));
    assert.equal(session.cwd, cwd);
    assert.equal(session.createdAt, now.toISOString());
    assert.deepEqual(session.messages, []);
    assert.deepEqual((await lines(session.file)).map((line) => JSON.parse(line)), [
      { type: "session", version: SESSION_VERSION, id: session.id, cwd, createdAt: now.toISOString() },
    ]);
  });

  test("同一秒内新建的会话 id 也不同", async () => {
    const now = new Date("2026-10-14T08:30:15Z");
    const a = await createSession(base, cwd, now);
    const b = await createSession(base, cwd, now);
    assert.notEqual(a.id, b.id);
  });
});

describe("appendMessage 和 loadSession", () => {
  test("追加的消息每条一行，读回来完全一致", async () => {
    const session = await createSession(base, "/round/trip");
    for (const message of [user("你好"), assistant, toolResult]) {
      await appendMessage(session, message);
    }
    assert.deepEqual(session.messages, [user("你好"), assistant, toolResult]);

    // 内容里的换行被 JSON 转义，不会拆成多行
    assert.equal((await lines(session.file)).length, 4);
    const loaded = await loadSession(session.file);
    assert.deepEqual([loaded.id, loaded.file, loaded.cwd, loaded.createdAt], [session.id, session.file, session.cwd, session.createdAt]);
    assert.deepEqual(loaded.messages, session.messages);
    assert.equal(loaded.compaction, undefined);
  });

  test("不等上一次写完就接着追加，也按调用顺序写入", async () => {
    const session = await createSession(base, "/order");
    const messages = Array.from({ length: 200 }, (_, i) => user(`第 ${i} 条 ${"x".repeat(i * 50)}`));
    await Promise.all(messages.map((message) => appendMessage(session, message)));
    assert.deepEqual((await loadSession(session.file)).messages, messages);
  });

  test("调用 appendMessage 后不用等写完，session.messages 里就已经有这条消息", async () => {
    const session = await createSession(base, "/sync");
    const pending = appendMessage(session, user("马上可见"));
    assert.deepEqual(session.messages, [user("马上可见")]);
    await pending;
  });

  test("某次写入失败后，之后的追加还能正常写入", async () => {
    const session = await createSession(base, "/write-error");
    await appendMessage(session, user("一"));

    // 把文件改成只读，让下一次写入失败
    await chmod(session.file, 0o444);
    await assert.rejects(appendMessage(session, user("写不进去")));
    await chmod(session.file, 0o644);

    await appendMessage(session, user("三"));
    assert.deepEqual((await loadSession(session.file)).messages, [user("一"), user("三")]);
  });

  test("跳过空行", async () => {
    const session = await createSession(base, "/blank");
    await appendMessage(session, user("一"));
    await appendFile(session.file, "\n\n");
    await appendMessage(session, user("二"));
    assert.deepEqual((await loadSession(session.file)).messages, [user("一"), user("二")]);
  });

  test("最后一行写到一半时忽略它，并截掉，之后还能正常追加", async () => {
    const session = await createSession(base, "/crash");
    await appendMessage(session, user("一"));
    await appendFile(session.file, '{"type":"message","message":{"role":"us');

    const loaded = await loadSession(session.file);
    assert.deepEqual(loaded.messages, [user("一")]);

    await appendMessage(loaded, user("二"));
    assert.deepEqual((await loadSession(session.file)).messages, [user("一"), user("二")]);
  });

  test("最后一行完整但没有换行时，恢复后仍能正常追加", async () => {
    const session = await createSession(base, "/no-final-newline");
    await appendMessage(session, user("一"));
    const content = await readFile(session.file, "utf8");
    await writeFile(session.file, content.slice(0, -1));

    const loaded = await loadSession(session.file);
    await appendMessage(loaded, user("二"));
    assert.deepEqual((await loadSession(session.file)).messages, [user("一"), user("二")]);
  });

  test("中间某行损坏时抛异常，信息里有行号", async () => {
    const session = await createSession(base, "/corrupt");
    await appendMessage(session, user("一"));
    await appendFile(session.file, "这不是 JSON\n");
    await appendMessage(session, user("二"));
    await assert.rejects(loadSession(session.file), /第 3 行/);
  });

  test("第一条记录不是会话信息时抛异常，信息里提到 session", async () => {
    const file = join(base, "no-header.jsonl");
    await writeFile(file, JSON.stringify({ type: "message", message: user("hi"), timestamp: "x" }) + "\n");
    await assert.rejects(loadSession(file), /session/);
  });
});

describe("listSessions", () => {
  test("目录不存在时返回空数组", async () => {
    assert.deepEqual(await listSessions(base, "/nothing/here"), []);
  });

  test("按最后更新时间从新到旧，带消息数和预览", async () => {
    const project = "/list/project";
    const older = await createSession(base, project, new Date("2026-10-01T00:00:00Z"));
    await appendMessage(older, user("第一个会话"), new Date("2026-10-01T00:01:00Z"));

    const newer = await createSession(base, project, new Date("2026-10-02T00:00:00Z"));
    await appendMessage(newer, user("第二个会话\n第二行不进预览"), new Date("2026-10-02T00:01:00Z"));
    await appendMessage(newer, assistant, new Date("2026-10-02T00:02:00Z"));

    // 旧会话最近又更新过，应该排到最前面
    await appendMessage(older, user("x".repeat(80)), new Date("2026-10-03T00:00:00Z"));

    const list = await listSessions(base, project);
    assert.deepEqual(
      list.map((info) => [info.id, info.updatedAt, info.messageCount, info.preview]),
      [
        [older.id, "2026-10-03T00:00:00.000Z", 2, "第一个会话"],
        [newer.id, "2026-10-02T00:02:00.000Z", 2, "第二个会话"],
      ],
    );
    assert.equal(list[0]!.file, older.file);
    assert.equal(list[0]!.createdAt, "2026-10-01T00:00:00.000Z");
  });

  test("预览超过 50 个字符时截断，没有用户消息时为空", async () => {
    const project = "/list/preview";
    const long = await createSession(base, project);
    await appendMessage(long, user("长".repeat(60)));
    await createSession(base, project);

    const previews = (await listSessions(base, project)).map((info) => info.preview).sort();
    assert.deepEqual(previews, ["", `${"长".repeat(50)}…`]);
  });

  test("只列出 .jsonl 文件", async () => {
    const project = "/list/filter";
    const session = await createSession(base, project);
    await writeFile(join(dirname(session.file), "notes.txt"), "不是会话");
    assert.deepEqual((await listSessions(base, project)).map((info) => basename(info.file)), [basename(session.file)]);
  });
});

describe("压缩记录", () => {
  const first: Compaction = { summary: "摘要一", firstKeptIndex: 1, messageCount: 2, tokensBefore: 1000 };
  const second: Compaction = { summary: "摘要二", firstKeptIndex: 3, messageCount: 4, tokensBefore: 2000 };

  test("追加后立刻可见，读回来是最后一条，消息不受影响", async () => {
    const session = await createSession(base, "/compaction/load");
    await appendMessage(session, user("一"));
    await appendMessage(session, user("二"));
    const pending = appendCompaction(session, first);
    assert.deepEqual(session.compaction, first);
    await pending;
    await appendMessage(session, user("三"));
    await appendMessage(session, user("四"));
    await appendCompaction(session, second);

    const loaded = await loadSession(session.file);
    assert.deepEqual(loaded.compaction, second);
    assert.deepEqual(loaded.messages, [user("一"), user("二"), user("三"), user("四")]);
  });

  test("和 appendMessage 共用写入顺序", async () => {
    const session = await createSession(base, "/compaction/order");
    await Promise.all([
      appendMessage(session, user("x".repeat(100_000))),
      appendCompaction(session, first),
      appendMessage(session, user("短")),
    ]);
    const types = (await lines(session.file)).map((line) => JSON.parse(line).type);
    assert.deepEqual(types, ["session", "message", "compaction", "message"]);
  });

  test("listSessions 的消息数不算压缩记录，更新时间算", async () => {
    const project = "/compaction/list";
    const session = await createSession(base, project, new Date("2026-10-01T00:00:00Z"));
    await appendMessage(session, user("一"), new Date("2026-10-01T00:01:00Z"));
    await appendCompaction(session, first, new Date("2026-10-01T00:02:00Z"));

    const [info] = await listSessions(base, project);
    assert.equal(info!.messageCount, 1);
    assert.equal(info!.updatedAt, "2026-10-01T00:02:00.000Z");
  });
});
