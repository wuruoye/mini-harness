// 把 SSE（Server-Sent Events）字节流解析成事件。
// Anthropic 和 OpenAI 的流式接口都用这种格式，每个事件由若干字段行加一个空行组成：
//
//   event: content_block_delta
//   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}
//
// 规范：https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation

export interface SseEvent {
  /** `event:` 字段的值；事件里没有这一行时为 "message" */
  event: string;
  /** 所有 `data:` 行的值用 "\n" 连接 */
  data: string;
}

/**
 * 逐个产出事件。输入可以是 fetch 返回的 `response.body`，也可以是测试里构造的分块。
 *
 * 网络分块的边界是任意的，可能落在一个 UTF-8 字符的中间，也可能落在 "\r\n" 的两个字符之间，
 * 所以要先缓存，凑齐完整的行再处理。
 */
export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  // stream: true 时，被切开的多字节字符会留在 decoder 里，等下一块到了再拼完整
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  function handleLine(line: string): SseEvent | undefined {
    if (line === "") {
      // 空行表示事件结束
      if (dataLines.length === 0) {
        eventType = "";
        return undefined;
      }
      const event = { event: eventType || "message", data: dataLines.join("\n") };
      eventType = "";
      dataLines = [];
      return event;
    }
    if (line.startsWith(":")) return undefined; // 注释行，服务端常用来发心跳

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
    // id 和 retry 用于浏览器断线重连，这里用不上，和未知字段一样忽略
    return undefined;
  }

  // 从 buffer 里取出所有完整的行，剩下不完整的部分留到下次
  function* drain(final: boolean): Generator<SseEvent> {
    const terminator = /\r\n|\r|\n/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = terminator.exec(buffer)) !== null) {
      // 末尾单独一个 "\r" 可能是被切开的 "\r\n"，等下一块数据到了再判断
      if (match[0] === "\r" && match.index === buffer.length - 1 && !final) break;
      const event = handleLine(buffer.slice(start, match.index));
      if (event) yield event;
      start = terminator.lastIndex;
    }
    buffer = buffer.slice(start);
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
  // 规范要求：流结束时还没等到空行的事件直接丢弃，所以这里不处理剩下的 buffer
}
