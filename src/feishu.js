const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;

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

export async function handleFeishuEvent(request, env) {
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
  // 消息处理尚未启用时，不能向飞书返回成功，否则员工消息会被静默丢弃。
  return json({ error: "message_handler_not_enabled" }, 503);
}
