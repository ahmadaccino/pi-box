const OAUTH_COOKIE = "pi_box_oauth_nonce";

export const GOOGLE_PLUGINS = ["gmail", "google-calendar"] as const;
export type GooglePlugin = (typeof GOOGLE_PLUGINS)[number];

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function timingSafeEqual(a: string, b: string): boolean {
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

export function googleConfigured(env: {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}): boolean {
  return Boolean(
    String(env.GOOGLE_CLIENT_ID || "").trim() &&
      String(env.GOOGLE_CLIENT_SECRET || "").trim(),
  );
}

export function oauthSecret(env: {
  GOOGLE_CLIENT_SECRET?: string;
  GATEWAY_TOKEN?: string;
  PI_BOX_PASSWORD?: string;
}): string {
  return (
    String(env.GOOGLE_CLIENT_SECRET || "").trim() ||
    String(env.GATEWAY_TOKEN || "").trim() ||
    String(env.PI_BOX_PASSWORD || "").trim() ||
    "dev-oauth"
  );
}

export function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/oauth/google/callback`;
}

export function mintCdpUrl(env: {
  BROWSER?: unknown;
  CLOUDFLARE_ACCOUNT_ID?: string;
}): string {
  if (!env.BROWSER) return "";
  const account =
    env.CLOUDFLARE_ACCOUNT_ID || "096fdb50629de275e5a7e57b33b811ad";
  return `wss://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/devtools/browser?keep_alive=600000`;
}

export function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

function cookieFlags(request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function nonceCookie(request: Request, nonce: string, maxAge = 15 * 60): string {
  return `${OAUTH_COOKIE}=${nonce}; ${cookieFlags(request, maxAge)}`;
}

export function clearNonceCookie(request: Request): string {
  return `${OAUTH_COOKIE}=; ${cookieFlags(request, 0)}`;
}

export async function mintOAuthState(opts: {
  plugin: string;
  userId: string;
  secret: string;
}): Promise<{ state: string; nonce: string }> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = `v1|${opts.plugin}|${opts.userId}|${exp}|${nonce}`;
  const mac = await hmacHex(opts.secret, payload);
  return { state: `${payload}|${mac}`, nonce };
}

export async function verifyOAuthState(opts: {
  state: string | null;
  nonce: string;
  secret: string;
}): Promise<{ plugin: GooglePlugin; userId: string } | null> {
  const parts = String(opts.state || "").split("|");
  if (parts.length !== 6 || parts[0] !== "v1") return null;
  const [, plugin, userId, expStr, stateNonce, mac] = parts;
  if (!GOOGLE_PLUGINS.includes(plugin as GooglePlugin)) return null;
  const exp = Number(expStr);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  if (!opts.nonce || !timingSafeEqual(opts.nonce, stateNonce)) return null;
  const payload = `v1|${plugin}|${userId}|${expStr}|${stateNonce}`;
  const expected = await hmacHex(opts.secret, payload);
  if (!timingSafeEqual(mac, expected)) return null;
  return { plugin: plugin as GooglePlugin, userId };
}

export function googleAuthorizeUrl(opts: {
  clientId: string;
  redirect: string;
  state: string;
}): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", opts.state);
  return u.toString();
}

export async function exchangeGoogleCode(opts: {
  code: string;
  redirect: string;
  clientId: string;
  clientSecret: string;
}): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirect,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) {
    throw new Error("token exchange failed");
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || "",
    expires_at: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
}
