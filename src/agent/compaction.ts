// 上下文压缩：对话太长时，把早期的消息让模型总结成摘要，之后的请求只带「摘要 + 最近的消息」。
// 完整的消息仍然保存在会话里，压缩只影响发给模型的上下文。

import type { Message, Provider } from "../ai/types.ts";

export interface Compaction {
  /** 模型生成的摘要 */
  summary: string;
  /** 完整消息里从这个下标开始的消息原样保留，之前的由摘要代替 */
  firstKeptIndex: number;
  /** 压缩时完整消息的条数。下标小于它的消息是压缩前产生的，下标不小于它的是压缩之后新增的 */
  messageCount: number;
  /** 压缩前上下文的估算 token 数 */
  tokensBefore: number;
}

export const SUMMARY_SYSTEM_PROMPT = `你负责把编程助手和用户的一段对话压缩成摘要。
摘要会代替原始对话交给同一个助手继续工作，所以要保留继续工作需要的全部信息：
用户的目标和要求、已经完成的事、做出的决定和原因、读过或改过的关键文件、遇到的错误和解决办法、还没完成的事。
只写对话里出现过的内容，不要推测或编造。`;

export const SUMMARY_INSTRUCTIONS = `按下面的格式写摘要，用中文。每一部分都尽量具体，文件路径、命令、函数名、报错信息保留原文：

## 目标
## 已完成
## 关键决定
## 涉及的文件
## 待办`;

/** 上下文里摘要消息的开头 */
export const SUMMARY_PREFIX = "以下是之前对话的摘要，更早的消息已经省略：";

/** 工具结果在文字记录里最多保留的字符数 */
export const MAX_TOOL_RESULT_CHARS = 2000;

/**
 * 把消息转成给模型总结用的纯文本记录。thinking 块不写进去；工具结果太长时只保留开头。
 */
export function serializeForSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        parts.push(`[用户]\n${message.content}`);
        break;
      case "assistant":
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim() !== "") parts.push(`[助手]\n${block.text}`);
          else if (block.type === "toolCall") parts.push(`[助手调用工具] ${block.name} ${JSON.stringify(block.arguments)}`);
        }
        break;
      case "toolResult": {
        const omitted = message.content.length - MAX_TOOL_RESULT_CHARS;
        const content = omitted > 0 ? `${message.content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…（省略 ${omitted} 个字符）` : message.content;
        parts.push(`[工具结果] ${message.toolName}${message.isError ? "（出错）" : ""}\n${content}`);
        break;
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * 粗略估算一段文字的 token 数：中日韩字符（Unicode 范围 　-鿿、가-힯、＀-￯）每个算 1 个，
 * 其余字符每 4 个算 1 个，向上取整。比如 "你好abcde" 是 2 + 2 = 4
 */
export function estimateTokens(text: string): number {
  throw new Error("未实现");
}

/**
 * 估算一条消息的 token 数：把消息里会发给模型的文字都拼起来估算。
 * - user：content
 * - assistant：text 块的文字、thinking 块的文字、工具调用的名字和 JSON.stringify(arguments)
 * - toolResult：content
 */
export function estimateMessageTokens(message: Message): number {
  throw new Error("未实现");
}

/**
 * 估算一组消息作为上下文时的 token 数。
 * 找到最后一条带 usage 的 assistant 消息，它的 inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
 * 就是那次请求时上下文的真实大小，再加上它后面每条消息的估算值。
 * 没有带 usage 的 assistant 消息时，全部用估算值相加。
 * usage 的四项加起来是 0 时当作没有 usage：有的服务不返回用量，适配器会把它们都记成 0。
 */
export function contextTokens(messages: Message[]): number {
  throw new Error("未实现");
}

/**
 * 选择压缩的切分点，返回保留部分开始的下标，保留部分从这里一直到末尾。
 * - 保留部分必须从一条 user 消息开始，这样不会把工具调用和它的结果拆开
 * - 在所有 user 消息里，选「从它到末尾的估算 token 数（estimateMessageTokens 之和）不超过 keepTokens」的最靠前的一条
 * - 一条都不满足时，选最后一条 user 消息，至少保留最近一轮
 * - 选出来的是 0，或者根本没有 user 消息时，返回 undefined，表示前面没有可以压缩的内容
 */
export function findCutIndex(messages: Message[], keepTokens: number): number | undefined {
  throw new Error("未实现");
}

/**
 * 让模型把 messages 总结成摘要。
 * - 请求的 system 是 SUMMARY_SYSTEM_PROMPT，不带工具，只有一条 user 消息，内容依次是：
 *   有 previousSummary 时先写「之前的摘要：」加上它；然后写「需要总结的对话记录：」加上 serializeForSummary 的结果；
 *   最后是 SUMMARY_INSTRUCTIONS。各部分之间空一行
 * - 返回回复里所有 text 块拼起来、去掉首尾空白的结果；结果为空时抛异常
 */
export async function summarize(provider: Provider, messages: Message[], previousSummary?: string): Promise<string> {
  throw new Error("未实现");
}

/**
 * 生成要发给模型的上下文。
 * - compaction 为 undefined 时，返回 messages 的拷贝（新数组）
 * - 否则第一条是 user 消息，内容为 SUMMARY_PREFIX + "\n\n" + summary；后面接 messages 从 firstKeptIndex 开始的部分
 * - 保留部分里下标小于 compaction.messageCount 的 assistant 消息（压缩前产生的），去掉 thinking 块和 usage：
 *   thinking 的签名和它之前的完整历史绑定，前文换成摘要后再带回去可能被 API 拒绝；
 *   旧的 usage 记的是压缩前的上下文大小，留着会让 contextTokens 以为上下文还很大
 * - 压缩之后新产生的消息原样保留
 * - 不能修改传入的消息对象
 */
export function buildContext(messages: Message[], compaction: Compaction | undefined): Message[] {
  throw new Error("未实现");
}

/**
 * 压缩一次，返回新的压缩记录；没有可以压缩的内容时返回 undefined，并且不请求模型。
 * - 先用 buildContext(messages, current) 得到当前上下文，记下它的 contextTokens 作为 tokensBefore
 * - 在上下文上用 findCutIndex(上下文, keepTokens) 找切分点
 * - 要总结的是上下文里切分点之前的部分，但不包括开头那条摘要消息；之前的摘要作为 previousSummary 传给 summarize
 * - 切分点前面除了摘要消息没有别的内容时，也算没有可以压缩的内容
 * - 新的 firstKeptIndex 要换算成 messages（完整消息）里的下标；messageCount 是 messages.length
 */
export async function compact(
  provider: Provider,
  messages: Message[],
  current: Compaction | undefined,
  keepTokens: number,
): Promise<Compaction | undefined> {
  throw new Error("未实现");
}
