/**
 * Google OAuth start/callback for the sidecar (local npm run dev).
 * Production Worker (src/oauth.ts) is the public URL path.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export const OAUTH_COOKIE = "pi_box_oauth_nonce";
export const GOOGLE_PLUGINS = ["gmail", "google-calendar"];

function hmacHex(secret, msg) {
  return createHmac("sha256", secret).update(msg).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

export function oauthSecret(env = process.env) {
  return (
    String(env.GOOGLE_CLIENT_SECRET || "").trim() ||
    String(env.GATEWAY_TOKEN || "").trim() ||
    String(env.PI_BOX_PASSWORD || "").trim() ||
    "dev-oauth"
  );
}

export function googleConfigured(env = process.env) {
  return Boolean(
    String(env.GOOGLE_CLIENT_ID || "").trim() &&
      String(env.GOOGLE_CLIENT_SECRET || "").trim(),
  );
}

export function redirectUri(requestUrl) {
  const u = new URL(requestUrl);
  return `${u.origin}/api/oauth/google/callback`;
}

export function mintOAuthState({ plugin, userId, secret }) {
  const nonce = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = `v1|${plugin}|${userId}|${exp}|${nonce}`;
  const mac = hmacHex(secret, payload);
  return { state: `${payload}|${mac}`, nonce, exp };
}

export function verifyOAuthState({ state, nonce, secret }) {
  const parts = String(state || "").split("|");
  if (parts.length !== 6 || parts[0] !== "v1") return null;
  const [v, plugin, userId, expStr, stateNonce, mac] = parts;
  if (v !== "v1") return null;
  if (!GOOGLE_PLUGINS.includes(plugin)) return null;
  const exp = Number(expStr);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  if (!nonce || !safeEqual(nonce, stateNonce)) return null;
  const payload = `${v}|${plugin}|${userId}|${expStr}|${stateNonce}`;
  if (!safeEqual(mac, hmacHex(secret, payload))) return null;
  return { plugin, userId };
}

export function nonceCookie(nonce, requestUrl, maxAgeSec = 15 * 60) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${OAUTH_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearNonceCookie(requestUrl) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

export function googleAuthorizeUrl({ clientId, redirect, state }) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeGoogleCode({ code, redirect, env = process.env }) {
  const body = new URLSearchParams({
    code: String(code || ""),
    client_id: String(env.GOOGLE_CLIENT_ID || ""),
    client_secret: String(env.GOOGLE_CLIENT_SECRET || ""),
    redirect_uri: redirect,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error("token exchange failed");
    err.code = "exchange-failed";
    throw err;
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || "",
    expires_at: Date.now() + Number(json.expires_in || 3600) * 1000,
    token_type: json.token_type || "Bearer",
    id_token: json.id_token || "",
  };
}

export async function upsertGoogleGrant(tokens, saveOAuthToken) {
  const email = tokens.email || (await googleEmail(tokens.access_token));
  const secretFields = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  };
  const account = { provider: "google", email: email || undefined };
  const items = [];
  for (const plugin of GOOGLE_PLUGINS) {
    items.push(
      await saveOAuthToken({
        plugin,
        secretFields,
        account,
        label: plugin,
      }),
    );
  }
  return { ok: true, items, email: email || null };
}

function json(res, code, body, headers = {}) {
  const h = { "content-type": "application/json; charset=utf-8", ...headers };
  res.writeHead(code, h);
  res.end(JSON.stringify(body));
}

export async function handleGoogleOAuthHttp(req, res, url, { userId } = {}) {
  const p = (url.pathname || "/").replace(/\/+$/, "") || "/";
  if (!p.startsWith("/api/oauth/google/")) return false;
  const env = process.env;
  if (!googleConfigured(env)) {
    json(res, 503, { error: "google oauth unset" });
    return true;
  }
  const method = (req.method || "GET").toUpperCase();
  if (p === "/api/oauth/google/start" && method === "GET") {
    const plugin = url.searchParams.get("plugin") || "gmail";
    if (!GOOGLE_PLUGINS.includes(plugin)) {
      json(res, 400, { error: "plugin must be gmail or google-calendar" });
      return true;
    }
    const secret = oauthSecret(env);
    const minted = mintOAuthState({
      plugin,
      userId: userId || "default",
      secret,
    });
    const redirect = redirectUri(url.origin ? url.href : `http://127.0.0.1${url.pathname}`);
    const origin = `${url.protocol}//${url.host}`;
    const redir = redirectUri(origin + "/");
    const loc = googleAuthorizeUrl({
      clientId: env.GOOGLE_CLIENT_ID,
      redirect: redir,
      state: minted.state,
    });
    res.writeHead(302, {
      location: loc,
      "set-cookie": nonceCookie(minted.nonce, origin + "/"),
    });
    res.end();
    return true;
  }
  if (p === "/api/oauth/google/callback" && method === "GET") {
    const origin = `${url.protocol}//${url.host}`;
    const nonce = readCookie(req.headers.cookie, OAUTH_COOKIE);
    const checked = verifyOAuthState({
      state: url.searchParams.get("state"),
      nonce,
      secret: oauthSecret(env),
    });
    if (!checked) {
      json(res, 400, { error: "invalid oauth state" }, {
        "set-cookie": clearNonceCookie(origin + "/"),
      });
      return true;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      json(res, 400, { error: "missing code" });
      return true;
    }
    try {
      const tokens = await exchangeGoogleCode({
        code,
        redirect: redirectUri(origin + "/"),
        env,
      });
      const { saveOAuthToken } = await import("./vault.mjs");
      await upsertGoogleGrant(tokens, saveOAuthToken);
      res.writeHead(302, {
        location: "/plugins?google=connected",
        "set-cookie": clearNonceCookie(origin + "/"),
      });
      res.end();
    } catch {
      json(res, 502, { error: "token exchange failed" });
    }
    return true;
  }
  return false;
}

export async function googleEmail(accessToken) {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json().catch(() => ({}));
    return json.email || null;
  } catch {
    return null;
  }
}
