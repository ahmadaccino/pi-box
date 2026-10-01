/**
 * VAPID Web Push (RFC 8291 aes128gcm). Used by the Worker when a turn finishes
 * or a card is waiting and the tab is not the thing holding the SSE stream open.
 */
import type { PushNote, PushSubscriptionRecord } from "./push.ts";

type PushEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

function bytesOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"));
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function uint32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export async function encryptPushPayload(
  subscription: { keys: { p256dh: string; auth: string } },
  payload: Uint8Array,
  recordSize = 4096,
): Promise<Uint8Array> {
  const userPublic = base64UrlToBytes(subscription.keys.p256dh);
  const userAuth = base64UrlToBytes(subscription.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const remote = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, local.privateKey, 256),
  );
  const authInfo = concat([bytesOf("WebPush: info\0"), userPublic, localPublic]);
  const ikm = await hkdf(userAuth, shared, authInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await hkdf(salt, ikm, bytesOf("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, bytesOf("Content-Encoding: nonce\0"), 12);
  const padLength = Math.max(0, recordSize - payload.length - 16 - 1);
  const padded = concat([payload, new Uint8Array([2]), new Uint8Array(padLength)]);
  const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));
  return concat([salt, uint32be(recordSize), new Uint8Array([localPublic.length]), localPublic, cipher]);
}

async function vapidJwt(audience: string, subject: string, publicKey: string, privateKey: string): Promise<string> {
  const pub = base64UrlToBytes(publicKey);
  const priv = base64UrlToBytes(privateKey);
  const x = bytesToBase64Url(pub.slice(1, 33));
  const y = bytesToBase64Url(pub.slice(33, 65));
  const d = bytesToBase64Url(priv);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = bytesToBase64Url(bytesOf(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToBase64Url(
    bytesOf(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject })),
  );
  const unsigned = `${header}.${body}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytesOf(unsigned)),
  );
  return `${unsigned}.${bytesToBase64Url(sig)}`;
}

export async function sendWebPush(
  env: PushEnv,
  subs: PushSubscriptionRecord[],
  note: PushNote,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; skipped?: string }> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return { sent: 0, skipped: "vapid unset" };
  }
  const payload = bytesOf(JSON.stringify({ title: note.title, body: note.body, tag: note.tag }));
  const subject = env.VAPID_SUBJECT || "mailto:pi-box@localhost";
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        const body = await encryptPushPayload(sub, payload);
        const aud = new URL(sub.endpoint).origin;
        const jwt = await vapidJwt(aud, subject, env.VAPID_PUBLIC_KEY || "", env.VAPID_PRIVATE_KEY || "");
        const res = await fetchImpl(sub.endpoint, {
          method: "POST",
          headers: {
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: "60",
            authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
          },
          body,
        });
        if (res.ok || res.status === 201 || res.status === 202) sent += 1;
      } catch {
        /* one bad endpoint does not block the others */
      }
    }),
  );
  return { sent };
}
