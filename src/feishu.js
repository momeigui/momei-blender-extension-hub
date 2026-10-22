import { createDownloadToken, eventToken, tokenHash, TOKEN_PREFIX } from "./tokens.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
const USER_PREFIX = "auth/feishu-users/";
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyRequest(request, rawBody, encryptKey) {
  const timestamp = request.headers.get("X-Lark-Request-Timestamp") || "";
  const nonce = request.headers.get("X-Lark-Request-Nonce") || "";
  const signature = request.headers.get("X-Lark-Signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !nonce || nonce.length > 128) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
  return equalHex(await sha256Hex(`${timestamp}${nonce}${encryptKey}${rawBody}`), signature);
}

async function decryptEvent(encrypted, encryptKey) {
  if (typeof encrypted !== "string" || encrypted.length > MAX_BODY_BYTES * 2) throw new Error("invalid encrypted event");
  const raw = Uint8Array.from(atob(encrypted), char => char.charCodeAt(0));
  if (raw.length < 32 || (raw.length - 16) % 16 !== 0) throw new Error("invalid encrypted event");
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(encryptKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  const text = decoder.decode(plaintext);
  // 飞书官方 SDK 允许加密消息在 JSON 前有随机前缀。
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("invalid decrypted event");
  return JSON.parse(text.slice(start, end + 1));
}

async function feishuAccessToken(env) {
  const response = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: env.FEISHU_APP_ID, client_secret: env.FEISHU_APP_SECRET })
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || typeof result.access_token !== "string") throw new Error(`feishu_auth_${result.code ?? response.status}`);
  return result.access_token;
}

async function sendPrivateMessage(env, openId, text) {
  const accessToken = await feishuAccessToken(env);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) })
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(`feishu_message_${result.code ?? response.status}`);
}

async function employeeName(env, openId) {
  const accessToken = await feishuAccessToken(env);
  const response = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(`feishu_contact_${result.code ?? response.status}`);
  const rawName = result.data?.user?.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 80) throw new Error("feishu_contact_name_missing");
  if (result.data?.user?.status?.is_resigned === true || result.data?.user?.status?.is_activated === false) {
    throw new Error("feishu_contact_inactive_user");
  }
  return name;
}

function requestName(message) {
  if (message?.message_type !== "text" || typeof message.content !== "string") return null;
  let content;
  try { content = JSON.parse(message.content).text?.trim(); } catch { return null; }
  if (typeof content !== "string") return null;
  const match = /^(?:领取令牌|申请令牌|令牌)\s+(.+)$/u.exec(content);
  if (!match) return null;
  const name = match[1].trim();
  return name.length >= 2 && name.length <= 40 && !/[\x00-\x1f<>]/u.test(name) ? name : null;
}

async function fulfillTokenRequest(env, event, name, openId, requestChannel = "message") {
  const eventId = event.header.event_id;
  const token = await eventToken(env.ADMIN_TOKEN, env.FEISHU_APP_ID, eventId);
  const hash = await tokenHash(token);
  const key = `${TOKEN_PREFIX}${hash}.json`;
  const userKey = `${USER_PREFIX}${await sha256Hex(`${env.FEISHU_APP_ID}:${openId}`)}.json`;
  let marker = await env.EXTENSIONS.get(userKey);
  let state = marker ? await marker.json() : null;
  const now = Date.now();

  // 兼容上线前发出的令牌：不撤销旧令牌，但阻止同一账号继续领取。
  if (!marker) {
    const oldToken = await findActiveFeishuToken(env.EXTENSIONS, openId);
    if (oldToken) {
      const adopted = await env.EXTENSIONS.put(userKey, JSON.stringify({
        status: "issued", tokenHash: oldToken.hash, eventId: oldToken.feishuEventId || null,
        createdAt: oldToken.requestedAt || oldToken.createdAt
      }), { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" } });
      if (adopted) {
        await sendPrivateMessage(env, openId, "你已经有有效的 Blender 更新令牌，不能重复申请。若令牌遗失，请联系管理员撤销旧令牌后再申请。");
        return;
      }
      marker = await env.EXTENSIONS.get(userKey);
      state = marker ? await marker.json() : null;
    }
  }

  if (state?.status === "issued") {
    const active = state.tokenHash && await activeTokenRecord(env.EXTENSIONS, state.tokenHash);
    if (active) {
      // 飞书重试同一事件时可以重发同一令牌，不创建第二枚。
      if (state.eventId === eventId && state.tokenHash === hash) {
        await deliverToken(env, openId, name, token);
      } else {
        await sendPrivateMessage(env, openId, "你已经有有效的 Blender 更新令牌，不能重复申请。若令牌遗失，请联系管理员撤销旧令牌后再申请。");
      }
      return;
    }
    // 旧版本可能曾给同一人发过不止一枚；撤销其中一枚不应放行新的申请。
    const anotherToken = await findActiveFeishuToken(env.EXTENSIONS, openId);
    if (anotherToken) {
      await env.EXTENSIONS.put(userKey, JSON.stringify({
        status: "issued", tokenHash: anotherToken.hash,
        eventId: anotherToken.feishuEventId || null,
        createdAt: anotherToken.requestedAt || anotherToken.createdAt
      }), { onlyIf: { etagMatches: marker.etag }, httpMetadata: { contentType: "application/json" } });
      await sendPrivateMessage(env, openId, "你已经有有效的 Blender 更新令牌，不能重复申请。若令牌遗失，请联系管理员撤销旧令牌后再申请。");
      return;
    }
    if (now - Date.parse(state.createdAt) < CLAIM_TIMEOUT_MS) {
      await sendPrivateMessage(env, openId, "近期已经申请过令牌，请稍后再试；如需立即更换，请联系管理员。");
      return;
    }
  }
  if (state?.status === "pending" && now - Date.parse(state.createdAt) < CLAIM_TIMEOUT_MS) {
    // 上一次请求仍在处理；重试事件也不并发创建令牌。
    if (state.eventId !== eventId) {
      await sendPrivateMessage(env, openId, "你的令牌申请正在处理，请勿重复点击。若稍后未收到令牌，请联系管理员。");
    }
    return;
  }

  if (state?.status === "pending") {
    const orphanedToken = await findActiveFeishuToken(env.EXTENSIONS, openId);
    if (orphanedToken) {
      await env.EXTENSIONS.put(userKey, JSON.stringify({
        status: "issued", tokenHash: orphanedToken.hash,
        eventId: orphanedToken.feishuEventId || null,
        createdAt: orphanedToken.requestedAt || orphanedToken.createdAt
      }), { onlyIf: { etagMatches: marker.etag }, httpMetadata: { contentType: "application/json" } });
      await sendPrivateMessage(env, openId, "你已经有有效的 Blender 更新令牌，不能重复申请。若令牌遗失，请联系管理员撤销旧令牌后再申请。");
      return;
    }
  }

  const claim = { status: "pending", eventId, tokenHash: hash, createdAt: new Date(now).toISOString() };
  const claimed = await env.EXTENSIONS.put(userKey, JSON.stringify(claim), {
    onlyIf: marker ? { etagMatches: marker.etag } : new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/json" }
  });
  if (!claimed) {
    // 并发请求中只有一个能取得该账号的申请权。
    await sendPrivateMessage(env, openId, "你的令牌申请正在处理或已有有效令牌，请勿重复点击。");
    return;
  }
  try {
    await createDownloadToken(env.EXTENSIONS, {
      label: name, days: 90, token,
      metadata: {
        source: "feishu", applicantName: name, feishuOpenId: openId,
        feishuTenantKey: event.header.tenant_key || null, feishuEventId: eventId,
        requestChannel, requestedAt: claim.createdAt
      }
    });
    const finalized = await env.EXTENSIONS.put(userKey, JSON.stringify({ ...claim, status: "issued" }), {
      onlyIf: { etagMatches: claimed.etag }, httpMetadata: { contentType: "application/json" }
    });
    if (!finalized) throw new Error("feishu_token_claim_lost");
    await deliverToken(env, openId, name, token);
  } catch (error) {
    await env.EXTENSIONS.delete(key);
    const current = await env.EXTENSIONS.get(userKey);
    if (current && (await current.json()).eventId === eventId) {
      await env.EXTENSIONS.put(userKey, JSON.stringify({ ...claim, status: "failed" }), {
        onlyIf: { etagMatches: current.etag }, httpMetadata: { contentType: "application/json" }
      });
    }
    throw error;
  }
}

async function activeTokenRecord(bucket, hash) {
  const object = await bucket.get(`${TOKEN_PREFIX}${hash}.json`);
  if (!object) return false;
  try {
    const record = await object.json();
    return !record.expiresAt || Date.parse(record.expiresAt) > Date.now();
  } catch { return false; }
}

async function findActiveFeishuToken(bucket, openId) {
  let cursor;
  do {
    const page = await bucket.list({ prefix: TOKEN_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      if (!/^auth\/tokens\/[a-f0-9]{64}\.json$/.test(object.key)) continue;
      const stored = await bucket.get(object.key);
      if (!stored) continue;
      try {
        const record = await stored.json();
        if (record.source === "feishu" && record.feishuOpenId === openId &&
            (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())) {
          return { ...record, hash: object.key.slice(TOKEN_PREFIX.length, -5) };
        }
      } catch { /* 损坏的记录不能作为有效令牌。 */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return null;
}

async function deliverToken(env, openId, name, token) {
  await sendPrivateMessage(env, openId, `你好，${name}。你的 Blender 更新令牌（有效期 90 天）是：\n${token}\n\n在 Blender 扩展仓库设置中填写 https://blender.3ddd.site/index.json，勾选“需要访问令牌”并粘贴此令牌。请勿转发或截图。`);
}

async function fulfillMenuRequest(env, event, openId) {
  let name;
  try {
    name = await employeeName(env, openId);
  } catch (error) {
    console.error("Feishu employee lookup failed", error.message);
    await sendPrivateMessage(env, openId, "暂时无法从企业通讯录读取你的姓名，未创建令牌。请联系管理员检查应用的“获取用户基本信息”权限和通讯录可用范围。");
    return;
  }
  await fulfillTokenRequest(env, event, name, openId, "menu");
}

export async function handleFeishuEvent(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.FEISHU_APP_ID || !env.FEISHU_VERIFY_TOKEN || !env.FEISHU_ENCRYPT_KEY) {
    return json({ error: "feishu_not_configured" }, 503);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "invalid_content_type" }, 415);
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
    return json({ error: "request_too_large" }, 413);
  }
  const rawBody = await request.text();
  if (encoder.encode(rawBody).length > MAX_BODY_BYTES) return json({ error: "request_too_large" }, 413);
  let envelope;
  let event;
  try {
    envelope = JSON.parse(rawBody);
    if (!envelope || typeof envelope !== "object") throw new Error("invalid event");
    event = typeof envelope.encrypt === "string"
      ? await decryptEvent(envelope.encrypt, env.FEISHU_ENCRYPT_KEY)
      : envelope;
    if (!event || typeof event !== "object") throw new Error("invalid event");
  } catch {
    return json({ error: "invalid_event" }, 400);
  }

  const hasSignatureHeader = ["X-Lark-Request-Timestamp", "X-Lark-Request-Nonce", "X-Lark-Signature"]
    .some(name => request.headers.has(name));
  // 飞书首次验证地址的 challenge 可能没有普通事件的签名头。
  // 仅允许 token 正确的 challenge 跳过验签；若带了签名头，仍必须验签。
  const isChallenge = event.type === "url_verification" && typeof event.challenge === "string";
  if ((!isChallenge || hasSignatureHeader) && !await verifyRequest(request, rawBody, env.FEISHU_ENCRYPT_KEY)) {
    return json({ error: "invalid_signature" }, 403);
  }
  const token = event.header?.token || event.token;
  if (token !== env.FEISHU_VERIFY_TOKEN) return json({ error: "invalid_token" }, 403);
  if (isChallenge) {
    return json({ challenge: event.challenge });
  }
  if (typeof envelope.encrypt !== "string") return json({ error: "unencrypted_event" }, 403);
  if (event.header?.app_id !== env.FEISHU_APP_ID) return json({ error: "wrong_app" }, 403);
  // 只接管领令牌消息与指定菜单，其它现有订阅事件不得被静默确认。
  if (event.header?.event_type === "application.bot.menu_v6") {
    if (event.event?.event_key !== "request_update_token") return json({ error: "menu_not_handled" }, 503);
    const openId = event.event?.operator?.operator_id?.open_id;
    if (typeof openId !== "string" || !/^ou_[A-Za-z0-9_-]{5,128}$/.test(openId) ||
        typeof event.header?.event_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(event.header.event_id)) {
      return json({ error: "invalid_menu_operator_or_event" }, 400);
    }
    if (!env.FEISHU_APP_SECRET || !env.ADMIN_TOKEN || !env.EXTENSIONS || !ctx?.waitUntil) {
      return json({ error: "token_issuance_not_configured" }, 503);
    }
    ctx.waitUntil(fulfillMenuRequest(env, event, openId)
      .catch(error => console.error("Feishu menu token delivery failed", error.message)));
    return json({ code: 0 });
  }
  if (event.header?.event_type !== "im.message.receive_v1") return json({ error: "event_not_handled" }, 503);
  if (event.event?.message?.chat_type !== "p2p" || event.event?.sender?.sender_type !== "user") {
    return json({ error: "private_user_message_required" }, 403);
  }
  const openId = event.event?.sender?.sender_id?.open_id;
  if (typeof openId !== "string" || !/^ou_[A-Za-z0-9_-]{5,128}$/.test(openId) ||
      typeof event.header?.event_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(event.header.event_id)) {
    return json({ error: "invalid_sender_or_event" }, 400);
  }
  if (!env.FEISHU_APP_SECRET || !env.ADMIN_TOKEN || !env.EXTENSIONS || !ctx?.waitUntil) {
    return json({ error: "token_issuance_not_configured" }, 503);
  }
  const name = requestName(event.event.message);
  if (!name) {
    ctx.waitUntil(sendPrivateMessage(env, openId, "领更新令牌请发送：领取令牌 你的姓名。令牌只会私聊发给你本人。")
      .catch(error => console.error("Feishu instruction delivery failed", error.message)));
    return json({ code: 0 });
  }
  ctx.waitUntil(fulfillTokenRequest(env, event, name, openId)
    .catch(error => console.error("Feishu token delivery failed", error.message)));
  return json({ code: 0 });
}
