// 子目录的指令文件：启动时只读「仓库根目录到工作目录」这一串，工作目录下面子目录里的 AGENTS.md，
// 等模型用工具碰到那个子目录里的文件时才加载，接在这次工具结果的后面。
// 系统提示保持不变；指令跟着工具结果进入历史，也会写进会话文件。

import type { Message } from "../ai/types.ts";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isInside } from "./permission.ts";
import { readInstructionFile, type InstructionFile } from "./system-prompt.ts";
import type { Tool } from "./types.ts";

/** 工具结果里子目录指令部分的标题。从历史里找已加载的路径时，只看这个标题后面的内容 */
export const NESTED_INSTRUCTIONS_HEADING = "# 子目录的项目指令";

/**
 * 找出 filePath 所在目录和 cwd 之间还没加载过的指令文件，按从外到内的顺序返回，并把它们记进 loaded。
 * - filePath 是相对路径时以 cwd 为准
 * - 只看 cwd 下面的子目录：从 cwd 的下一层开始，一层层往里到文件所在的目录，每层用 readInstructionFile 读。
 *   cwd 这一层启动时已经读过，不再看；文件不在 cwd 里面时返回空数组
 * - loaded 里已有的路径跳过
 * - filePath 本身就是某一层的指令文件时（模型直接读了 AGENTS.md），记进 loaded，但不返回，内容已经在工具结果里了
 */
export async function collectNestedInstructions(
  filePath: string,
  cwd: string,
  loaded: Set<string>,
): Promise<InstructionFile[]> {
  const root = resolve(cwd);
  const target = resolve(root, filePath);
  if (target === root || !isInside(root, target)) return [];

  const files: InstructionFile[] = [];
  let dir = root;
  const parts = relative(root, dirname(target)).split(sep).filter((part) => part !== "");
  for (const part of parts) {
    dir = join(dir, part);
    const file = await readInstructionFile(dir);
    if (!file || loaded.has(file.path)) continue;
    loaded.add(file.path);
    if (file.path !== target) files.push(file);
  }
  return files;
}

/**
 * 把指令文件拼成接在工具结果后面的文字，files 不为空。
 * - 第一行是 NESTED_INSTRUCTIONS_HEADING，下一行说明这些指令适用于对应目录里的文件
 * - 每个文件的 <instructions path="..."> 格式和系统提示里的一致，可以和 buildSystemPrompt 共用同一个函数
 */
export function formatNestedInstructions(files: InstructionFile[]): string {
  return [
    `${NESTED_INSTRUCTIONS_HEADING}\n以下指令适用于各指令文件所在目录及其子目录中的文件，越靠后越具体。`,
    ...files.map((file) => `<instructions path="${file.path}">\n${file.content}\n</instructions>`),
  ].join("\n\n");
}

/**
 * 给工具包一层：工具执行成功后，按参数 pathArg 指定的路径收集子目录的指令文件，接在结果后面，之间空一行。
 * - 返回的工具 definition 和原工具相同
 * - cwd 用 context.cwd
 * - 工具抛异常时原样抛出；结果 isError 为 true 时原样返回，不加载指令
 * - 参数里的路径不是非空字符串时原样返回
 * - 没有新的指令文件时，结果原样返回
 * - loaded 由调用方持有，每一轮开始前由调用方重建，这里只往里加
 */
export function withNestedInstructions(tool: Tool, pathArg: string, loaded: Set<string>): Tool {
  return {
    definition: tool.definition,
    async execute(args, context) {
      const result = await tool.execute(args, context);
      const path = args[pathArg];
      if (result.isError || typeof path !== "string" || path === "") return result;
      const files = await collectNestedInstructions(path, context.cwd, loaded);
      if (files.length === 0) return result;
      return { ...result, content: `${result.content}\n\n${formatNestedInstructions(files)}` };
    },
  };
}

/**
 * 从消息里找出已经加载过的子目录指令文件路径，按出现顺序返回，不重复。
 * - 只看 toolResult 消息里 NESTED_INSTRUCTIONS_HEADING 后面的部分，取其中每个 <instructions path="..."> 的路径。
 *   工具结果前面是文件内容，里面也可能出现这种标签（比如读了这个文件本身），不能算进去
 * - 传入的应该是这一轮要发给模型的上下文（buildContext 的结果）：压缩后被摘要代替的工具结果不在里面，
 *   其中的指令文件之后碰到时会重新加载
 */
export function loadedFromHistory(messages: Message[]): string[] {
  const loaded = new Set<string>();
  const heading = `${NESTED_INSTRUCTIONS_HEADING}\n`;
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const start = message.content.lastIndexOf(heading);
    if (start === -1 || (start > 0 && message.content[start - 1] !== "\n")) continue;
    const section = message.content.slice(start + heading.length);
    for (const match of section.matchAll(/<instructions path="([^"]+)">/g)) {
      loaded.add(match[1]!);
    }
  }
  return [...loaded];
}
