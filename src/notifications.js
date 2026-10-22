import { sendPrivateMessage } from "./feishu.js";
import { TOKEN_PREFIX, tokenHash } from "./tokens.js";

const STATE_KEY = "auth/notifications/release-state.json";
const PAGE_SIZE = 8; // 兼顾 Worker 免费方案的每次调用子请求限额。
const RETRY_PAGE_SIZE = 5;

function validRelease(data) {
  if (!data || !/^\d+\.\d+\.\d+$/.test(data.version) || !Array.isArray(data.highlights)) return null;
  return {
    version: data.version,
    date: /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : "",
    highlights: data.highlights.filter(item => typeof item === "string")
      .map(item => item.replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 5)
  };
}

function releaseMessage(release) {
  const changes = release.highlights.length
    ? release.highlights.map(item => `• ${item}`).join("\n")
    : "请查看官网的最新版本说明。";
  return `Noetix Motion Editor 已更新至 v${release.version}${release.date ? `（${release.date}）` : ""}\n\n${changes}\n\n打开 Blender 的扩展仓库检查更新即可。更新源：https://blender.3ddd.site/index.json\n更新说明：https://blender.3ddd.site/`;
}

function activeFeishuRecipient(data) {
  return typeof data?.feishuOpenId === "string" && /^ou_[A-Za-z0-9_-]{5,128}$/.test(data.feishuOpenId) &&
    (!data.expiresAt || Date.parse(data.expiresAt) > Date.now());
}

function recipientKeys(version, userHash) {
  return {
    sentKey: `auth/notifications/sent/v${version}/${userHash}.json`,
    failureKey: `auth/notifications/failed/v${version}/${userHash}.json`
  };
}

async function announceTo(env, release, recipient, tokenKey, isRetry = false) {
  const userHash = await tokenHash(`${env.FEISHU_APP_ID}:${recipient.feishuOpenId}`);
  const { sentKey, failureKey } = recipientKeys(release.version, userHash);
  if (await env.EXTENSIONS.head(sentKey)) {
    if (isRetry) await env.EXTENSIONS.delete(failureKey);
    return;
  }
  try {
    // 相同版本与接收者使用固定消息 UUID，配合 R2 发送标记避免重试重复提醒。
    const uuid = `${userHash.slice(0, 8)}-${userHash.slice(8, 12)}-4${userHash.slice(13, 16)}-a${userHash.slice(17, 20)}-${(await tokenHash(`${release.version}:${userHash}`)).slice(0, 12)}`;
    await sendPrivateMessage(env, recipient.feishuOpenId, releaseMessage(release), uuid);
    await env.EXTENSIONS.put(sentKey, JSON.stringify({ sentAt: new Date().toISOString(), version: release.version }), {
      httpMetadata: { contentType: "application/json" }
    });
    if (isRetry) await env.EXTENSIONS.delete(failureKey);
  } catch (error) {
    await env.EXTENSIONS.put(failureKey, JSON.stringify({ tokenKey, openId: recipient.feishuOpenId, release }), {
      httpMetadata: { contentType: "application/json" }
    });
    console.error("Feishu release announcement failed", release.version, userHash.slice(0, 12), error.message);
  }
}

async function retryFailures(env) {
  const failures = await env.EXTENSIONS.list({ prefix: "auth/notifications/failed/", limit: RETRY_PAGE_SIZE });
  for (const item of failures.objects) {
    const failed = await env.EXTENSIONS.get(item.key);
    if (!failed) continue;
    let data;
    try { data = await failed.json(); } catch { await env.EXTENSIONS.delete(item.key); continue; }
    const release = validRelease(data.release);
    if (!release || !/^auth\/tokens\/[a-f0-9]{64}\.json$/.test(data.tokenKey || "")) {
      await env.EXTENSIONS.delete(item.key);
      continue;
    }
    const tokenObject = await env.EXTENSIONS.get(data.tokenKey);
    if (!tokenObject) { await env.EXTENSIONS.delete(item.key); continue; }
    let recipient;
    try { recipient = await tokenObject.json(); } catch { await env.EXTENSIONS.delete(item.key); continue; }
    if (!activeFeishuRecipient(recipient) || recipient.feishuOpenId !== data.openId) {
      await env.EXTENSIONS.delete(item.key);
      continue;
    }
    await announceTo(env, release, recipient, data.tokenKey, true);
  }
}

// 每分钟只处理一小页。按“版本 + 飞书账号”记录发送结果，历史重复令牌也只提醒一次。
export async function notifyLatestRelease(env) {
  if (!env.EXTENSIONS || !env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return;
  let stateObject = await env.EXTENSIONS.get(STATE_KEY);
  let state = stateObject ? await stateObject.json() : null;
  if (!state || state.done) {
    const releases = await env.EXTENSIONS.list({ prefix: "releases/", limit: 1000 });
    const lastCompletedKey = state?.lastCompletedKey || "";
    const next = releases.objects.find(object =>
      /^releases\/\d{6}-\d{6}-\d{6}\.json$/.test(object.key) && object.key > lastCompletedKey);
    const releaseObject = await env.EXTENSIONS.get(next?.key || "latest.json");
    let release;
    try { release = releaseObject && validRelease(await releaseObject.json()); } catch { /* 忽略损坏的发布记录。 */ }
    if (!release) return;
    if (!next && state?.version === release.version) {
      await retryFailures(env);
      return;
    }
    const nextState = {
      version: release.version, cursor: null, done: false, release,
      releaseKey: next?.key || null, lastCompletedKey
    };
    const written = await env.EXTENSIONS.put(STATE_KEY, JSON.stringify(nextState), {
      onlyIf: stateObject ? { etagMatches: stateObject.etag } : new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" }
    });
    if (!written) return;
    stateObject = written;
    state = nextState;
  }

  const page = await env.EXTENSIONS.list({ prefix: TOKEN_PREFIX, limit: PAGE_SIZE,
    ...(state.cursor ? { cursor: state.cursor } : {}) });
  for (const object of page.objects) {
    if (!/^auth\/tokens\/[a-f0-9]{64}\.json$/.test(object.key)) continue;
    const tokenObject = await env.EXTENSIONS.get(object.key);
    if (!tokenObject) continue;
    let recipient;
    try { recipient = await tokenObject.json(); } catch { continue; }
    if (!activeFeishuRecipient(recipient)) continue;
    await announceTo(env, state.release, recipient, object.key);
  }

  await env.EXTENSIONS.put(STATE_KEY, JSON.stringify({
    ...state, cursor: page.truncated ? page.cursor : null, done: !page.truncated,
    lastCompletedKey: page.truncated ? state.lastCompletedKey : state.releaseKey || state.lastCompletedKey
  }), { onlyIf: { etagMatches: stateObject.etag }, httpMetadata: { contentType: "application/json" } });
}
