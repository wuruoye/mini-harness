import type { Tool } from "../agent/types.ts";

export const writeFileTool: Tool = {
  definition: {
    name: "write_file",
    description: "新建文件，或者用新内容整个覆盖已有文件；缺少的上级目录会自动创建。只改已有文件的一部分时用 edit。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "文件的完整内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },

  /**
   * - path 必须是非空字符串，content 必须是字符串（可以是空字符串）；不符合时抛异常，信息里提到出错的参数名
   * - 相对路径按 context.cwd 解析，缺少的上级目录自动创建
   * - 返回的 content 说明写了哪个文件、多少个字符，以及是新建还是覆盖
   */
  async execute(args, context) {
    throw new Error("未实现");
  },
};
