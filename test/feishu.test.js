import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

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

test("未配置密钥和未接入的消息处理均明确拒绝", async () => {
  const challenge = { type: "url_verification", token: env.FEISHU_VERIFY_TOKEN, challenge: "abc" };
  assert.equal((await worker.fetch(await signedEvent(challenge), {}, {})).status, 503);
  const message = { header: { token: env.FEISHU_VERIFY_TOKEN, app_id: env.FEISHU_APP_ID, event_type: "im.message.receive_v1" }, event: {} };
  assert.equal((await worker.fetch(await signedEvent(message), env)).status, 503);
  assert.equal((await worker.fetch(await signedEvent(message, { unsigned: true }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(`${origin}/feishu/events`), env)).status, 405);
});
