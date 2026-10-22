import { escapeHtml, securityHeaders, page, homePage } from "./site.js";
import { handleFeishuEvent } from "./feishu.js";
import { notifyLatestRelease } from "./notifications.js";
import { TOKEN_PREFIX, randomBase64Url, tokenHash, createDownloadToken } from "./tokens.js";
import { subscriptionStatus } from "./subscriptions.js";

const COOKIE_NAME = "momei_extensions_admin";
const SESSION_SECONDS = 3600;
const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.zip$/;
const encoder = new TextEncoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(secret, value) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value));
  return hex(signature);
}

async function verifySignature(secret, value, signature) {
  if (!/^[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const bytes = Uint8Array.from(signature.match(/../g), pair => parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(value));
}

function loginPage(error = "", status = 200) {
  return page("管理登录", `<div class="container login-layout"><div class="login-card"><div class="login-icon" aria-hidden="true">✦</div><h1>欢迎回来</h1><p>登录管理后台，查看发布文件并管理用户下载令牌。</p>${error ? `<div class="notice notice-error" role="alert">${escapeHtml(error)}</div>` : ""}<form action="/admin/login" method="post"><label class="field"><span>管理员密钥</span><input type="password" name="secret" required autocomplete="current-password" placeholder="输入管理密钥"></label><button class="btn btn-blue" type="submit">进入管理后台</button></form></div></div>`, status, {}, "login");
}

function cookieValue(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)momei_extensions_admin=([^;]+)/);
  return match?.[1] || "";
}

async function adminSession(request, secret) {
  const parts = cookieValue(request).split(".");
  if (parts.length !== 3 || !/^\d{10,13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{20,}$/.test(parts[1])) return null;
  const [expires, nonce, signature] = parts;
  if (Number(expires) < Date.now()) return null;
  const payload = `${expires}.${nonce}`;
  return await verifySignature(secret, `session:${payload}`, signature) ? payload : null;
}

async function csrfToken(secret, payload) {
  return sign(secret, `csrf:${payload}`);
}

function sameOrigin(request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (origin && origin !== "null") return origin === expected;
  const referer = request.headers.get("Referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

async function formFields(request) {
  const size = Number(request.headers.get("Content-Length") || 0);
  if (size > 8192) return null;
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return null;
  const body = await request.text();
  if (body.length > 8192) return null;
  return new URLSearchParams(body);
}

function redirectToAdmin(extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: "/admin", ...securityHeaders(), ...extraHeaders } });
}

async function tokensForDashboard(bucket, appId) {
  const tokens = [];
  let cursor;
  do {
    const result = await bucket.list({ prefix: TOKEN_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of result.objects) {
      if (!/^auth\/tokens\/[a-f0-9]{64}\.json$/.test(object.key)) continue;
      const record = await bucket.get(object.key);
      if (!record) continue;
      try {
        const data = await record.json();
        const subscribed = data.source === "feishu" && data.feishuOpenId && appId
          ? await subscriptionStatus(bucket, appId, data.feishuOpenId) : null;
        tokens.push({ hash: object.key.slice(TOKEN_PREFIX.length, -5), ...data, subscribed });
      } catch { /* 忽略损坏的管理记录，下载验证也会拒绝它。 */ }
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return tokens.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function releaseFiles(bucket) {
  const files = [];
  let cursor;
  do {
    const result = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    files.push(...result.objects.filter(object => ZIP_NAME.test(object.key)));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return files.sort((a, b) => String(b.uploaded || "").localeCompare(String(a.uploaded || "")));
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

async function latestRelease(bucket) {
  if (!bucket) return null;
  const object = await bucket.get("latest.json");
  if (!object) return null;
  try {
    const data = await object.json();
    if (!/^\d+\.\d+\.\d+$/.test(data.version) || !Array.isArray(data.highlights)) return null;
    return {
      version: data.version,
      date: /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : "",
      highlights: data.highlights.filter(item => typeof item === "string" && item.length <= 300).slice(0, 5)
    };
  } catch {
    return null;
  }
}

async function dashboard(env, payload, notice = "", createdToken = "") {
  const csrf = await csrfToken(env.ADMIN_TOKEN, payload);
  const [tokens, files, index] = await Promise.all([
    tokensForDashboard(env.EXTENSIONS, env.FEISHU_APP_ID), releaseFiles(env.EXTENSIONS), env.EXTENSIONS.head("index.json")
  ]);
  const now = Date.now();
  const activeCount = tokens.filter(token => !token.expiresAt || Date.parse(token.expiresAt) > now).length;
  const tokenRows = tokens.map(token => {
    const active = !token.expiresAt || Date.parse(token.expiresAt) > now;
    return `<tr><td>${escapeHtml(token.label || "（未命名）")}</td><td>${token.source === "feishu" ? `飞书私聊<br><small>${escapeHtml(token.feishuOpenId || "")}</small>` : "后台创建"}</td><td><span class="status ${active ? "" : "status-expired"}">${active ? "有效" : "已过期"}</span></td><td>${token.subscribed === null ? "—" : `<span class="status ${token.subscribed ? "" : "status-expired"}">${token.subscribed ? "已订阅" : "已取消"}</span>`}</td><td>${escapeHtml(formatTime(token.requestedAt || token.createdAt))}</td><td>${token.expiresAt ? escapeHtml(formatTime(token.expiresAt)) : "永不过期"}</td><td><form class="inline" action="/admin/tokens/revoke" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="hash" value="${escapeHtml(token.hash)}"><button class="small-button" type="submit" aria-label="撤销 ${escapeHtml(token.label || "未命名")} 的令牌">撤销</button></form></td></tr>`;
  }).join("");
  const fileRows = files.map(file => `<tr><td><code>${escapeHtml(file.key)}</code></td><td>${formatSize(file.size)}</td><td>${escapeHtml(formatTime(file.uploaded))}</td></tr>`).join("");
  const body = `<div class="container admin-shell"><div class="admin-intro"><div><span class="section-kicker">DISTRIBUTION CONSOLE</span><h1>扩展更新管理</h1><p>管理下载权限，查看已经发布到私有 R2 的文件。</p></div><form class="logout-form" action="/admin/logout" method="post"><input type="hidden" name="csrf" value="${csrf}"><button class="btn btn-light" type="submit">退出登录</button></form></div>
  ${notice ? `<div class="notice notice-success" role="status">${escapeHtml(notice)}</div>` : ""}
  ${createdToken ? `<div class="token-once" role="status"><h2>新令牌已创建 · 仅显示一次</h2><p>请现在复制并安全地交给对应用户。服务器只保存摘要，之后无法找回原文。</p><code>${escapeHtml(createdToken)}</code></div>` : ""}
  <div class="metric-grid"><div class="metric"><span class="metric-label">仓库索引</span><strong>${index ? '<span class="status">已就绪</span>' : '<span class="status status-missing">未上传</span>'}</strong><small>${index ? formatSize(index.size) : "等待构建发布"}</small></div><div class="metric"><span class="metric-label">发布安装包</span><strong>${files.length}</strong><small>私有 R2 存储桶</small></div><div class="metric"><span class="metric-label">有效下载令牌</span><strong>${activeCount}</strong><small>共 ${tokens.length} 个令牌记录</small></div></div>
  <div class="admin-grid"><section class="panel"><h2>创建下载令牌</h2><p class="panel-subtitle">为用户单独发放，可随时撤销。</p><form action="/admin/tokens" method="post"><input type="hidden" name="csrf" value="${csrf}"><label class="field"><span>备注名称</span><input type="text" name="label" maxlength="80" placeholder="例如：测试用户 / 团队成员" required></label><label class="field"><span>有效期</span><select name="days"><option value="90">90 天</option><option value="30">30 天</option><option value="365">365 天</option><option value="0">永不过期</option></select></label><div class="form-actions"><button class="btn btn-blue" type="submit">创建令牌</button></div></form></section><section class="panel"><h2>用户令牌</h2><p class="panel-subtitle">飞书令牌持有人默认订阅；只有有效令牌且仍订阅者才会收到更新提醒。</p><div class="table-scroll"><table class="data-table token-table"><thead><tr><th>申请人</th><th>来源／飞书 ID</th><th>令牌状态</th><th>更新提醒</th><th>申请时间</th><th>到期时间</th><th>操作</th></tr></thead><tbody>${tokenRows || '<tr><td class="empty-cell" colspan="7">暂无令牌。可在左侧创建第一个下载令牌。</td></tr>'}</tbody></table></div></section></div>
  <section class="panel panel-wide"><div class="panel-head"><div><h2>发布文件</h2><p class="panel-subtitle">由 GitHub 构建流程推送，本页仅供查看。</p></div><span class="status ${index ? "" : "status-missing"}">index.json ${index ? "已存在" : "尚未上传"}</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>ZIP 安装包</th><th>大小</th><th>上传时间</th></tr></thead><tbody>${fileRows || '<tr><td class="empty-cell" colspan="3">暂无发布包</td></tr>'}</tbody></table></div><p class="helper">同一个安装包同时发布到 GitHub 与 Cloudflare 通道；用户只需选择其中一条更新源。</p></section></div>`;
  return page("管理", body, 200, {}, "admin");
}

async function handleAdmin(request, env, path) {
  if (!env.ADMIN_TOKEN || !env.EXTENSIONS) return new Response("管理服务未配置", { status: 503 });
  // 明确跨站的请求仍拒绝；Origin/Referer 都缺失时，登录密钥或下方 CSRF 校验负责认证。
  if (request.method === "POST" && sameOrigin(request) === false) return new Response("来源校验失败", { status: 403, headers: securityHeaders() });
  if (path === "/admin/login" && request.method === "POST") {
    const form = await formFields(request);
    const supplied = form?.get("secret") || "";
    const valid = supplied && await verifySignature(env.ADMIN_TOKEN, "login", await sign(supplied, "login"));
    if (!valid) return loginPage("管理员密钥不正确", 401);
    const payload = `${Date.now() + SESSION_SECONDS * 1000}.${randomBase64Url(24)}`;
    const signature = await sign(env.ADMIN_TOKEN, `session:${payload}`);
    return redirectToAdmin({ "Set-Cookie": `${COOKIE_NAME}=${payload}.${signature}; Path=/admin; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` });
  }
  const session = await adminSession(request, env.ADMIN_TOKEN);
  if (!session) return request.method === "GET" && path === "/admin" ? loginPage() : new Response("请先登录", { status: 401, headers: securityHeaders() });
  if (path === "/admin" && request.method === "GET") return dashboard(env, session);
  if (request.method !== "POST") return new Response("Not found", { status: 404, headers: securityHeaders() });
  const form = await formFields(request);
  const csrf = form?.get("csrf");
  if (!csrf || !await verifySignature(env.ADMIN_TOKEN, `csrf:${session}`, csrf)) {
    return new Response("表单校验失败", { status: 403, headers: securityHeaders() });
  }
  if (path === "/admin/logout") return redirectToAdmin({ "Set-Cookie": `${COOKIE_NAME}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  if (path === "/admin/tokens") {
    const label = String(form.get("label") || "").trim();
    const days = String(form.get("days") || "");
    if (!label || label.length > 80 || !["0", "30", "90", "365"].includes(days)) {
      return new Response("令牌参数无效", { status: 400, headers: securityHeaders() });
    }
    const { token } = await createDownloadToken(env.EXTENSIONS, { label, days: Number(days), metadata: { source: "admin" } });
    return dashboard(env, session, "令牌已创建", token);
  }
  if (path === "/admin/tokens/revoke") {
    const hash = String(form.get("hash") || "");
    if (!/^[a-f0-9]{64}$/.test(hash)) return new Response("令牌标识无效", { status: 400, headers: securityHeaders() });
    await env.EXTENSIONS.delete(`${TOKEN_PREFIX}${hash}.json`);
    return dashboard(env, session, "令牌已撤销");
  }
  return new Response("Not found", { status: 404, headers: securityHeaders() });
}

async function validDownloadToken(bucket, request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer (nx_[A-Za-z0-9_-]{40,100})$/.exec(header);
  if (!match) return false;
  const record = await bucket.get(`${TOKEN_PREFIX}${await tokenHash(match[1])}.json`);
  if (!record) return false;
  try {
    const data = await record.json();
    return !data.expiresAt || Date.parse(data.expiresAt) > Date.now();
  } catch { return false; }
}

async function listedArchive(bucket, name) {
  if (!ZIP_NAME.test(name)) return false;
  const index = await bucket.get("index.json");
  if (!index) return false;
  try {
    const repository = await index.json();
    return Array.isArray(repository.data) && repository.data.some(item => {
      const url = item?.archive_url;
      if (typeof url !== "string" || !url.startsWith("./")) return false;
      try {
        return decodeURIComponent(url.slice(2)) === name;
      } catch { return false; }
    });
  } catch { return false; }
}

async function handleDownload(request, env, path) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD", ...securityHeaders() } });
  const name = path.slice(1);
  if (name !== "index.json" && !ZIP_NAME.test(name)) return new Response("Not found", { status: 404, headers: securityHeaders() });
  if (!env.EXTENSIONS) return new Response("Storage unavailable", { status: 503, headers: securityHeaders() });
  if (!await validDownloadToken(env.EXTENSIONS, request)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="Momei Blender Extensions"', ...securityHeaders() } });
  }
  if (name !== "index.json" && !await listedArchive(env.EXTENSIONS, name)) {
    return new Response("Not found", { status: 404, headers: securityHeaders() });
  }
  const object = request.method === "HEAD" ? await env.EXTENSIONS.head(name) : await env.EXTENSIONS.get(name);
  if (!object) return new Response("Not found", { status: 404, headers: securityHeaders() });
  const headers = new Headers(securityHeaders());
  headers.set("Content-Type", name === "index.json" ? "application/json; charset=utf-8" : "application/zip");
  headers.set("Content-Length", String(object.size));
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export default {
  async scheduled(_controller, env) {
    await notifyLatestRelease(env);
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/feishu/events") return await handleFeishuEvent(request, env, ctx);
      if (path === "/" && request.method === "GET") return homePage(await latestRelease(env.EXTENSIONS));
      if (path === "/admin" || path.startsWith("/admin/")) return await handleAdmin(request, env, path);
      return await handleDownload(request, env, path);
    } catch (error) {
      console.error("Extension gateway request failed", error);
      return new Response("Internal server error", { status: 500, headers: securityHeaders() });
    }
  }
};



