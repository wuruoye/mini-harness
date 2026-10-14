import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

  async execute(args, context) {
    const { path: rawPath } = args;
    // 空路径会被 resolve 解析为工作目录，需要在读取前拒绝。
    if (typeof rawPath !== "string" || rawPath === "") {
      throw new Error("path 必须是非空字符串");
    }

    const fullPath = resolve(context.cwd, rawPath);

    // 部分文件系统错误不含路径，补上路径方便定位。
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`读取文件失败（${fullPath}）：${message}`);
    }

    if (content.length > MAX_READ_CHARS) {
      content = content.slice(0, MAX_READ_CHARS) + `\n\n[内容已截断，仅显示前 ${MAX_READ_CHARS} 个字符，文件共 ${content.length} 个字符]`;
    }

    return { content };
  },
};
