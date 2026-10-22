import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { subscriptionStatus } from "../src/subscriptions.js";

const origin = "https://updates.example.test";
const env = {
  FEISHU_APP_ID: "cli_test_app",
  FEISHU_VERIFY_TOKEN: "verify-test-value",
  FEISHU_ENCRYPT_KEY: "encrypt-test-value"
};
const encoder = new TextEncoder();

async function signedEvent(event, options = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(env.FEISHU_ENCRYPT_KEY));
  const key = await crypto.subtle.importKey("raw", digest, "AES-CBC", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, encoder.encode(`random-prefix${JSON.stringify(event)}`));
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), iv.length);
  const body = JSON.stringify({ encrypt: btoa(String.fromCharCode(...bytes)) });
  const timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = "test-nonce";
  const signatureBytes = await crypto.subtle.digest("SHA-256", encoder.encode(`${timestamp}${nonce}${env.FEISHU_ENCRYPT_KEY}${body}`));
  const signature = [...new Uint8Array(signatureBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const headers = {
    "Content-Type": "application/json"
  };
  if (!options.unsigned) Object.assign(headers, {
    "X-Lark-Request-Timestamp": timestamp,
    "X-Lark-Request-Nonce": nonce,
    "X-Lark-Signature": options.signature || signature
  });
  return new Request(`${origin}/feishu/events`, {
    method: "POST",
    headers,
    body
  });
}

test("飞书加密地址校验在验签和解密后返回 challenge", async () => {
  const request = await signedEvent({ type: "url_verification", token: env.FEISHU_VERIFY_TOKEN, challenge: "test-challenge" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: "test-challenge" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("首次地址验证允许无签名的明文和加密 challenge，但必须核对 token", async () => {
  const challenge = { type: "url_verification", token: env.FEISHU_VERIFY_TOKEN, challenge: "first-check" };
  const plain = new Request(`${origin}/feishu/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(challenge)
  });
  const plainResponse = await worker.fetch(plain, env);
  assert.equal(plainResponse.status, 200);
  assert.deepEqual(await plainResponse.json(), { challenge: "first-check" });
  const encryptedResponse = await worker.fetch(await signedEvent(challenge, { unsigned: true }), env);
  assert.equal(encryptedResponse.status, 200);
  assert.deepEqual(await encryptedResponse.json(), { challenge: "first-check" });
  assert.equal((await worker.fetch(await signedEvent({ ...challenge, token: "wrong" }, { unsigned: true }), env)).status, 403);
});

test("飞书回调拒绝伪造签名、过期请求和错误 token", async () => {
  const challenge = { type: "url_verification", token: env.FEISHU_VERIFY_TOKEN, challenge: "abc" };
  assert.equal((await worker.fetch(await signedEvent(challenge, { signature: "0".repeat(64) }), env)).status, 403);
  assert.equal((await worker.fetch(await signedEvent(challenge, { timestamp: String(Math.floor(Date.now() / 1000) - 600) }), env)).status, 403);
  assert.equal((await worker.fetch(await signedEvent({ ...challenge, token: "wrong" }), env)).status, 403);
});

test("未配置密钥或令牌下发条件不足时明确拒绝", async () => {
  const challenge = { type: "url_verification", token: env.FEISHU_VERIFY_TOKEN, challenge: "abc" };
  assert.equal((await worker.fetch(await signedEvent(challenge), {}, {})).status, 503);
  const message = messageEvent();
  assert.equal((await worker.fetch(await signedEvent(message), env)).status, 503);
  assert.equal((await worker.fetch(await signedEvent(message, { unsigned: true }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(`${origin}/feishu/events`), env)).status, 405);
});

class MemoryBucket {
  constructor() { this.items = new Map(); this.versions = new Map(); }
  async get(key) {
    const value = this.items.get(key);
    return value ? { etag: String(this.versions.get(key)), json: async () => JSON.parse(value) } : null;
  }
  async put(key, value, options = {}) {
    if (options.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && this.items.has(key)) return null;
    if (options.onlyIf?.etagMatches && String(this.versions.get(key)) !== options.onlyIf.etagMatches) return null;
    const version = (this.versions.get(key) || 0) + 1;
    this.items.set(key, value);
    this.versions.set(key, version);
    return { etag: String(version) };
  }
  async list({ prefix = "" } = {}) {
    return { objects: [...this.items.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false };
  }
  async delete(key) { this.items.delete(key); this.versions.delete(key); }
}

function messageEvent({ eventId = "event_12345678", chatType = "p2p", text = "领取令牌 张三", senderType = "user" } = {}) {
  return {
    schema: "2.0",
    header: { token: env.FEISHU_VERIFY_TOKEN, app_id: env.FEISHU_APP_ID, tenant_key: "tenant_test", event_id: eventId, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_type: senderType, sender_id: { open_id: "ou_employee12345" } },
      message: { chat_type: chatType, message_type: "text", content: JSON.stringify({ text }) }
    }
  };
}

function menuEvent({ eventId = "menu_event_12345678", eventKey = "request_update_token" } = {}) {
  return {
    schema: "2.0",
    header: { token: env.FEISHU_VERIFY_TOKEN, app_id: env.FEISHU_APP_ID, tenant_key: "tenant_test", event_id: eventId, event_type: "application.bot.menu_v6" },
    event: { event_key: eventKey, operator: { operator_id: { open_id: "ou_employee12345" } } }
  };
}

function tokenEnv() {
  return { ...env, ADMIN_TOKEN: "admin-secret-for-token-derivation", FEISHU_APP_SECRET: "feishu-app-secret", EXTENSIONS: new MemoryBucket() };
}

async function runEvent(event, configuredEnv) {
  const pending = [];
  const response = await worker.fetch(await signedEvent(event), configuredEnv, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  return response;
}

test("员工私聊领令牌：记录申请人、飞书身份及申请时间，令牌只出现在私信", async () => {
  const configuredEnv = tokenEnv();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "feishu-access-token" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "张三" } } });
    return Response.json({ code: 0 });
  };
  try {
    const response = await runEvent(messageEvent(), configuredEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 0 });
    const [key, rawRecord] = [...configuredEnv.EXTENSIONS.items].find(([itemKey]) => itemKey.startsWith("auth/tokens/"));
    assert.match(key, /^auth\/tokens\/[a-f0-9]{64}\.json$/);
    const record = JSON.parse(rawRecord);
    assert.equal(record.label, "张三");
    assert.equal(record.applicantName, "张三");
    assert.equal(record.feishuOpenId, "ou_employee12345");
    assert.equal(record.feishuTenantKey, "tenant_test");
    assert.equal(record.source, "feishu");
    assert.ok(Date.parse(record.requestedAt));
    assert.ok(Date.parse(record.expiresAt) > Date.now());
    const sent = calls.find(call => call.url.includes("/im/v1/messages"));
    assert.equal(sent.body.receive_id, "ou_employee12345");
    assert.match(JSON.parse(sent.body.content).text, /nx_[A-Za-z0-9_-]{40,100}/);
    assert.ok(!rawRecord.includes("nx_"));
    assert.equal((await worker.fetch(await signedEvent(messageEvent({ chatType: "group" })), configuredEnv)).status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("文字申请也以飞书通讯录姓名和账号 ID 为准", async () => {
  const configuredEnv = tokenEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "真实姓名" } } });
    return Response.json({ code: 0 });
  };
  try {
    await runEvent(messageEvent({ text: "领取令牌 随便填" }), configuredEnv);
    const raw = [...configuredEnv.EXTENSIONS.items].find(([key]) => key.startsWith("auth/tokens/"))?.[1];
    assert.equal(JSON.parse(raw).applicantName, "真实姓名");
    assert.equal(JSON.parse(raw).feishuOpenId, "ou_employee12345");
  } finally { globalThis.fetch = originalFetch; }
});

test("订阅菜单文字只改变本人状态；其它聊天内容不自动回复", async () => {
  const configuredEnv = tokenEnv();
  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    sentTexts.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    assert.equal(await subscriptionStatus(configuredEnv.EXTENSIONS, configuredEnv.FEISHU_APP_ID, "ou_employee12345"), true);
    assert.deepEqual(await (await runEvent(messageEvent({ text: "你好" }), configuredEnv)).json(), { code: 0 });
    assert.equal(sentTexts.length, 0);
    assert.equal(configuredEnv.EXTENSIONS.items.size, 0);

    await runEvent(messageEvent({ text: "取消更新提醒", eventId: "event_unsubscribe123" }), configuredEnv);
    assert.equal(await subscriptionStatus(configuredEnv.EXTENSIONS, configuredEnv.FEISHU_APP_ID, "ou_employee12345"), false);
    assert.match(sentTexts.at(-1), /已取消更新提醒/);
    await runEvent(messageEvent({ text: "取消更新提醒", eventId: "event_unsubscribe123" }), configuredEnv);
    assert.equal(sentTexts.length, 1);

    await runEvent(messageEvent({ text: "订阅更新提醒", eventId: "event_subscribe123" }), configuredEnv);
    assert.equal(await subscriptionStatus(configuredEnv.EXTENSIONS, configuredEnv.FEISHU_APP_ID, "ou_employee12345"), true);
    assert.match(sentTexts.at(-1), /已订阅更新提醒/);
    await runEvent(messageEvent({ text: "取消更新提醒", eventId: "event_unsubscribe123" }), configuredEnv);
    assert.equal(await subscriptionStatus(configuredEnv.EXTENSIONS, configuredEnv.FEISHU_APP_ID, "ou_employee12345"), true);
    assert.equal(sentTexts.length, 2);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("订阅事件 ID 菜单也能更新状态", async () => {
  const configuredEnv = tokenEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => Response.json(String(url).includes("/oauth/") ? { code: 0, access_token: "access" } : { code: 0 });
  try {
    await runEvent(menuEvent({ eventKey: "unsubscribe_updates", eventId: "menu_unsubscribe123" }), configuredEnv);
    assert.equal(await subscriptionStatus(configuredEnv.EXTENSIONS, configuredEnv.FEISHU_APP_ID, "ou_employee12345"), false);
    await runEvent(menuEvent({ eventKey: "subscribe_updates", eventId: "menu_subscribe123" }), configuredEnv);
    assert.equal(await subscriptionStatus(configuredEnv.EXTENSIONS, configuredEnv.FEISHU_APP_ID, "ou_employee12345"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("飞书事件重试复用同一令牌；发送失败不留下未交付的新令牌", async () => {
  const configuredEnv = tokenEnv();
  const issued = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "张三" } } });
    issued.push(JSON.parse(JSON.parse(options.body).content).text.match(/nx_[A-Za-z0-9_-]+/)?.[0]);
    return Response.json({ code: 0 });
  };
  try {
    await runEvent(messageEvent(), configuredEnv);
    await runEvent(messageEvent(), configuredEnv);
    assert.equal(issued[0], issued[1]);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
    globalThis.fetch = async url => Response.json(String(url).includes("/oauth/") ? { code: 0, access_token: "access" } :
      String(url).includes("/contact/v3/users/") ? { code: 0, data: { user: { name: "张三" } } } : { code: 123 });
    await runEvent(messageEvent({ eventId: "event_87654321" }), configuredEnv);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("点击指定菜单：用飞书账号查询真实姓名并只私聊发放", async () => {
  const configuredEnv = tokenEnv();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "邓志美", status: { is_activated: true } } } });
    return Response.json({ code: 0 });
  };
  try {
    assert.deepEqual(await (await runEvent(menuEvent(), configuredEnv)).json(), { code: 0 });
    const [key, rawRecord] = [...configuredEnv.EXTENSIONS.items].find(([itemKey]) => itemKey.startsWith("auth/tokens/"));
    const record = JSON.parse(rawRecord);
    assert.match(key, /^auth\/tokens\/[a-f0-9]{64}\.json$/);
    assert.equal(record.applicantName, "邓志美");
    assert.equal(record.feishuOpenId, "ou_employee12345");
    assert.equal(record.requestChannel, "menu");
    assert.ok(Date.parse(record.requestedAt));
    assert.ok(calls.some(call => call.url.includes("/contact/v3/users/ou_employee12345?user_id_type=open_id")));
    const sent = calls.find(call => call.url.includes("/im/v1/messages"));
    assert.equal(JSON.parse(sent.options.body).receive_id, "ou_employee12345");
    assert.match(JSON.parse(JSON.parse(sent.options.body).content).text, /nx_[A-Za-z0-9_-]{40,100}/);
    assert.equal((await worker.fetch(await signedEvent(menuEvent({ eventKey: "other_menu" })), configuredEnv)).status, 503);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("通讯录权限不足时不发令牌，并向申请者说明原因", async () => {
  const configuredEnv = tokenEnv();
  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 99991672 });
    sentTexts.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    await runEvent(menuEvent(), configuredEnv);
    assert.equal(configuredEnv.EXTENSIONS.items.size, 0);
    assert.match(sentTexts[0], /获取用户基本信息/);
    assert.ok(!sentTexts[0].includes("nx_"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("同一飞书账号重复点击或发送消息，只保留一个有效令牌", async () => {
  const configuredEnv = tokenEnv();
  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "张三" } } });
    sentTexts.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    await runEvent(messageEvent(), configuredEnv);
    await runEvent(menuEvent(), configuredEnv);
    await runEvent(messageEvent({ eventId: "event_second123" }), configuredEnv);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
    assert.equal(sentTexts.filter(text => text.includes("nx_")).length, 1);
    assert.equal(sentTexts.filter(text => text.includes("不能重复申请")).length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("并发申请只有一个请求能占用飞书账号", async () => {
  const configuredEnv = tokenEnv();
  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "张三" } } });
    sentTexts.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    await Promise.all([
      runEvent(messageEvent({ eventId: "event_parallel1" }), configuredEnv),
      runEvent(messageEvent({ eventId: "event_parallel2" }), configuredEnv)
    ]);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
    assert.equal(sentTexts.filter(text => text.includes("nx_")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("已有旧版飞书令牌的账号不会额外领取新令牌", async () => {
  const configuredEnv = tokenEnv();
  configuredEnv.EXTENSIONS.items.set(`auth/tokens/${"a".repeat(64)}.json`, JSON.stringify({
    source: "feishu", feishuOpenId: "ou_employee12345", applicantName: "张三",
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString()
  }));
  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "张三" } } });
    sentTexts.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    await runEvent(messageEvent(), configuredEnv);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
    assert.match(sentTexts[0], /不能重复申请/);
  } finally { globalThis.fetch = originalFetch; }
});

test("撤销后可立即重新申请；旧版多枚令牌仍计入限额", async () => {
  const configuredEnv = tokenEnv();
  const sentTexts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    if (String(url).includes("/contact/v3/users/")) return Response.json({ code: 0, data: { user: { name: "张三" } } });
    sentTexts.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    await runEvent(messageEvent(), configuredEnv);
    const firstToken = [...configuredEnv.EXTENSIONS.items.keys()].find(key => key.startsWith("auth/tokens/"));
    await configuredEnv.EXTENSIONS.delete(firstToken);
    await runEvent(messageEvent({ eventId: "event_again123" }), configuredEnv);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 1);
    assert.match(sentTexts.at(-1), /nx_/);

    configuredEnv.EXTENSIONS.items.set(`auth/tokens/${"b".repeat(64)}.json`, JSON.stringify({
      source: "feishu", feishuOpenId: "ou_employee12345", applicantName: "张三",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString()
    }));
    await runEvent(messageEvent({ eventId: "event_third123" }), configuredEnv);
    assert.equal([...configuredEnv.EXTENSIONS.items.keys()].filter(key => key.startsWith("auth/tokens/")).length, 2);
    assert.match(sentTexts.at(-1), /不能重复申请/);
  } finally { globalThis.fetch = originalFetch; }
});
