/**
 * Decide when a background tab should surface a notification.
 * The desktop app and the browser share this payload.
 */

const WAITING = new Set(["approval", "draft", "question"]);
const FINISHED = new Set(["done", "routine"]);

export function backgroundNotice({ hidden, unfocused, kind, title, body, tag } = {}) {
  if (!hidden && !unfocused) return null;
  if (!WAITING.has(kind) && !FINISHED.has(kind)) return null;
  return {
    title: String(title || "pi-box").slice(0, 120),
    body: String(body || "").slice(0, 240),
    tag: String(tag || kind || "pi-box").slice(0, 80),
  };
}

export function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
