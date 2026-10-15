// 用 xAI 订阅账号登录：走 OAuth 设备码流程，把凭据存到 ~/.mini-harness/auth.json，再列出能用的模型。
// 需要在 .env 里设置 GROK_OAUTH_CLIENT_ID。
//
// 用法：pnpm login:grok

import { homedir } from "node:os";
import { join } from "node:path";
import { loginXai, XAI_API_BASE_URL, XaiAuth } from "../src/ai/xai-auth.ts";
import { loadProjectEnv } from "../src/env.ts";

loadProjectEnv();

const clientId = process.env.GROK_OAUTH_CLIENT_ID;
if (!clientId) {
  console.error("缺少 GROK_OAUTH_CLIENT_ID：登录要用一个你有权使用的 xAI OAuth client id，写进 .env 后再运行");
  process.exit(1);
}

const file = join(homedir(), ".mini-harness", "auth.json");
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

try {
  await loginXai({
    file,
    clientId,
    signal: controller.signal,
    notify: ({ userCode, verificationUri, expiresInSeconds }) => {
      console.log(`在浏览器里打开 ${verificationUri}`);
      console.log(`确认验证码是 ${userCode}，${Math.round(expiresInSeconds / 60)} 分钟内有效。等待授权……`);
    },
  });
} catch (err) {
  console.error(`登录失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.log(`已登录，凭据保存在 ${file}`);

const token = await new XaiAuth({ file }).token();
const base = (process.env.GROK_BASE_URL || XAI_API_BASE_URL).replace(/\/+$/, "");
const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } });
if (!response.ok) {
  console.error(`获取模型列表失败（HTTP ${response.status}）：${await response.text()}`);
  process.exit(1);
}
const { data } = (await response.json()) as { data: { id: string }[] };
console.log(`能用的模型：${data.map((model) => model.id).join("、")}。选一个写进 .env 的 GROK_MODEL`);
