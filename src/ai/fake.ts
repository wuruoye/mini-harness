// 测试用的假模型：按预先写好的脚本依次返回回复，并记下收到的每个请求。

import type {
  AssistantContent,
  AssistantMessage,
  CompleteOptions,
  ModelRequest,
  Provider,
  StopReason,
  StreamDelta,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
} from "./types.ts";

/**
 * 一条脚本回复：固定的消息，或者根据请求现场生成。
 * 生成函数可以是异步的，能拿到中止信号；还能拿到 onDelta，用来模拟「先吐几段增量，再返回完整消息」
 */
export type FakeReply =
  | AssistantMessage
  | ((
      request: ModelRequest,
      signal?: AbortSignal,
      onDelta?: (delta: StreamDelta) => void,
    ) => AssistantMessage | Promise<AssistantMessage>);

export class FakeProvider implements Provider {
  /**
   * 收到的请求，按顺序排列。
   * 存的是深拷贝：调用方传进来的是自己的历史数组，之后还会往里追加，直接存引用的话这里也会跟着变。
   */
  readonly requests: ModelRequest[] = [];
  #replies: FakeReply[];

  constructor(replies: FakeReply[]) {
    this.#replies = [...replies];
  }

  async complete(request: ModelRequest, options?: CompleteOptions): Promise<AssistantMessage> {
    const signal = options?.signal;
    // 和真实的 fetch 一样：已经中止的信号，请求不会发出去
    signal?.throwIfAborted();
    this.requests.push(structuredClone(request));
    const reply = this.#replies.shift();
    if (reply === undefined) {
      const count = this.requests.length;
      throw new Error(`FakeProvider：脚本只有 ${count - 1} 条回复，却收到了第 ${count} 个请求`);
    }
    // 返回拷贝，调用方修改返回的消息不会影响测试里用来比对的原对象
    return structuredClone(typeof reply === "function" ? await reply(request, signal, options?.onDelta) : reply);
  }
}

/** 模拟一个迟迟不返回的请求：一直等到被中止，然后以中止的原因结束 */
export function hangUntilAborted(): FakeReply {
  return (_request, signal) =>
    new Promise((_resolve, reject) => {
      if (!signal) return reject(new Error("hangUntilAborted：调用 complete 时没有传 signal"));
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

export function text(text: string): TextBlock {
  return { type: "text", text };
}

export function thinking(thinking: string, signature?: string): ThinkingBlock {
  return signature === undefined ? { type: "thinking", thinking } : { type: "thinking", thinking, signature };
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCallBlock {
  return { type: "toolCall", id, name, arguments: args };
}

/** 构造一条假的 assistant 回复。不指定 stopReason 时，有工具调用为 "toolUse"，否则为 "stop" */
export function fakeReply(content: AssistantContent[], stopReason?: StopReason): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason: stopReason ?? (content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
    provider: "fake",
    model: "fake-model",
  };
}
