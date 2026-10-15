import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface GrokAuthOptions {
  /** Grok Build 的登录文件，默认 ~/.grok/auth.json */
  authPath?: string;
  /** 文件里有多个 xAI OAuth 登录时，指定要用的条目 */
  authScope?: string;
  /** Grok CLI 的程序路径，默认查找本机安装 */
  grokBin?: string;
}

interface Credential {
  key: string;
  expiresAt: number;
  refreshable: boolean;
  clientId?: string;
}

const REFRESH_BUFFER = 5 * 60 * 1000;
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

/** 停止等待时让 CLI 完成刷新，避免在服务端轮换 token 后中断本地保存。 */
function waitFor<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/**
 * 复用 Grok Build 的 OAuth 登录。每次请求重读文件，以便识别重新登录和其他进程的刷新。
 * 刷新交给 `grok models`，由 CLI 处理 OAuth、文件锁和原子保存，避免同时花掉同一份 refresh token。
 * 只接受 xAI 订阅登录，不从文件或环境变量回退到按量付费的 API key。
 */
export class GrokAuth {
  #options: GrokAuthOptions;
  #path: string;
  #bin: string;
  #version?: Promise<string>;
  #refresh?: Promise<void>;

  constructor(options: GrokAuthOptions = {}) {
    this.#options = options;
    this.#path = resolve((options.authPath || join(homedir(), ".grok", "auth.json")).replace(/^~(?=$|\/)/, homedir()));
    const installed = join(homedir(), ".grok", "bin", "grok");
    this.#bin = options.grokBin?.replace(/^~(?=$|\/)/, homedir()) || (existsSync(installed) ? installed : "grok");
  }

  async #read(): Promise<Credential> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch {
      throw new Error(`无法读取 Grok 登录文件 ${this.#path}。请先运行 grok login`);
    }

    let store: unknown;
    try {
      store = JSON.parse(contents);
    } catch {
      // JSON 解析错误可能引用文件里的 token，不把原始错误输出到终端。
      throw new Error(`Grok 登录文件 ${this.#path} 不是有效的 JSON。请重新运行 grok login`);
    }
    if (!store || typeof store !== "object" || Array.isArray(store)) {
      throw new Error("Grok 登录文件格式无效。请重新运行 grok login");
    }

    const entries = Object.entries(store).filter(([scope, value]) => {
      if (this.#options.authScope && scope !== this.#options.authScope) return false;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const entry = value as Record<string, unknown>;
      return scope.startsWith("https://auth.x.ai::") && entry.oidc_issuer === "https://auth.x.ai"
        && entry.auth_mode === "oidc" && typeof entry.key === "string" && entry.key !== "";
    });
    if (entries.length === 0) {
      throw new Error("没有找到 Grok Build 的 xAI OAuth 登录。请运行 grok login 后重试");
    }
    if (entries.length > 1) {
      throw new Error("Grok 登录文件里有多个 xAI OAuth 登录，请用 GROK_AUTH_SCOPE 指定条目");
    }

    const entry = entries[0]![1] as Record<string, unknown>;
    const expiresAt = typeof entry.expires_at === "string"
      ? Date.parse(entry.expires_at)
      : typeof entry.create_time === "string" ? Date.parse(entry.create_time) + TOKEN_TTL : NaN;
    if (!Number.isFinite(expiresAt)) throw new Error("Grok 登录缺少有效的过期时间。请重新运行 grok login");
    return {
      key: entry.key as string,
      expiresAt,
      refreshable: typeof entry.refresh_token === "string" && entry.refresh_token !== "",
      clientId: typeof entry.oidc_client_id === "string" ? entry.oidc_client_id : undefined,
    };
  }

  #runCli(args: string[], refreshBuffer?: number, clientId?: string): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, GROK_AUTH_PATH: this.#path };
    // models 只用于刷新订阅登录，不能被进程里的其他凭据切到 API key。
    delete env.XAI_API_KEY;
    delete env.GROK_API_KEY;
    delete env.GROK_AUTH;
    if (refreshBuffer !== undefined) env.GROK_AUTH_EARLY_INVALIDATION_SECS = String(refreshBuffer);
    if (clientId) {
      env.GROK_OAUTH2_ISSUER = "https://auth.x.ai";
      env.GROK_OAUTH2_CLIENT_ID = clientId;
    }
    return new Promise((resolve, reject) => {
      const child = execFile(this.#bin, args, { env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          // CLI 的输出可能带登录信息，只报告操作与退出状态。
          const code = error.code === "ENOENT" ? "找不到程序" : String(error.code ?? error.signal ?? "执行失败");
          reject(new Error(`Grok CLI ${args.join(" ")} 失败（${code}）。请检查 GROK_BIN，并运行 grok login 后重试`));
        } else {
          resolve(stdout);
        }
      });
      child.stdin?.end();
    });
  }

  #clientVersion(): Promise<string> {
    this.#version ??= this.#runCli(["--version"]).then((output) => {
      const version = /^grok\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/m.exec(output)?.[1];
      if (!version) throw new Error("无法识别 Grok CLI 的版本，请运行 grok update 后重试");
      return version;
    }).catch((error: unknown) => {
      this.#version = undefined;
      throw error;
    });
    return this.#version;
  }

  async #refreshCredential(previous: Credential): Promise<void> {
    const current = await this.#read();
    if (current.key !== previous.key && current.expiresAt > Date.now()) return;
    if (!current.refreshable || !current.clientId) throw new Error("Grok 登录无法自动刷新，请重新运行 grok login");
    // 同样处理服务端提前拒绝的 token，让 CLI 在读取模型列表前刷新它。
    const buffer = Math.max(300, Math.ceil((current.expiresAt - Date.now()) / 1000) + 60);
    await this.#runCli(["models"], buffer, current.clientId);
    const refreshed = await this.#read();
    if ((refreshed.key === current.key && refreshed.expiresAt <= current.expiresAt) || refreshed.expiresAt <= Date.now()) {
      throw new Error("Grok CLI 未能刷新订阅登录，请重新运行 grok login 后重试");
    }
  }

  /** rejectedKey 表示服务端返回了 401；已被其他进程替换的 token 直接重读，其他情况刷新一次。 */
  async credentials(signal?: AbortSignal, rejectedKey?: string): Promise<{ key: string; clientVersion: string }> {
    signal?.throwIfAborted();
    const clientVersion = await waitFor(this.#clientVersion(), signal);
    let current = await this.#read();
    if (current.expiresAt <= Date.now() + REFRESH_BUFFER || current.key === rejectedKey) {
      this.#refresh ??= this.#refreshCredential(current).finally(() => { this.#refresh = undefined; });
      await waitFor(this.#refresh, signal);
      current = await this.#read();
    }
    signal?.throwIfAborted();
    return { key: current.key, clientVersion };
  }
}
