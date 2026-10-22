import { tokenHash } from "./tokens.js";

const SUBSCRIPTION_PREFIX = "auth/subscriptions/";

export async function subscriptionKey(appId, openId) {
  return `${SUBSCRIPTION_PREFIX}${await tokenHash(`${appId}:${openId}`)}.json`;
}

// 历史令牌持有人未设置过偏好时，沿用原先的默认发送行为。
export async function subscriptionStatus(bucket, appId, openId) {
  const object = await bucket.get(await subscriptionKey(appId, openId));
  if (!object) return true;
  try { return (await object.json()).subscribed === true; }
  catch { return false; }
}

export async function setSubscription(bucket, appId, openId, subscribed, eventId) {
  const key = await subscriptionKey(appId, openId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await bucket.get(key);
    let record = null;
    try { record = previous && await previous.json(); } catch { /* 损坏记录以新选择覆盖。 */ }
    const processedEventIds = Array.isArray(record?.processedEventIds) ? record.processedEventIds : [];
    if (record?.eventId === eventId || processedEventIds.includes(eventId)) return false;
    const written = await bucket.put(key, JSON.stringify({
      openId, subscribed, eventId, updatedAt: new Date().toISOString(),
      processedEventIds: [...processedEventIds, eventId].slice(-20)
    }), {
      onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" }
    });
    if (written) return true;
  }
  throw new Error("subscription_update_conflict");
}
