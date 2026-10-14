import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
    const { path: rawPath, content } = args;
    if (typeof rawPath !== "string" || rawPath === "") {
      throw new Error("path 必须是非空字符串");
    }
    if (typeof content !== "string") {
      throw new Error("content 必须是字符串");
    }

    const fullPath = resolve(context.cwd, rawPath);
    let created = true;
    try {
      await mkdir(dirname(fullPath), { recursive: true });
      try {
        // 先尝试独占创建，根据 EEXIST 区分新建和覆盖。
        await writeFile(fullPath, content, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err;
        await writeFile(fullPath, content, "utf8");
        created = false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`写入文件失败（${fullPath}）：${message}`);
    }

    return { content: `已${created ? "新建" : "覆盖"}文件 ${fullPath}，共 ${content.length} 个字符` };
  },
};
