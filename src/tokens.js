export const TOKEN_PREFIX = "auth/tokens/";
const encoder = new TextEncoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBase64Url(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function tokenHash(token) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export async function createDownloadToken(bucket, { label, days, metadata = {}, token: suppliedToken }) {
  const token = suppliedToken || `nx_${randomBase64Url()}`;
  const hash = await tokenHash(token);
  const createdAt = new Date().toISOString();
  const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();
  await bucket.put(`${TOKEN_PREFIX}${hash}.json`, JSON.stringify({ label, createdAt, expiresAt, ...metadata }), {
    httpMetadata: { contentType: "application/json" }
  });
  return { token, hash };
}

export async function eventToken(secret, appId, eventId) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`feishu-token:${appId}:${eventId}`)));
  return `nx_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}
