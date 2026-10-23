import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { subscriptionKey } from "../src/subscriptions.js";

class MemoryBucket {
  constructor() { this.items = new Map(); }

  async put(key, value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.items.set(key, { bytes, uploaded: new Date() });
  }

  async get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    return {
      body: new Blob([item.bytes]).stream(),
      size: item.bytes.length,
      httpEtag: '"test-etag"',
      json: async () => JSON.parse(new TextDecoder().decode(item.bytes))
    };
  }

  async head(key) {
    const item = this.items.get(key);
    return item ? { size: item.bytes.length, httpEtag: '"test-etag"' } : null;
  }

  async delete(key) { this.items.delete(key); }

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const keys = [...this.items.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + limit);
    return {
      objects: slice.map(key => ({ key, size: this.items.get(key).bytes.length, uploaded: this.items.get(key).uploaded })),
      truncated: start + limit < keys.length,
      cursor: start + limit < keys.length ? String(start + limit) : undefined
    };
  }
}

const origin = "https://updates.example.test";
const zip = "Noetix-Motion-Editor-0.1.45-win64-cp313-pyd.zip";

function fixture() {
  return { EXTENSIONS: new MemoryBucket(), ADMIN_TOKEN: "administrator-long-random-secret" };
}

async function send(env, path, options = {}) {
  return worker.fetch(new Request(`${origin}${path}`, options), env);
}

function postForm(fields, cookie = "") {
  return {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: new URLSearchParams(fields).toString()
  };
}

async function login(env) {
  const response = await send(env, "/admin/login", postForm({ secret: env.ADMIN_TOKEN }));
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function csrf(env, cookie) {
  const html = await (await send(env, "/admin", { headers: { Cookie: cookie } })).text();
  const match = html.match(/name="csrf" value="([a-f0-9]{64})"/);
  assert.ok(match);
  return match[1];
}

async function createToken(env, cookie) {
  const response = await send(env, "/admin/tokens", postForm({ csrf: await csrf(env, cookie), label: "测试用户", days: "90" }, cookie));
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = html.match(/nx_[A-Za-z0-9_-]{40,100}/);
  assert.ok(match);
  return match[0];
}

test("下载必须携带有效令牌，且只能访问索引和安装包", async () => {
  const env = fixture();
  const indexJson = JSON.stringify({ version: "v1", data: [{ archive_url: `./${zip}` }] });
  await env.EXTENSIONS.put("index.json", indexJson);
  await env.EXTENSIONS.put(zip, "ZIP_BYTES");
  await env.EXTENSIONS.put("Other-Plugin-1.0.zip", "OTHER_ZIP");
  const cookie = await login(env);
  const token = await createToken(env, cookie);
  assert.equal((await send(env, "/index.json")).status, 401);
  assert.equal((await send(env, "/index.json", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const auth = { Authorization: `Bearer ${token}` };
  const index = await send(env, "/index.json", { headers: auth });
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(index.headers.get("cache-control"), "private, no-store");
  assert.equal(await index.text(), indexJson);
  const download = await send(env, `/${zip}`, { headers: auth });
  assert.equal(await download.text(), "ZIP_BYTES");
  const head = await send(env, `/${zip}`, { method: "HEAD", headers: auth });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "9");
  assert.equal(await head.text(), "");
  assert.equal((await send(env, "/auth/tokens/secret.json", { headers: auth })).status, 404);
  assert.equal((await send(env, "/other.zip", { headers: auth })).status, 404);
  assert.equal((await send(env, "/Other-Plugin-1.0.zip", { headers: auth })).status, 404);
  assert.equal((await send(env, "/index.json", { method: "POST", headers: auth })).status, 405);
});

test("新增插件只要写入索引即可下载，无需修改 Worker", async () => {
  const env = fixture();
  const otherZip = "Other-Plugin-1.0.zip";
  await env.EXTENSIONS.put("index.json", JSON.stringify({ version: "v1", data: [{ archive_url: `./${otherZip}` }] }));
  await env.EXTENSIONS.put(otherZip, "OTHER_ZIP");
  const token = await createToken(env, await login(env));
  const response = await send(env, `/${otherZip}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OTHER_ZIP");
});

test("网页只保存令牌摘要；撤销后立即拒绝下载", async () => {
  const env = fixture();
  await env.EXTENSIONS.put("index.json", "{}");
  const cookie = await login(env);
  const token = await createToken(env, cookie);
  const keys = [...env.EXTENSIONS.items.keys()];
  const tokenKey = keys.find(key => key.startsWith("auth/tokens/"));
  assert.match(tokenKey, /^auth\/tokens\/[a-f0-9]{64}\.json$/);
  assert.equal(JSON.stringify([...env.EXTENSIONS.items]).includes(token), false);
  assert.equal((await send(env, "/index.json", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await send(env, "/auth/check", { headers: { Authorization: `Bearer ${token}` } })).status, 204);
  const hash = tokenKey.slice("auth/tokens/".length, -5);
  const response = await send(env, "/admin/tokens/revoke", postForm({ csrf: await csrf(env, cookie), hash }, cookie));
  assert.equal(response.status, 200);
  assert.equal((await send(env, "/index.json", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await send(env, "/auth/check", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test("管理页面有会话、来源和 CSRF 防护", async () => {
  const env = fixture();
  assert.equal((await send(env, "/admin/tokens", postForm({ label: "x", days: "90" }))).status, 401);
  assert.equal((await send(env, "/admin/login", postForm({ secret: "wrong" }))).status, 401);
  const cookie = await login(env);
  assert.equal((await send(env, "/admin", { headers: { Cookie: cookie } })).status, 200);
  const dashboardHtml = await (await send(env, "/admin", { headers: { Cookie: cookie } })).text();
  assert.ok(dashboardHtml.includes('class="data-table token-table"'));
  assert.ok(dashboardHtml.includes('.token-table{min-width:790px}'));
  const noCsrf = await send(env, "/admin/tokens", postForm({ label: "x", days: "90" }, cookie));
  assert.equal(noCsrf.status, 403);
  const badOrigin = await send(env, "/admin/tokens", {
    ...postForm({ csrf: await csrf(env, cookie), label: "x", days: "90" }, cookie),
    headers: { ...postForm({}, cookie).headers, Origin: "https://attacker.example" }
  });
  assert.equal(badOrigin.status, 403);
  const logout = await send(env, "/admin/logout", postForm({ csrf: await csrf(env, cookie) }, cookie));
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});

test("管理后台展示飞书令牌持有人的订阅状态，未操作默认已订阅", async () => {
  const env = { ...fixture(), FEISHU_APP_ID: "cli_test" };
  const openId = "ou_employee12345";
  await env.EXTENSIONS.put(`auth/tokens/${"a".repeat(64)}.json`, JSON.stringify({
    source: "feishu", label: "测试员工", feishuOpenId: openId,
    expiresAt: new Date(Date.now() + 86400000).toISOString()
  }));
  const cookie = await login(env);
  const before = await (await send(env, "/admin", { headers: { Cookie: cookie } })).text();
  assert.match(before, /测试员工[\s\S]*已订阅/);
  await env.EXTENSIONS.put(await subscriptionKey(env.FEISHU_APP_ID, openId), JSON.stringify({ subscribed: false }));
  const after = await (await send(env, "/admin", { headers: { Cookie: cookie } })).text();
  assert.match(after, /测试员工[\s\S]*已取消/);
});

test("正常浏览器未发送 Origin 时仍能登录和提交，跨站来源继续被拒绝", async () => {
  const env = fixture();
  const loginForm = postForm({ secret: env.ADMIN_TOKEN });
  delete loginForm.headers.Origin;
  const loginResponse = await send(env, "/admin/login", loginForm);
  assert.equal(loginResponse.status, 303);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const tokenForm = postForm({ csrf: await csrf(env, cookie), label: "无 Origin 浏览器", days: "30" }, cookie);
  delete tokenForm.headers.Origin;
  assert.equal((await send(env, "/admin/tokens", tokenForm)).status, 200);
  const nullOrigin = postForm({ csrf: await csrf(env, cookie), label: "null Origin", days: "30" }, cookie);
  nullOrigin.headers.Origin = "null";
  assert.equal((await send(env, "/admin/tokens", nullOrigin)).status, 200);
  const crossSite = postForm({ csrf: await csrf(env, cookie), label: "跨站", days: "30" }, cookie);
  crossSite.headers.Origin = "https://attacker.example";
  assert.equal((await send(env, "/admin/tokens", crossSite)).status, 403);
  const badReferer = postForm({ csrf: await csrf(env, cookie), label: "跨站来源页", days: "30" }, cookie);
  delete badReferer.headers.Origin;
  badReferer.headers.Referer = "https://attacker.example/page";
  assert.equal((await send(env, "/admin/tokens", badReferer)).status, 403);
});

test("到期的令牌拒绝下载", async () => {
  const env = fixture();
  const token = "nx_" + "a".repeat(43);
  const data = new TextEncoder().encode(token);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  await env.EXTENSIONS.put(`auth/tokens/${hash}.json`, JSON.stringify({ expiresAt: "2000-01-01T00:00:00Z" }));
  await env.EXTENSIONS.put("index.json", "{}");
  assert.equal((await send(env, "/index.json", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test("管理页转义用户备注，伪造会话无效", async () => {
  const env = fixture();
  const cookie = await login(env);
  const htmlResponse = await send(env, "/admin/tokens", postForm({
    csrf: await csrf(env, cookie), label: "<script>alert(1)</script>", days: "0"
  }, cookie));
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
  const forged = cookie.replace(/.$/, cookie.endsWith("a") ? "b" : "a");
  const response = await send(env, "/admin", { headers: { Cookie: forged } });
  assert.ok((await response.text()).includes("欢迎回来"));
});

test("公开首页展示产品介绍和 R2 中最新版本说明，不暴露后台数据", async () => {
  const env = fixture();
  await env.EXTENSIONS.put("latest.json", JSON.stringify({
    version: "0.1.45", date: "2026-10-21",
    highlights: ["锁脚与锁手平滑过渡", "手部触地防内翻"]
  }));
  const response = await send(env, "/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("Noetix Motion Editor"));
  assert.ok(html.includes("v0.1.45"));
  assert.ok(html.includes("锁脚与锁手平滑过渡"));
  assert.ok(html.includes("/index.json"));
  assert.ok(html.includes("https://blender.3ddd.site/index.json"));
  assert.ok(!html.includes("momei-blender-extension-hub.amor.workers.dev"));
  assert.ok(!html.includes('href="/admin"'));
  assert.ok(!html.includes(env.ADMIN_TOKEN));
  assert.ok(!html.includes("auth/tokens"));
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("首页对更新说明转义；元数据缺失时仍正常显示", async () => {
  const env = fixture();
  await env.EXTENSIONS.put("latest.json", JSON.stringify({
    version: "0.1.46", date: "2026-10-22",
    highlights: ["<script>alert(1)</script>"]
  }));
  const html = await (await send(env, "/")).text();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
  await env.EXTENSIONS.delete("latest.json");
  assert.ok((await send(env, "/")).status === 200);
});

test("阿里云国内网关就绪时保留原地址和令牌，跳转到能接收 Bearer 的网关", async () => {
  const env = { ...fixture(), ALIYUN_GATEWAY_BASE_URL: "https://gateway.example.test" };
  await env.EXTENSIONS.put("index.json", JSON.stringify({ data: [{ archive_url: `./${zip}` }] }));
  await env.EXTENSIONS.put(zip, "R2_BACKUP");
  const token = await createToken(env, await login(env));
  const auth = { Authorization: `Bearer ${token}` };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => { requests.push(url); return new Response("ok"); };
  try {
    assert.equal((await send(env, "/index.json")).status, 401);
    assert.equal(requests.length, 0);
    assert.equal((await send(env, "/auth/check")).status, 401);
    assert.equal((await send(env, "/auth/check", { headers: auth })).status, 204);
    const index = await send(env, "/index.json", { headers: auth });
    assert.equal(index.status, 307);
    assert.equal(index.headers.get("Location"), "https://gateway.example.test/index.json");
    const download = await send(env, `/${zip}`, { headers: auth });
    assert.equal(download.status, 307);
    assert.equal(download.headers.get("Location"), `https://gateway.example.test/${zip}`);
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    const head = await send(env, `/${zip}`, { method: "HEAD", headers: auth });
    assert.equal(head.status, 307);
    assert.equal((await send(env, "/not-listed.zip", { headers: auth })).status, 307);
    assert.ok(requests.every(url => url === "https://gateway.example.test/health"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("阿里云国内网关不可用时 R2 更新通道继续可用", async () => {
  const env = { ...fixture(), ALIYUN_GATEWAY_BASE_URL: "https://gateway.example.test" };
  await env.EXTENSIONS.put("index.json", JSON.stringify({ data: [{ archive_url: `./${zip}` }] }));
  await env.EXTENSIONS.put(zip, "R2_BACKUP");
  const token = await createToken(env, await login(env));
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => { throw new Error("simulated OSS outage"); };
  console.warn = () => {};
  try {
    const response = await send(env, `/${zip}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "R2_BACKUP");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});



