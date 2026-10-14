import type { Tool } from "../agent/types.ts";

/** 单次最多返回的字符数，超出部分截断，避免一个大文件占满上下文 */
export const MAX_READ_CHARS = 50_000;

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: `读取文本文件内容。path 可以是相对工作目录的路径，也可以是绝对路径。超过 ${MAX_READ_CHARS} 个字符的部分会被截断。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },

  /**
   * - path 缺失或不是字符串时抛异常，错误信息里要提到 path
   * - 相对路径按 context.cwd 解析
   * - 读取失败（比如文件不存在）直接抛异常
   * - 超过 MAX_READ_CHARS 时只保留前 MAX_READ_CHARS 个字符，并在后面注明已截断
   */
  async execute(args, context) {
    throw new Error("未实现");
  },
};
