import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.zip$/;
const BEARER = /^Bearer nx_[A-Za-z0-9_-]{40,100}$/;
const DEFAULT_CHECK_URL = "https://blender.3ddd.site/auth/check";
const MAX_INDEX_BYTES = 1024 * 1024;

function respond(response, status, message, method = "GET", headers = {}) {
  response.writeHead(status, { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(method === "HEAD" ? undefined : message);
}

export async function verifyWithWorker(header, checkUrl = DEFAULT_CHECK_URL) {
  const url = new URL(checkUrl);
  if (url.protocol !== "https:") throw new Error("AUTH_CHECK_URL must use HTTPS");
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: header },
    redirect: "manual",
    signal: AbortSignal.timeout(6000)
  });
  if (response.status === 204) return true;
  if (response.status === 401) return false;
  throw new Error(`Token verification returned HTTP ${response.status}`);
}

async function repositoryIndex(mountDir) {
  const path = join(mountDir, "index.json");
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_INDEX_BYTES) throw new Error("Invalid mounted index");
  const body = await readFile(path);
  const repository = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(repository?.data)) throw new Error("Invalid mounted index");
  return { body, repository };
}

function archiveListed(repository, name) {
  return repository.data.some(item => {
    const url = item?.archive_url;
    if (typeof url !== "string" || !url.startsWith("./")) return false;
    try { return decodeURIComponent(url.slice(2)) === name; }
    catch { return false; }
  });
}

async function releaseReady(mountDir) {
  const { repository } = await repositoryIndex(mountDir);
  if (repository.data.length === 0) return false;
  for (const item of repository.data) {
    const url = item?.archive_url;
    if (typeof url !== "string" || !url.startsWith("./")) return false;
    let name;
    try { name = decodeURIComponent(url.slice(2)); }
    catch { return false; }
    if (!ZIP_NAME.test(name)) return false;
    const info = await stat(join(mountDir, name));
    if (!info.isFile() || (item.archive_size != null && info.size !== Number(item.archive_size))) return false;
  }
  return true;
}

export function createGateway({
  mountDir = process.env.OSS_MOUNT_DIR || "/mnt/oss",
  verifyToken = header => verifyWithWorker(header, process.env.AUTH_CHECK_URL || DEFAULT_CHECK_URL),
  logger = console
} = {}) {
  return createServer(async (request, response) => {
    const method = request.method || "GET";
    if (!["GET", "HEAD"].includes(method)) return respond(response, 405, "Method not allowed", method, { Allow: "GET, HEAD" });
    let path;
    try { path = new URL(request.url, "http://gateway.local").pathname; }
    catch { return respond(response, 400, "Bad request", method); }
    if (path === "/health") {
      try {
        if (!await releaseReady(mountDir)) throw new Error("Incomplete release");
        // The Worker may be reachable by users but not from this region.
        // Check the small authentication round trip before it redirects users here.
        await verifyToken("Bearer health-probe");
        return respond(response, 200, "ok", method);
      } catch { return respond(response, 503, "Storage unavailable", method); }
    }
    const name = path.slice(1);
    if (name !== "index.json" && !ZIP_NAME.test(name)) return respond(response, 404, "Not found", method);
    const authorization = request.headers.authorization || "";
    if (!BEARER.test(authorization)) return respond(response, 401, "Unauthorized", method, { "WWW-Authenticate": 'Bearer realm="Momei Blender Extensions"' });
    try {
      if (!await verifyToken(authorization)) return respond(response, 401, "Unauthorized", method);
    } catch (error) {
      logger.warn("Token verification service unavailable", error);
      return respond(response, 503, "Authentication unavailable", method);
    }
    let index;
    try { index = await repositoryIndex(mountDir); }
    catch (error) {
      logger.error("OSS mount index unavailable", error);
      return respond(response, 503, "Storage unavailable", method);
    }
    if (name === "index.json") {
      response.writeHead(200, {
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Type": "application/json; charset=utf-8", "Content-Length": index.body.length
      });
      return response.end(method === "HEAD" ? undefined : index.body);
    }
    if (!archiveListed(index.repository, name)) return respond(response, 404, "Not found", method);
    const archivePath = join(mountDir, name);
    let info;
    try {
      info = await stat(archivePath);
      if (!info.isFile()) return respond(response, 404, "Not found", method);
    } catch (error) {
      if (error?.code === "ENOENT") return respond(response, 404, "Not found", method);
      logger.error("OSS mount archive unavailable", error);
      return respond(response, 503, "Storage unavailable", method);
    }
    response.writeHead(200, {
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Type": "application/zip", "Content-Length": info.size
    });
    if (method === "HEAD") return response.end();
    const stream = createReadStream(archivePath);
    stream.on("error", error => { logger.error("OSS mount stream failed", error); response.destroy(error); });
    stream.pipe(response);
  });
}
