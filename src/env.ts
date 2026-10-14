// 读取 mini-harness 根目录下的 .env，写入 process.env。
// 按本文件所在位置找 .env，所以在别的目录启动、或者 IDE 里没加任何参数，都能读到。

import { join } from "node:path";

export const PROJECT_ENV_FILE = join(import.meta.dirname, "..", ".env");

/** 文件不存在时什么都不做；已经存在的环境变量不会被 .env 里的值覆盖 */
export function loadProjectEnv(file = PROJECT_ENV_FILE): void {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}
