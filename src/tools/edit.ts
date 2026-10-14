import type { Tool } from "../agent/types.ts";

export const editTool: Tool = {
  definition: {
    name: "edit",
    description:
      "修改已有文件：把文件里的 old_string 替换成 new_string。" +
      "old_string 必须和文件内容逐字一致，包括缩进和换行，并且在文件里只出现一次；" +
      "出现多次时，带上更多前后文让它唯一，或者设置 replace_all 替换全部。新建文件用 write_file。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        old_string: { type: "string", description: "要被替换的原文" },
        new_string: { type: "string", description: "替换后的内容" },
        replace_all: { type: "boolean", description: "替换所有出现的地方，默认 false" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },

  /**
   * - path、old_string、new_string 必须是字符串，path 和 old_string 不能为空；不符合时抛异常，信息里提到出错的参数名
   * - old_string 和 new_string 相同时抛异常，因为不会有任何改动
   * - 相对路径按 context.cwd 解析；文件不存在时抛异常，信息里带上路径
   * - 数一下 old_string 出现了几次：0 次时抛异常，信息里带上路径；
   *   多次且 replace_all 不为 true 时抛异常，信息里带上次数
   * - 按原文替换：new_string 里的 $&、$1 这类字符要原样写入，不能被当成替换模式
   * - 写回文件；content 说明改了哪个文件、替换了几处
   */
  async execute(args, context) {
    throw new Error("未实现");
  },
};
