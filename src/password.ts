const COOKIE = "pi_box_auth";

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = bytes(a);
  const bb = bytes(b);
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, bytes(msg));
  return hex(mac);
}

export async function mintAuthCookie(
  secret: string,
  request: Request,
  maxAgeSec = 60 * 60 * 24 * 30,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec;
  const mac = await hmacHex(secret, `v1|${exp}`);
  const value = `v1.${exp}.${mac}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearAuthCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

export async function verifyAuthCookie(
  request: Request,
  secret: string,
): Promise<boolean> {
  const value = readCookie(request, COOKIE);
  const m = /^v1\.(\d+)\.([0-9a-f]+)$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(secret, `v1|${exp}`);
  return timingSafeEqual(m[2], expected);
}

export function sanitizeSession(raw: string | null): string {
  const cleaned = String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned || "default";
}
