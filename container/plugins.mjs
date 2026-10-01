/**
 * Agent plugin packs: catalog, authenticate URLs, allowlisted proxy.
 * Tokens stay in the vault and never enter model context or JSON responses.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPluginCall, publishApproval } from "./actions.mjs";
import { getApprovalGate } from "./approvals.mjs";
import { emitLive } from "./live-turn.mjs";
import { fileDraft, setOutboxSender } from "./outbox.mjs";
import { createSetupToken } from "./vault.mjs";
import {
  getOAuthToken,
  hasOAuthToken,
  saveOAuthToken,
  touchOAuthToken,
} from "./vault.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const GOOGLE_PLUGINS = Object.freeze(["gmail", "google-calendar"]);

const DEFAULT_ALLOWLIST = Object.freeze({
  gmail: ["gmail.googleapis.com", "www.googleapis.com"],
  "google-calendar": ["www.googleapis.com", "calendar.googleapis.com"],
  telegram: ["api.telegram.org"],
  cloudflare: ["api.cloudflare.com"],
});

const AUTH_KIND = Object.freeze({
  gmail: "google",
  "google-calendar": "google",
  telegram: "vault",
  cloudflare: "vault",
});

export function googleOAuthConfigured(env = process.env) {
  return Boolean(
    String(env.GOOGLE_CLIENT_ID || "").trim() &&
      String(env.GOOGLE_CLIENT_SECRET || "").trim(),
  );
}

export function pluginsRoot() {
  return process.env.PI_PLUGINS_DIR || path.join(here, "..", "plugins");
}

export function hostnameOf(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function hostAllowed(host, allowlist) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  for (const entry of allowlist || []) {
    const e = String(entry).toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (!e) continue;
    if (h === e) return true;
  }
  return false;
}

export async function loadPluginPacks() {
  const root = pluginsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(
        await readFile(path.join(root, entry.name, "plugin.json"), "utf8"),
      );
      const id = raw.name || entry.name;
      const allowlist = Array.isArray(raw.allowlist)
        ? raw.allowlist
        : DEFAULT_ALLOWLIST[id] || [];
      packs.push({
        id,
        name: raw.name || entry.name,
        description: raw.description || "",
        version: raw.version || null,
        allowlist,
        auth: raw.auth || AUTH_KIND[id] || null,
      });
    } catch {
      /* skip invalid pack */
    }
  }
  packs.sort((a, b) => a.id.localeCompare(b.id));
  return packs;
}

export function allowlistFor(pluginId, packs) {
  const pack = (packs || []).find((p) => p.id === pluginId);
  if (pack?.allowlist?.length) return pack.allowlist;
  return DEFAULT_ALLOWLIST[pluginId] || [];
}

export function isProxyUrlAllowed(pluginId, rawUrl, packs) {
  const host = hostnameOf(rawUrl);
  if (!host) return false;
  return hostAllowed(host, allowlistFor(pluginId, packs));
}

export function pluginAuthenticateUrl(pluginId, env = process.env) {
  const origin = String(env.PI_BOX_PUBLIC_URL || "").replace(/\/$/, "");
  if (GOOGLE_PLUGINS.includes(pluginId) && googleOAuthConfigured(env)) {
    const pathUrl = `/api/oauth/google/start?plugin=${encodeURIComponent(pluginId)}`;
    return { mode: "google", url: origin ? `${origin}${pathUrl}` : pathUrl };
  }
  return { mode: "vault", url: null };
}

export async function authenticatePlugin(pluginId, env = process.env) {
  const planned = pluginAuthenticateUrl(pluginId, env);
  if (planned.mode === "google" && planned.url) {
    return { url: planned.url };
  }
  const created = await createSetupToken({
    kind: "login",
    label: `${pluginId} token`,
    identifierType: "token",
    origin: pluginId,
    target: pluginId,
  });
  return { url: created.url };
}

export async function pluginPublicStatus(pluginId) {
  try {
    const row = await hasOAuthToken(pluginId);
    if (row === "error") return "error";
    if (row) return "connected";
    if (AUTH_KIND[pluginId] || GOOGLE_PLUGINS.includes(pluginId)) return "authenticate";
    return null;
  } catch {
    return "error";
  }
}

export async function listPluginsPublic() {
  const packs = await loadPluginPacks();
  const out = [];
  for (const pack of packs) {
    out.push({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      version: pack.version,
      auth: pack.auth,
      status: await pluginPublicStatus(pack.id),
    });
  }
  return out;
}

function isExpired(expiresAt) {
  if (!expiresAt) return true;
  const t = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(t)) return true;
  return t < Date.now() + 30_000;
}

export async function refreshGoogleAccessToken(pluginId, secrets, env = process.env) {
  const refresh = secrets?.refresh_token;
  if (!refresh) {
    const err = new Error("no refresh token");
    err.code = "no-refresh";
    throw err;
  }
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    const err = new Error("google oauth unset");
    err.code = "no-google-env";
    throw err;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error("refresh failed");
    err.code = "refresh-failed";
    throw err;
  }
  const expiresAt = Date.now() + Number(json.expires_in || 3600) * 1000;
  const next = {
    ...secrets,
    access_token: json.access_token,
    expires_at: expiresAt,
    refresh_token: json.refresh_token || secrets.refresh_token,
  };
  await saveOAuthToken({
    plugin: pluginId,
    secretFields: next,
    account: { provider: "google" },
  });
  if (GOOGLE_PLUGINS.includes(pluginId)) {
    const other = pluginId === "gmail" ? "google-calendar" : "gmail";
    await saveOAuthToken({
      plugin: other,
      secretFields: next,
      account: { provider: "google" },
    });
  }
  return next;
}

async function bearerFor(pluginId) {
  const row = await getOAuthToken(pluginId);
  if (!row?.secrets) return null;
  let secrets = row.secrets;
  if (
    GOOGLE_PLUGINS.includes(pluginId) &&
    (isExpired(secrets.expires_at) || !secrets.access_token)
  ) {
    try {
      secrets = await refreshGoogleAccessToken(pluginId, secrets);
    } catch {
      return { error: "refresh-failed", token: null };
    }
  }
  const token =
    secrets.access_token || secrets.token || secrets.bot_token || secrets.api_token;
  if (!token) return { error: "no-token", token: null };
  return { token, error: null, secrets };
}

const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "authorization",
  "cookie",
  "x-pi-box-token",
  "x-pi-box-internal",
]);

async function executeProxy(pluginId, req, ctx = {}) {
  const packs = ctx.packs || (await loadPluginPacks());
  const pack = packs.find((p) => p.id === pluginId);
  if (!pack && !DEFAULT_ALLOWLIST[pluginId]) {
    return { status: 404, body: { error: "unknown plugin" } };
  }
  const target = String(req?.url || req?.href || "");
  if (!isProxyUrlAllowed(pluginId, target, packs)) {
    return { status: 403, body: { error: "url not allowlisted" } };
  }
  const auth = await bearerFor(pluginId);
  if (!auth || auth.error) {
    return { status: 401, body: { error: "authenticate", code: auth?.error || "no-token" } };
  }
  const method = String(req?.method || "GET").toUpperCase();
  const headers = {};
  if (req?.headers && typeof req.headers === "object") {
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k.toLowerCase())) continue;
      if (v == null) continue;
      headers[k] = String(v);
    }
  }
  let dest = target;
  if (pluginId === "telegram") {
    try {
      const u = new URL(target);
      u.pathname = u.pathname.replace(/^\/bot(?:[^/]*)?/, `/bot${auth.token}`);
      dest = u.toString();
    } catch {
      dest = target;
    }
  } else {
    headers.authorization = `Bearer ${auth.token}`;
  }
  const init = { method, headers };
  if (req?.body != null && method !== "GET" && method !== "HEAD") {
    init.body =
      typeof req.body === "string" || Buffer.isBuffer(req.body)
        ? req.body
        : JSON.stringify(req.body);
    if (!headers["content-type"] && typeof req.body === "object") {
      headers["content-type"] = "application/json";
    }
  }
  const doFetch = ctx.fetch || fetch;
  let res = await doFetch(dest, init);
  if (res.status === 401 && GOOGLE_PLUGINS.includes(pluginId) && auth.secrets) {
    try {
      const next = await refreshGoogleAccessToken(pluginId, auth.secrets);
      headers.authorization = `Bearer ${next.access_token}`;
      res = await doFetch(target, init);
    } catch {
      return { status: 401, body: { error: "authenticate", code: "refresh-failed" } };
    }
  }
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    status: res.status,
    body: { ok: res.ok, status: res.status, data: parsed },
  };
}

function emitCard(ctx, card) {
  const emit = ctx.emit || ((event, data) => emitLive(event, data));
  try {
    emit("card", card);
  } catch {
    /* the chat stream may already be gone */
  }
}

async function holdGmail(pluginId, outbound, req, ctx) {
  let gmailDraftId = "";
  if (outbound.holdSend) {
    if (!outbound.raw) {
      return {
        status: 400,
        body: { error: "gmail send requires a raw message", sent: false, draft: false },
      };
    }
    const created = await executeProxy(
      pluginId,
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
        method: "POST",
        body: { message: { raw: outbound.raw } },
      },
      ctx,
    );
    if (!created.body?.ok) {
      return {
        ...created,
        body: {
          ...created.body,
          sent: false,
          draft: false,
          message:
            "Nothing was sent. Draft creation failed. If Gmail returned 403, reconnect so the grant includes gmail.compose.",
        },
      };
    }
    gmailDraftId = created.body?.data?.id || "";
  } else {
    const created = await executeProxy(pluginId, req, ctx);
    if (!created.body?.ok) {
      return { ...created, body: { ...created.body, sent: false, draft: false } };
    }
    gmailDraftId = created.body?.data?.id || "";
  }
  const filed = fileDraft({ ...outbound, gmailDraftId, fetchImpl: ctx.fetch || null });
  emitCard(ctx, filed.card);
  return { status: 200, body: filed.model };
}

async function holdTelegram(outbound, ctx) {
  const filed = fileDraft({ ...outbound, fetchImpl: ctx.fetch || null });
  emitCard(ctx, filed.card);
  return { status: 200, body: filed.model };
}

export async function proxyPluginRequest(pluginId, req, ctx = {}) {
  const classified = classifyPluginCall(pluginId, req);
  if (!ctx.userAction && classified.kind === "outbound") {
    const packs = ctx.packs || (await loadPluginPacks());
    const target = String(req?.url || req?.href || "");
    if (!isProxyUrlAllowed(pluginId, target, packs)) {
      return { status: 403, body: { error: "url not allowlisted" } };
    }
    const auth = await bearerFor(pluginId);
    if (!auth || auth.error) {
      return { status: 401, body: { error: "authenticate", code: auth?.error || "no-token" } };
    }
    if (classified.outbound.channel === "gmail") return holdGmail(pluginId, classified.outbound, req, ctx);
    if (classified.outbound.channel === "telegram") return holdTelegram(classified.outbound, ctx);
  }
  if (!ctx.userAction && classified.kind === "mutation") {
    const gate = ctx.gate || getApprovalGate();
    const decision = await gate.decide(classified.approval);
    if (decision.decision !== "allow") {
      return {
        status: 403,
        body: {
          error: "denied",
          decision: decision.decision,
          via: decision.via,
          summary: classified.approval.summary,
        },
      };
    }
  }
  return executeProxy(pluginId, req, ctx);
}

setOutboxSender(async (row, op) => {
  const ctx = { userAction: true, fetch: row.fetchImpl || undefined };
  if (op === "discard") {
    if (row.channel === "gmail" && row.gmailDraftId) {
      return executeProxy(
        "gmail",
        {
          url: `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(row.gmailDraftId)}`,
          method: "DELETE",
        },
        ctx,
      );
    }
    return { status: 200, body: { ok: true, discarded: true, sent: false } };
  }
  if (row.channel === "gmail") {
    const upstream = row.gmailDraftId
      ? {
          url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
          method: "POST",
          body: { id: row.gmailDraftId },
        }
      : {
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          method: "POST",
          body: { raw: row.raw },
        };
    return executeProxy("gmail", upstream, ctx);
  }
  if (row.channel === "telegram" && row.request) {
    return executeProxy("telegram", row.request, ctx);
  }
  return { status: 400, body: { error: "unknown draft", sent: false } };
});

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function matchPluginPath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/api/plugins") return { op: "list" };
  const m = p.match(/^\/api\/plugins\/([^/]+)(?:\/(authenticate|proxy|publish))?$/);
  if (!m) return null;
  return { op: m[2] || "one", id: decodeURIComponent(m[1]) };
}

export async function handlePluginsHttp(req, res, url) {
  const matched = matchPluginPath(url.pathname);
  if (!matched) return false;
  const method = (req.method || "GET").toUpperCase();
  try {
    if (matched.op === "list" && method === "GET") {
      json(res, 200, { plugins: await listPluginsPublic() });
      return true;
    }
    if (matched.op === "authenticate" && method === "POST") {
      const out = await authenticatePlugin(matched.id);
      json(res, 200, out);
      return true;
    }
    if (matched.op === "proxy" && method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { error: "invalid json" });
        return true;
      }
      const out = await proxyPluginRequest(matched.id, body);
      json(res, out.status, out.body);
      return true;
    }
    if (matched.op === "publish" && matched.id === "cloudflare" && method === "POST") {
      const { publishSite } = await import("./cloudflare-publish.mjs");
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { error: "invalid json" });
        return true;
      }
      const decision = await getApprovalGate().decide(publishApproval(body || {}));
      if (decision.decision !== "allow") {
        json(res, 403, { error: "denied", decision: decision.decision, via: decision.via });
        return true;
      }
      const out = await publishSite(body || {});
      json(res, out.status, out.body);
      return true;
    }
    if (matched.op === "one" && method === "GET") {
      const packs = await loadPluginPacks();
      const pack = packs.find((p) => p.id === matched.id);
      if (!pack) {
        json(res, 404, { error: "unknown plugin" });
        return true;
      }
      json(res, 200, { ...pack, status: await pluginPublicStatus(pack.id) });
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  } catch (err) {
    json(res, 500, { error: err?.message || "plugin error" });
    return true;
  }
}

export { touchOAuthToken };
