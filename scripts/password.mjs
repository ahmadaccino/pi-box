import { createHmac, timingSafeEqual as tse } from "node:crypto";

export const COOKIE = "pi_box_auth";

function hmacHex(secret, msg) {
  return createHmac("sha256", secret).update(msg).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return tse(aa, bb);
}

export function checkPassword(given, secret) {
  if (!secret) return false;
  return safeEqual(given, secret);
}

export function mintAuthCookie(secret, { https = false, maxAgeSec = 60 * 60 * 24 * 30 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec;
  const value = `v1.${exp}.${hmacHex(secret, `v1|${exp}`)}`;
  const secure = https ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearAuthCookie({ https = false } = {}) {
  const secure = https ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

export function verifyAuthCookie(header, secret) {
  if (!secret) return true;
  const value = readCookie(header, COOKIE);
  const m = /^v1\.(\d+)\.([0-9a-f]+)$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(m[2], hmacHex(secret, `v1|${exp}`));
}
