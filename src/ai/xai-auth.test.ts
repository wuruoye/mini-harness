import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  loginXai,
  readXaiCredential,
  REFRESH_SKEW_MS,
  saveXaiCredential,
  XAI_AUTH_BASE_URL,
  XAI_SCOPE,
  XaiAuth,
  type DeviceCodeInfo,
  type XaiCredential,
} from "./xai-auth.ts";

async function authFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mini-harness-xai-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "sub", "auth.json");
}

interface Call {
  url: string;
  form: Record<string, string>;
}

/** 按顺序返回预先写好的响应，记下每次请求的地址和表单 */
function scriptedFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
    const next = responses.shift();
    if (!next) throw new Error(`没有准备第 ${calls.length} 个响应`);
    return next();
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEVICE = {
  device_code: "dev-1",
  user_code: "ABCD-EFGH",
  verification_uri: "https://accounts.x.ai/device",
  verification_uri_complete: "https://accounts.x.ai/device?code=ABCD-EFGH",
  expires_in: 600,
  interval: 1,
};
const TOKENS = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 };

describe("loginXai", () => {
  test("申请设备码，轮询到授权完成，保存凭据", async (t) => {
    const file = await authFile(t);
    const fetch = scriptedFetch([
      json(DEVICE),
      json({ error: "authorization_pending" }, 400),
      json({ error: "slow_down" }, 400),
      json(TOKENS),
    ]);
    const waits: number[] = [];
    const shown: DeviceCodeInfo[] = [];
    const credential = await loginXai({
      file,
      clientId: "client-1",
      fetch: fetch.fn,
      now: () => 1_000_000,
      sleep: async (ms) => void waits.push(ms),
      notify: (info) => shown.push(info),
    });

    assert.deepEqual(shown, [{ userCode: "ABCD-EFGH", verificationUri: DEVICE.verification_uri_complete, expiresInSeconds: 600 }]);
    assert.deepEqual(waits, [1000, 1000, 6000]);
    assert.equal(fetch.calls[0]?.url, `${XAI_AUTH_BASE_URL}/device/code`);
    assert.deepEqual(fetch.calls[0]?.form, { client_id: "client-1", scope: XAI_SCOPE, referrer: "mini-harness" });
    assert.deepEqual(fetch.calls[1]?.form, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "client-1",
      device_code: "dev-1",
    });
    const expected: XaiCredential = {
      access: "access-1",
      refresh: "refresh-1",
      expires: 1_000_000 + 3600 * 1000 - REFRESH_SKEW_MS,
      clientId: "client-1",
    };
    assert.deepEqual(credential, expected);
    assert.deepEqual(await readXaiCredential(file), expected);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  test("拒绝授权、设备码过期、等待超时都会报错", async (t) => {
    const file = await authFile(t);
    const base = { file, clientId: "c", sleep: async () => {}, notify: () => {} };
    await assert.rejects(
      loginXai({ ...base, fetch: scriptedFetch([json(DEVICE), json({ error: "access_denied" }, 400)]).fn }),
      /拒绝/,
    );
    await assert.rejects(
      loginXai({ ...base, fetch: scriptedFetch([json(DEVICE), json({ error: "expired_token" }, 400)]).fn }),
      /过期/,
    );
    let clock = 0;
    const pending = () => json({ error: "authorization_pending" }, 400)();
    await assert.rejects(
      loginXai({
        ...base,
        now: () => (clock += 200_000),
        fetch: scriptedFetch([json(DEVICE), pending, pending, pending, pending]).fn,
      }),
      /超时/,
    );
    assert.equal(await readXaiCredential(file), undefined);
  });

  test("申请设备码失败时带上状态码和错误；验证地址不是 https 时不接受", async (t) => {
    const file = await authFile(t);
    const base = { file, clientId: "c", sleep: async () => {}, notify: () => {} };
    await assert.rejects(
      loginXai({ ...base, fetch: scriptedFetch([json({ error: "invalid_client", error_description: "unknown client" }, 401)]).fn }),
      /401.*invalid_client.*unknown client/,
    );
    const insecure = { ...DEVICE, verification_uri_complete: undefined, verification_uri: "http://evil.example/device" };
    await assert.rejects(loginXai({ ...base, fetch: scriptedFetch([json(insecure)]).fn }), /https/);
  });
});

describe("凭据文件", () => {
  test("保存时保留文件里的其他内容；格式不对的凭据当作没有", async (t) => {
    const file = await authFile(t);
    const credential: XaiCredential = { access: "a", refresh: "r", expires: 1, clientId: "c" };
    await saveXaiCredential(file, credential);
    const store = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...store, other: { keep: true } }));
    await saveXaiCredential(file, { ...credential, access: "b" });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved.other, { keep: true });
    assert.equal(saved.xai.access, "b");

    await writeFile(file, JSON.stringify({ xai: { access: "only" } }));
    assert.equal(await readXaiCredential(file), undefined);
  });
});

describe("XaiAuth", () => {
  const credential: XaiCredential = { access: "access-1", refresh: "refresh-1", expires: 5000, clientId: "client-1" };

  test("还没登录时提示先登录", async (t) => {
    const auth = new XaiAuth({ file: await authFile(t), fetch: scriptedFetch([]).fn });
    await assert.rejects(auth.token(), /pnpm login:grok/);
  });

  test("没到刷新时间直接返回，不发请求", async (t) => {
    const file = await authFile(t);
    await saveXaiCredential(file, credential);
    const fetch = scriptedFetch([]);
    assert.equal(await new XaiAuth({ file, fetch: fetch.fn, now: () => 4999 }).token(), "access-1");
    assert.equal(fetch.calls.length, 0);
  });

  test("到了刷新时间用 refresh token 换新的并保存；没返回新的 refresh token 时沿用旧的", async (t) => {
    const file = await authFile(t);
    await saveXaiCredential(file, credential);
    const fetch = scriptedFetch([json({ access_token: "access-2", expires_in: 3600 })]);
    const auth = new XaiAuth({ file, fetch: fetch.fn, now: () => 5000 });
    assert.equal(await auth.token(), "access-2");
    assert.deepEqual(fetch.calls[0]?.form, { grant_type: "refresh_token", client_id: "client-1", refresh_token: "refresh-1" });
    assert.deepEqual(await readXaiCredential(file), {
      access: "access-2",
      refresh: "refresh-1",
      expires: 5000 + 3600 * 1000 - REFRESH_SKEW_MS,
      clientId: "client-1",
    });
  });

  test("force 时没到时间也刷新；同时多个请求只刷新一次", async (t) => {
    const file = await authFile(t);
    await saveXaiCredential(file, credential);
    const fetch = scriptedFetch([json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 })]);
    const auth = new XaiAuth({ file, fetch: fetch.fn, now: () => 0 });
    const tokens = await Promise.all([auth.token({ force: true }), auth.token({ force: true })]);
    assert.deepEqual(tokens, ["access-2", "access-2"]);
    assert.equal(fetch.calls.length, 1);
    assert.equal((await readXaiCredential(file))?.refresh, "refresh-2");
  });

  test("刷新失败时提示重新登录，凭据不变", async (t) => {
    const file = await authFile(t);
    await saveXaiCredential(file, credential);
    const fetch = scriptedFetch([json({ error: "invalid_grant" }, 400)]);
    await assert.rejects(new XaiAuth({ file, fetch: fetch.fn, now: () => 9999 }).token(), /invalid_grant.*重新登录/);
    assert.deepEqual(await readXaiCredential(file), credential);
  });
});
