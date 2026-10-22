const TOKEN_PREFIX = "auth/tokens/";
const COOKIE_NAME = "momei_extensions_admin";
const SESSION_SECONDS = 3600;
const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.zip$/;
const encoder = new TextEncoder();

function randomBase64Url(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenHash(token) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function securityHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function page(title, body, status = 200, extraHeaders = {}) {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Momei 扩展更新管理</title><style>body{font:16px system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1rem;background:#f5f6f8;color:#20232a}main{background:white;padding:1.6rem;border-radius:12px;box-shadow:0 2px 16px #0001}h1{margin-top:0}section{margin:2rem 0}label{display:block;margin:.8rem 0}input,select,button{font:inherit;padding:.5rem}input[type=text],input[type=password]{max-width:100%;width:25rem}button{cursor:pointer}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #ddd}code{overflow-wrap:anywhere}p.note{color:#555}p.error{color:#b00020}p.success{color:#087327}form.inline{display:inline}</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(), ...extraHeaders }
  });
}

function loginPage(error = "", status = 200) {
  return page("登录", `<h1>Momei 扩展更新管理</h1><p>管理员登录。用户下载令牌在登录后创建。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form action="/admin/login" method="post"><label>管理员密钥<br><input type="password" name="secret" required autocomplete="current-password"></label><button type="submit">登录</button></form>`, status);
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

async function tokensForDashboard(bucket) {
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
        tokens.push({ hash: object.key.slice(TOKEN_PREFIX.length, -5), ...data });
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
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function dashboard(env, payload, notice = "", createdToken = "") {
  const csrf = await csrfToken(env.ADMIN_TOKEN, payload);
  const [tokens, files, index] = await Promise.all([
    tokensForDashboard(env.EXTENSIONS), releaseFiles(env.EXTENSIONS), env.EXTENSIONS.head("index.json")
  ]);
  const now = Date.now();
  const tokenRows = tokens.map(token => {
    const active = !token.expiresAt || Date.parse(token.expiresAt) > now;
    return `<tr><td>${escapeHtml(token.label || "（未命名）")}</td><td>${active ? "有效" : "已过期"}</td><td>${escapeHtml(token.createdAt || "")}</td><td>${escapeHtml(token.expiresAt || "永不")}</td><td><form class="inline" action="/admin/tokens/revoke" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="hash" value="${escapeHtml(token.hash)}"><button type="submit">撤销</button></form></td></tr>`;
  }).join("");
  const fileRows = files.map(file => `<tr><td><code>${escapeHtml(file.key)}</code></td><td>${formatSize(file.size)}</td><td>${escapeHtml(file.uploaded || "")}</td></tr>`).join("");
  return page("管理", `<h1>Momei 扩展更新管理</h1><form action="/admin/logout" method="post"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">退出登录</button></form>${notice ? `<p class="success">${escapeHtml(notice)}</p>` : ""}${createdToken ? `<section><h2>新令牌（仅显示一次）</h2><p class="note">请现在复制给对应用户；服务器只保存摘要，之后无法找回原文。</p><p><code>${escapeHtml(createdToken)}</code></p></section>` : ""}<section><h2>创建用户下载令牌</h2><form action="/admin/tokens" method="post"><input type="hidden" name="csrf" value="${csrf}"><label>备注名称<br><input type="text" name="label" maxlength="80" required></label><label>有效期<br><select name="days"><option value="90">90 天</option><option value="30">30 天</option><option value="365">365 天</option><option value="0">永不过期</option></select></label><button type="submit">创建令牌</button></form></section><section><h2>用户令牌</h2><table><thead><tr><th>备注</th><th>状态</th><th>创建时间</th><th>到期时间</th><th>操作</th></tr></thead><tbody>${tokenRows || "<tr><td colspan=5>暂无令牌</td></tr>"}</tbody></table></section><section><h2>发布文件</h2><p>index.json：${index ? `已存在，${formatSize(index.size)}` : "尚未上传"}</p><table><thead><tr><th>ZIP 文件</th><th>大小</th><th>上传时间</th></tr></thead><tbody>${fileRows || "<tr><td colspan=3>暂无发布包</td></tr>"}</tbody></table><p class="note">此页面仅查看文件；文件由 GitHub 构建流程推送到私有 R2。</p></section>`);
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
    const token = `nx_${randomBase64Url()}`;
    const hash = await tokenHash(token);
    const createdAt = new Date().toISOString();
    const expiresAt = days === "0" ? null : new Date(Date.now() + Number(days) * 86400000).toISOString();
    await env.EXTENSIONS.put(`${TOKEN_PREFIX}${hash}.json`, JSON.stringify({ label, createdAt, expiresAt }), { httpMetadata: { contentType: "application/json" } });
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
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/admin" || path.startsWith("/admin/")) return await handleAdmin(request, env, path);
      return await handleDownload(request, env, path);
    } catch (error) {
      console.error("Extension gateway request failed", error);
      return new Response("Internal server error", { status: 500, headers: securityHeaders() });
    }
  }
};



