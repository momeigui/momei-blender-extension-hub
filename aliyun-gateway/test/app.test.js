import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, verifyWithWorker } from "../src/app.js";

const zip = "Noetix-Motion-Editor-0.1.46-win64-cp313-pyd.zip";
const token = `Bearer nx_${"a".repeat(43)}`;

async function fixture(verifyToken = async () => true) {
  const directory = await mkdtemp(join(tmpdir(), "noetix-aliyun-gateway-"));
  const index = JSON.stringify({ version: "v1", data: [{ archive_url: `./${zip}` }] });
  await writeFile(join(directory, "index.json"), index);
  await writeFile(join(directory, zip), "ZIP_BYTES");
  const server = createGateway({ mountDir: directory, verifyToken, logger: { warn() {}, error() {} } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, index, directory,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("国内网关只给有效令牌读取已列入索引的 OSS 文件", async () => {
  let checks = 0;
  const app = await fixture(async header => { checks++; return header === token; });
  try {
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
    assert.equal((await fetch(`${app.base}/index.json`)).status, 401);
    assert.equal(checks, 1); // /health checks that the Worker auth service is reachable.
    const headers = { Authorization: token };
    const index = await fetch(`${app.base}/index.json`, { headers });
    assert.equal(index.status, 200);
    assert.equal(await index.text(), app.index);
    assert.equal(index.headers.get("cache-control"), "private, no-store");
    const download = await fetch(`${app.base}/${zip}`, { headers });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-length"), "9");
    assert.equal(await download.text(), "ZIP_BYTES");
    const head = await fetch(`${app.base}/${zip}`, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "9");
    assert.equal((await fetch(`${app.base}/other.zip`, { headers })).status, 404);
    assert.equal((await fetch(`${app.base}/../auth/tokens/x.json`, { headers })).status, 404);
    assert.equal((await fetch(`${app.base}/${zip}`, { method: "POST", headers })).status, 405);
    assert.equal(checks, 5);
  } finally { await app.close(); }
});

test("网关令牌验证失败或服务不可用时不会泄露 OSS 文件", async () => {
  const denied = await fixture(async () => false);
  try {
    const response = await fetch(`${denied.base}/${zip}`, { headers: { Authorization: token } });
    assert.equal(response.status, 401);
  } finally { await denied.close(); }

  const outage = await fixture(async () => { throw new Error("Cloudflare unavailable"); });
  try {
    const response = await fetch(`${outage.base}/${zip}`, { headers: { Authorization: token } });
    assert.equal(response.status, 503);
  } finally { await outage.close(); }
});

test("网关仅接受 Worker 的 204 作为有效令牌", async () => {
  const originalFetch = globalThis.fetch;
  let status = 204;
  globalThis.fetch = async (url, options) => {
    assert.equal(url.href, "https://blender.3ddd.site/auth/check");
    assert.equal(options.headers.Authorization, token);
    return new Response(null, { status });
  };
  try {
    assert.equal(await verifyWithWorker(token), true);
    status = 401;
    assert.equal(await verifyWithWorker(token), false);
    status = 503;
    await assert.rejects(verifyWithWorker(token), /HTTP 503/);
    await assert.rejects(verifyWithWorker(token, "http://untrusted.example"), /HTTPS/);
  } finally { globalThis.fetch = originalFetch; }
});

test("OSS 挂载缺少索引中声明的 ZIP 时健康检查失败", async () => {
  const app = await fixture();
  try {
    await rm(join(app.directory, zip));
    assert.equal((await fetch(`${app.base}/health`)).status, 503);
  } finally { await app.close(); }
});
