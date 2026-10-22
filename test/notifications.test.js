import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class MemoryBucket {
  constructor() { this.items = new Map(); this.versions = new Map(); }
  async get(key) {
    const value = this.items.get(key);
    return value === undefined ? null : { etag: String(this.versions.get(key) || 1), json: async () => JSON.parse(value) };
  }
  async head(key) { return this.items.has(key) ? { key } : null; }
  async delete(key) { this.items.delete(key); this.versions.delete(key); }
  async put(key, value, options = {}) {
    if (options.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && this.items.has(key)) return null;
    if (options.onlyIf?.etagMatches && String(this.versions.get(key)) !== options.onlyIf.etagMatches) return null;
    const next = (this.versions.get(key) || 0) + 1;
    this.items.set(key, value);
    this.versions.set(key, next);
    return { etag: String(next) };
  }
  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const keys = [...this.items.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const selected = keys.slice(start, start + limit);
    return { objects: selected.map(key => ({ key })), truncated: start + limit < keys.length,
      cursor: start + limit < keys.length ? String(start + limit) : undefined };
  }
}

function tokenKey(number) { return `auth/tokens/${number.toString(16).padStart(64, "0")}.json`; }
function validToken(openId) {
  return JSON.stringify({ source: "feishu", feishuOpenId: openId,
    expiresAt: new Date(Date.now() + 86400000).toISOString() });
}
function setup() {
  const bucket = new MemoryBucket();
  bucket.items.set("latest.json", JSON.stringify({ version: "1.2.3", date: "2026-10-22", highlights: ["修复手部动画", "提升导入速度"] }));
  return { EXTENSIONS: bucket, FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "app_secret" };
}

test("新版本私聊通知有效令牌持有人；旧版重复令牌、过期令牌不重复发送", async () => {
  const env = setup();
  env.EXTENSIONS.items.set(tokenKey(1), validToken("ou_employee00001"));
  env.EXTENSIONS.items.set(tokenKey(2), validToken("ou_employee00001"));
  env.EXTENSIONS.items.set(tokenKey(3), validToken("ou_employee00002"));
  env.EXTENSIONS.items.set(tokenKey(4), JSON.stringify({ source: "feishu", feishuOpenId: "ou_employee00003", expiresAt: "2020-01-01T00:00:00Z" }));
  env.EXTENSIONS.items.set(tokenKey(5), JSON.stringify({ source: "admin", label: "无飞书账号" }));
  const messages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    messages.push(JSON.parse(options.body));
    return Response.json({ code: 0 });
  };
  try {
    await worker.scheduled({}, env);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map(item => item.receive_id).sort(), ["ou_employee00001", "ou_employee00002"]);
    assert.match(JSON.parse(messages[0].content).text, /v1\.2\.3[\s\S]*修复手部动画/);
    await worker.scheduled({}, env);
    assert.equal(messages.length, 2);

    env.EXTENSIONS.items.set("latest.json", JSON.stringify({ version: "1.2.4", highlights: ["新增导出功能"] }));
    await worker.scheduled({}, env);
    assert.equal(messages.length, 4);
    assert.match(JSON.parse(messages[2].content).text, /v1\.2\.4/);
  } finally { globalThis.fetch = originalFetch; }
});

test("大量员工分批通知，同版本成功发送者不重发", async () => {
  const env = setup();
  for (let i = 1; i <= 10; i++) env.EXTENSIONS.items.set(tokenKey(i), validToken(`ou_employee${String(i).padStart(5, "0")}`));
  const messages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    messages.push(JSON.parse(options.body));
    return Response.json({ code: 0 });
  };
  try {
    await worker.scheduled({}, env);
    assert.equal(messages.length, 8);
    await worker.scheduled({}, env);
    assert.equal(messages.length, 10);
    await worker.scheduled({}, env);
    assert.equal(messages.length, 10);
  } finally { globalThis.fetch = originalFetch; }
});

test("某个私聊暂时失败时仍通知其他人，并在下一轮重试失败者", async () => {
  const env = setup();
  env.EXTENSIONS.items.set(tokenKey(1), validToken("ou_employee00001"));
  env.EXTENSIONS.items.set(tokenKey(2), validToken("ou_employee00002"));
  const messages = [];
  let failFirst = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    const message = JSON.parse(options.body);
    if (message.receive_id === "ou_employee00001" && failFirst) return Response.json({ code: 123 });
    messages.push(message);
    return Response.json({ code: 0 });
  };
  try {
    await worker.scheduled({}, env);
    assert.deepEqual(messages.map(item => item.receive_id), ["ou_employee00002"]);
    failFirst = false;
    await worker.scheduled({}, env);
    assert.deepEqual(messages.map(item => item.receive_id), ["ou_employee00002", "ou_employee00001"]);
    await worker.scheduled({}, env);
    assert.equal(messages.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("连续发布两个版本时按 R2 发布记录逐个通知，不漏掉中间版本", async () => {
  const env = setup();
  env.EXTENSIONS.items.set(tokenKey(1), validToken("ou_employee00001"));
  env.EXTENSIONS.items.set("releases/000001-000002-000004.json", JSON.stringify({ version: "1.2.4", highlights: ["第一版"] }));
  env.EXTENSIONS.items.set("releases/000001-000002-000005.json", JSON.stringify({ version: "1.2.5", highlights: ["第二版"] }));
  env.EXTENSIONS.items.set("latest.json", JSON.stringify({ version: "1.2.5", highlights: ["第二版"] }));
  const messages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/")) return Response.json({ code: 0, access_token: "access" });
    messages.push(JSON.parse(JSON.parse(options.body).content).text);
    return Response.json({ code: 0 });
  };
  try {
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /v1\.2\.4/);
    assert.match(messages[1], /v1\.2\.5/);
  } finally { globalThis.fetch = originalFetch; }
});
