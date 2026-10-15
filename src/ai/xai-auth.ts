// xAI 订阅登录：OAuth 设备码流程（RFC 8628），做法参照 pi。
// 登录一次，把凭据存到 ~/.mini-harness/auth.json；之后每次请求前取 access token，快过期时用 refresh token 换新的。
// 拿到的 access token 当作 xAI API（https://api.x.ai/v1）的 key 用，接口和 OpenAI Chat Completions 兼容。
// 这里的请求只发给 auth.x.ai，不经过保存原始响应的 fetch，凭据不会写进 tmp/。

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const XAI_AUTH_BASE_URL = "https://auth.x.ai/oauth2";
/** xAI 的模型接口，和 OpenAI Chat Completions 兼容 */
export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
/** 凭据文件里存 xAI 登录的键 */
export const XAI_CREDENTIAL_KEY = "xai";
/** 提前这么久刷新，避免 token 在请求途中过期 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** 服务端没给 expires_in 时，按这么久算 */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
/** RFC 8628：服务端没给轮询间隔时用 5 秒；收到 slow_down 时加 5 秒 */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;

export interface XaiCredential {
  access: string;
  refresh: string;
  /** 到这个时间（毫秒时间戳）就该刷新了，已经减去 REFRESH_SKEW_MS */
  expires: number;
  /** 登录时用的 client id，刷新时用同一个 */
  clientId: string;
}

export interface XaiAuthOptions {
  /** 凭据文件的路径，比如 ~/.mini-harness/auth.json */
  file: string;
  /** 默认 XAI_AUTH_BASE_URL */
  authBaseUrl?: string;
  /** 测试时注入；不填用全局 fetch */
  fetch?: typeof fetch;
  /** 测试时注入；不填用 Date.now */
  now?: () => number;
}

export interface DeviceCodeInfo {
  userCode: string;
  /** 在浏览器里打开的地址；服务端给了带用户码的完整地址时用它 */
  verificationUri: string;
  expiresInSeconds: number;
}

export interface LoginOptions extends XaiAuthOptions {
  /** 登录用的 OAuth client id，需要是你有权使用的 */
  clientId: string;
  /** 拿到用户码后调用，由调用方显示给用户 */
  notify: (info: DeviceCodeInfo) => void;
  signal?: AbortSignal;
  /** 测试时注入，不真的等待；不填用 setTimeout */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type Json = Record<string, unknown>;

async function postForm(
  url: string,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Json }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal,
    redirect: "error",
  });
  let body: Json = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Json;
  } catch {
    if (response.ok) throw new Error(`xAI 登录接口返回的不是 JSON（HTTP ${response.status}）`);
  }
  return { ok: response.ok, status: response.status, body };
}

function failure(action: string, status: number, body: Json): Error {
  const detail = [body.error, body.error_description].filter((part) => typeof part === "string").join("：");
  return new Error(`xAI ${action}失败（HTTP ${status}）${detail ? `：${detail}` : ""}`);
}

function requiredString(body: Json, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new Error(`xAI 登录接口的返回缺少 ${field}`);
  return value;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 浏览器要打开的地址只接受 https，防止返回的地址被拿去打开别的东西 */
function httpsUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`xAI 返回的验证地址不是 https：${raw}`);
  return url.href;
}

function credentialFrom(body: Json, clientId: string, now: number, previousRefresh?: string): XaiCredential {
  const access = requiredString(body, "access_token");
  // 刷新时 refresh token 可能不轮换，这时沿用原来的
  const refresh = body.refresh_token === undefined && previousRefresh ? previousRefresh : requiredString(body, "refresh_token");
  const lifetime = positiveNumber(body.expires_in) ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  return { access, refresh, expires: now + lifetime * 1000 - REFRESH_SKEW_MS, clientId };
}

/** 读凭据文件；不存在时返回空对象 */
async function readStore(file: string): Promise<Json> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} 的格式不对`);
  return parsed as Json;
}

/** 读出 xAI 凭据；没有或格式不对时返回 undefined */
export async function readXaiCredential(file: string): Promise<XaiCredential | undefined> {
  const value = (await readStore(file))[XAI_CREDENTIAL_KEY];
  if (value === null || typeof value !== "object") return undefined;
  const { access, refresh, expires, clientId } = value as Json;
  if (typeof access !== "string" || typeof refresh !== "string" || typeof expires !== "number" || typeof clientId !== "string") {
    return undefined;
  }
  return { access, refresh, expires, clientId };
}

/**
 * 保存 xAI 凭据，文件里其他键原样保留。
 * 先写到同目录的临时文件再改名，写到一半中断也不会留下坏文件；文件权限是 0600，只有自己能读
 */
export async function saveXaiCredential(file: string, credential: XaiCredential): Promise<void> {
  const store = await readStore(file);
  store[XAI_CREDENTIAL_KEY] = credential;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("已取消登录"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("已取消登录"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 设备码登录：申请用户码 → notify 显示给用户 → 按间隔轮询 token 接口，直到用户在浏览器里授权 → 保存凭据。
 * - 轮询收到 authorization_pending 时继续等；收到 slow_down 时按返回的间隔，没有就加 5 秒
 * - 用户拒绝、设备码过期、超过有效期还没授权、其他错误时抛异常
 */
export async function loginXai(options: LoginOptions): Promise<XaiCredential> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const base = (options.authBaseUrl ?? XAI_AUTH_BASE_URL).replace(/\/+$/, "");

  const device = await postForm(
    `${base}/device/code`,
    { client_id: options.clientId, scope: XAI_SCOPE, referrer: "mini-harness" },
    fetchImpl,
    options.signal,
  );
  if (!device.ok) throw failure("申请设备码", device.status, device.body);
  const deviceCode = requiredString(device.body, "device_code");
  const expiresInSeconds = positiveNumber(device.body.expires_in);
  if (expiresInSeconds === undefined) throw new Error("xAI 登录接口的返回缺少 expires_in");
  const complete = device.body.verification_uri_complete;
  options.notify({
    userCode: requiredString(device.body, "user_code"),
    verificationUri: httpsUrl(typeof complete === "string" && complete !== "" ? complete : requiredString(device.body, "verification_uri")),
    expiresInSeconds,
  });

  const deadline = now() + expiresInSeconds * 1000;
  let interval = positiveNumber(device.body.interval) ?? DEFAULT_POLL_INTERVAL_SECONDS;
  while (now() < deadline) {
    await sleep(interval * 1000, options.signal);
    const response = await postForm(
      `${base}/token`,
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: options.clientId, device_code: deviceCode },
      fetchImpl,
      options.signal,
    );
    if (response.ok) {
      const credential = credentialFrom(response.body, options.clientId, now());
      await saveXaiCredential(options.file, credential);
      return credential;
    }
    const error = response.body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = positiveNumber(response.body.interval) ?? interval + SLOW_DOWN_INCREMENT_SECONDS;
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") throw new Error("在浏览器里拒绝了授权");
    if (error === "expired_token") throw new Error("设备码已过期，请重新登录");
    throw failure("登录", response.status, response.body);
  }
  throw new Error("等待授权超时，请重新登录");
}

/** 取 xAI 的 access token，供每次模型请求使用 */
export class XaiAuth {
  readonly #options: XaiAuthOptions;
  /** 正在进行的刷新；同时有多个请求要刷新时共用这一次 */
  #refreshing: Promise<string> | undefined;

  constructor(options: XaiAuthOptions) {
    this.#options = options;
  }

  /**
   * 返回可用的 access token。每次都重新读凭据文件，别的进程刷新或重新登录后马上能用上。
   * - 没有凭据时抛异常，提示先登录
   * - 没到刷新时间直接返回；到了，或者 force 为 true（比如收到 401）时，用 refresh token 换新的并保存
   * - 刷新失败时抛异常，提示重新登录
   */
  async token(options: { signal?: AbortSignal; force?: boolean } = {}): Promise<string> {
    const now = this.#options.now ?? Date.now;
    const credential = await readXaiCredential(this.#options.file);
    if (!credential) throw new Error(`还没有登录 xAI，先运行 pnpm login:grok（凭据文件 ${this.#options.file}）`);
    if (!options.force && now() < credential.expires) return credential.access;
    this.#refreshing ??= this.#refresh(credential, options.signal).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(credential: XaiCredential, signal?: AbortSignal): Promise<string> {
    const now = this.#options.now ?? Date.now;
    const base = (this.#options.authBaseUrl ?? XAI_AUTH_BASE_URL).replace(/\/+$/, "");
    const response = await postForm(
      `${base}/token`,
      { grant_type: "refresh_token", client_id: credential.clientId, refresh_token: credential.refresh },
      this.#options.fetch ?? globalThis.fetch,
      signal,
    );
    if (!response.ok) {
      throw new Error(`${failure("刷新登录", response.status, response.body).message}。请运行 pnpm login:grok 重新登录`);
    }
    const next = credentialFrom(response.body, credential.clientId, now(), credential.refresh);
    await saveXaiCredential(this.#options.file, next);
    return next.access;
  }
}
