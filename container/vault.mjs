/**
 * pi-box vault: AES-256-GCM secrets at rest. Models never see passwords or cards.
 *
 * One-box-one-user for now. Clerk per-user scoping can land later without
 * changing list/fill contracts (scope items by userId at the store boundary).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VAULT_ROUTES = true;
export const KINDS = Object.freeze(["login", "payment", "address", "contact"]);

/** 32 zero bytes, base64. LOCAL DEV ONLY — production MUST set VAULT_ENCRYPTION_KEY. */
const LOCAL_DEV_NOT_FOR_PRODUCTION_KEY_B64 =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_FIELD = 512;

let warnedLocalKey = false;

function vaultRoot() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent";
  return path.join(agentDir, "vault");
}

function itemsFile() {
  return path.join(vaultRoot(), "items.json");
}

function tokensFile() {
  return path.join(vaultRoot(), "setup-tokens.json");
}

function oauthFile() {
  return path.join(vaultRoot(), "oauth.json");
}

export function loadEncryptionKey() {
  const raw = (process.env.VAULT_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    const key = Buffer.from(LOCAL_DEV_NOT_FOR_PRODUCTION_KEY_B64, "base64");
    if (!warnedLocalKey) {
      warnedLocalKey = true;
      console.warn(
        "[pi-box] VAULT_ENCRYPTION_KEY unset; using LOCAL-DEV-ONLY all-zero key. NOT FOR PRODUCTION.",
      );
    }
    return { key, localDev: true, error: null };
  }
  let key;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return {
      key: null,
      localDev: false,
      error: "VAULT_ENCRYPTION_KEY is not valid base64",
    };
  }
  if (key.length !== 32) {
    return {
      key: null,
      localDev: false,
      error: "VAULT_ENCRYPTION_KEY must be 32-byte base64",
    };
  }
  return { key, localDev: false, error: null };
}

export function isVaultAvailable() {
  const { key, error } = loadEncryptionKey();
  if (error || !key || key.length !== 32) return false;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.update("ok", "utf8");
    cipher.final();
    cipher.getAuthTag();
    return true;
  } catch {
    return false;
  }
}

export function vaultSkillRequires() {
  return ["vault"];
}

export function vaultPublicStatus() {
  return {
    available: isVaultAvailable(),
    itemCount: readItemsSyncSafe().length,
  };
}

function readItemsSyncSafe() {
  try {
    if (!existsSync(itemsFile())) return [];
    const parsed = JSON.parse(readFileSync(itemsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function ensureDir() {
  await mkdir(vaultRoot(), { recursive: true, mode: 0o700 });
}

async function writeJsonAtomic(file, data) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

async function loadItems() {
  try {
    const parsed = JSON.parse(await readFile(itemsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadTokens() {
  try {
    const parsed = JSON.parse(await readFile(tokensFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadOAuthRows() {
  try {
    const parsed = JSON.parse(await readFile(oauthFile(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicOAuthRow(row) {
  return {
    plugin: row.plugin,
    label: row.label || row.plugin,
    account: row.account || {},
    connected: Boolean(row.ciphertext),
    expiresAt: row.expiresAt || null,
  };
}

export async function hasOAuthToken(plugin) {
  const id = cleanString(plugin, 64);
  if (!id) return false;
  const rows = await loadOAuthRows();
  const row = rows.find((r) => r.plugin === id);
  if (!row?.ciphertext) return false;
  const { key, error } = loadEncryptionKey();
  if (error || !key) return "error";
  try {
    decryptJson(row.ciphertext, key);
    return true;
  } catch {
    return "error";
  }
}

export async function getOAuthToken(plugin) {
  const id = cleanString(plugin, 64);
  const { key, error } = loadEncryptionKey();
  if (error || !key) return null;
  const rows = await loadOAuthRows();
  const row = rows.find((r) => r.plugin === id);
  if (!row?.ciphertext) return null;
  try {
    const secrets = decryptJson(row.ciphertext, key);
    return { plugin: id, account: row.account || {}, secrets };
  } catch {
    return null;
  }
}

export async function saveOAuthToken({
  plugin,
  secretFields,
  account,
  label,
} = {}) {
  const { key, error } = loadEncryptionKey();
  if (error || !key) {
    const err = new Error(error || "vault unavailable");
    err.code = "unavailable";
    throw err;
  }
  const id = cleanString(plugin, 64);
  if (!id) {
    const err = new Error("plugin required");
    err.code = "no-plugin";
    throw err;
  }
  const secrets = stringMap(secretFields);
  if (secretFields && typeof secretFields === "object") {
    for (const [k, v] of Object.entries(secretFields)) {
      if (v == null || v === "") continue;
      if (typeof v === "number") secrets[k] = v;
      else if (typeof v === "string") secrets[k] = cleanString(v, 4096);
    }
  }
  if (!Object.keys(secrets).length) {
    const err = new Error("secretFields required");
    err.code = "no-secrets";
    throw err;
  }
  const expiresAt =
    secrets.expires_at != null
      ? Number(secrets.expires_at)
      : null;
  const ciphertext = encryptJson(secrets, key);
  const rows = await loadOAuthRows();
  const now = new Date().toISOString();
  const next = {
    plugin: id,
    label: cleanString(label, 128) || id,
    account: stringMap(account),
    ciphertext,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    updatedAt: now,
  };
  const idx = rows.findIndex((r) => r.plugin === id);
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  await writeJsonAtomic(oauthFile(), rows);
  return publicOAuthRow(next);
}

export async function touchOAuthToken(plugin) {
  return hasOAuthToken(plugin);
}

export async function listOAuthPublic() {
  const rows = await loadOAuthRows();
  return rows.map(publicOAuthRow);
}

export function encryptJson(obj, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(obj), "utf8");
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptJson(blob, key) {
  if (!blob || blob.alg !== "aes-256-gcm") {
    throw new Error("unsupported ciphertext");
  }
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const data = Buffer.from(blob.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function cleanString(value, max = MAX_FIELD) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function cleanKind(kind) {
  const k = cleanString(kind, 32).toLowerCase();
  return KINDS.includes(k) ? k : null;
}

function stringMap(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== "string" || k.length > 64) continue;
    if (v == null || v === "") continue;
    if (typeof v === "object") continue;
    out[k] = cleanString(v);
  }
  return out;
}

function cardBrand(num) {
  const d = String(num || "").replace(/\D/g, "");
  if (d.startsWith("4")) return "visa";
  if (d.startsWith("5")) return "mastercard";
  if (d.startsWith("34") || d.startsWith("37")) return "amex";
  if (d.startsWith("6")) return "discover";
  return "card";
}

function last4(num) {
  const d = String(num || "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}

function accountMetadata(kind, account, secretFields) {
  const src = account && typeof account === "object" ? account : {};
  if (kind === "login") {
    return {
      origin: cleanString(src.origin, 256) || null,
      identifierType: cleanString(src.identifierType, 32) || null,
      identifier: cleanString(src.identifier || secretFields.identifier, 256) || null,
    };
  }
  if (kind === "payment") {
    const number = secretFields.cardNumber || secretFields.number || "";
    return {
      brand: cleanString(src.brand, 32) || cardBrand(number),
      last4: cleanString(src.last4, 4) || last4(number) || null,
    };
  }
  if (kind === "address") {
    return {
      city: cleanString(src.city || secretFields.city, 128) || null,
      region: cleanString(src.region || secretFields.region, 128) || null,
      country: cleanString(src.country || secretFields.country, 64) || null,
    };
  }
  if (kind === "contact") {
    return {
      name: cleanString(src.name || secretFields.name, 128) || null,
    };
  }
  return {};
}

function toPublicItem(item) {
  return {
    handle: item.handle,
    kind: item.kind,
    label: item.label,
    account: item.account || {},
    available: Boolean(item.ciphertext),
  };
}

function isHighSecretKey(name) {
  const n = String(name || "").toLowerCase();
  return n === "password" || n === "cardnumber" || n === "cvc" || n === "cvv" || n === "number" || n === "pan" || n.includes("pass") || n.includes("secret");
}

function ciphertextLooksPlain(item, secrets) {
  const publicDump = JSON.stringify({ ...item, ciphertext: undefined });
  for (const [k, value] of Object.entries(secrets)) {
    if (!isHighSecretKey(k)) continue;
    if (value && String(value).length >= 4 && publicDump.includes(String(value))) {
      return true;
    }
  }
  return false;
}

export async function listItems() {
  const items = await loadItems();
  return items.map(toPublicItem);
}

export async function createSetupToken({
  kind,
  label,
  identifierType,
  origin,
  target,
} = {}) {
  const k = cleanKind(kind);
  if (!k) {
    const err = new Error("invalid kind");
    err.code = "invalid-kind";
    throw err;
  }
  const token = randomBytes(24).toString("base64url");
  const tokens = await loadTokens();
  const now = Date.now();
  for (const [id, row] of Object.entries(tokens)) {
    if (row?.expiresAt && Date.parse(row.expiresAt) < now) delete tokens[id];
  }
  tokens[token] = {
    kind: k,
    label: cleanString(label, 128) || k,
    identifierType: cleanString(identifierType, 32) || null,
    origin: cleanString(origin, 256) || null,
    target: cleanString(target, 256) || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  };
  await writeJsonAtomic(tokensFile(), tokens);
  const pathUrl = `/vault?setup=${encodeURIComponent(token)}`;
  const base = (process.env.PI_BOX_PUBLIC_URL || "").replace(/\/$/, "");
  return { url: base ? `${base}${pathUrl}` : pathUrl, token };
}

export async function peekSetupToken(token) {
  if (!token) return null;
  const tokens = await loadTokens();
  const row = tokens[String(token)];
  if (!row) return null;
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) return null;
  return {
    kind: row.kind,
    label: row.label,
    identifierType: row.identifierType,
    origin: row.origin,
    target: row.target,
  };
}

async function consumeSetupToken(token) {
  if (!token) return null;
  const tokens = await loadTokens();
  const row = tokens[String(token)];
  if (!row) return null;
  delete tokens[String(token)];
  await writeJsonAtomic(tokensFile(), tokens);
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) return null;
  return row;
}

export async function saveItem({ kind, label, account, secretFields, token } = {}) {
  const { key, error } = loadEncryptionKey();
  if (error || !key) {
    const err = new Error(error || "vault unavailable");
    err.code = "unavailable";
    throw err;
  }

  let setup = null;
  if (token) setup = await consumeSetupToken(token);

  const k = cleanKind(kind) || cleanKind(setup?.kind);
  if (!k) {
    const err = new Error("invalid kind");
    err.code = "invalid-kind";
    throw err;
  }

  const secrets = stringMap(secretFields);
  if (!Object.keys(secrets).length) {
    const err = new Error("secretFields required");
    err.code = "no-secrets";
    throw err;
  }

  const itemLabel =
    cleanString(label, 128) ||
    cleanString(setup?.label, 128) ||
    k;
  const mergedAccount = {
    origin: account?.origin || setup?.origin,
    identifierType: account?.identifierType || setup?.identifierType,
    identifier: account?.identifier,
    brand: account?.brand,
    last4: account?.last4,
    city: account?.city,
    region: account?.region,
    country: account?.country,
    name: account?.name,
  };

  const ciphertext = encryptJson(secrets, key);
  const id = randomUUID();
  const item = {
    id,
    handle: `vlt_${id.replace(/-/g, "").slice(0, 20)}`,
    kind: k,
    label: itemLabel,
    account: accountMetadata(k, mergedAccount, secrets),
    ciphertext,
    createdAt: new Date().toISOString(),
  };

  if (ciphertextLooksPlain(item, secrets)) {
    const err = new Error("refusing to persist plaintext secrets");
    err.code = "plaintext";
    throw err;
  }

  const items = await loadItems();
  items.push(item);
  await writeJsonAtomic(itemsFile(), items);

  const pluginTarget = cleanString(setup?.target || account?.origin, 64);
  if (pluginTarget && /^(gmail|google-calendar|telegram|cloudflare)$/.test(pluginTarget)) {
    const token =
      secrets.token ||
      secrets.api_token ||
      secrets.bot_token ||
      secrets.refresh_token ||
      secrets.password ||
      secrets.access_token;
    if (token) {
      await saveOAuthToken({
        plugin: pluginTarget,
        secretFields: {
          token,
          refresh_token: secrets.refresh_token,
          access_token: secrets.access_token || token,
          expires_at: secrets.expires_at,
          bot_token: secrets.bot_token,
          api_token: secrets.api_token,
        },
        account: { origin: pluginTarget },
        label: itemLabel,
      });
    }
  }

  return toPublicItem(item);
}

async function loadFillNative() {
  try {
    const mod = await import("./browser.mjs");
    if (typeof mod.fillNative === "function") return { fillNative: mod.fillNative };
    return { fillNative: null, present: true };
  } catch (err) {
    const missing =
      err?.code === "ERR_MODULE_NOT_FOUND" ||
      /cannot find module|module not found/i.test(String(err?.message || err));
    if (missing) return { fillNative: null, present: false };
    throw err;
  }
}

export async function fillFromVault({ handle, browserSessionId } = {}) {
  const h = cleanString(handle, 80);
  const session = cleanString(browserSessionId, 128);
  if (!h || !session) {
    return { ok: false, code: "bad-args" };
  }

  const { key, error } = loadEncryptionKey();
  if (error || !key) return { ok: false, code: "unavailable" };

  const items = await loadItems();
  const item = items.find((row) => row.handle === h || row.id === h);
  if (!item) return { ok: false, code: "not-found" };

  let claims;
  try {
    claims = decryptJson(item.ciphertext, key);
  } catch {
    return { ok: false, code: "decrypt-failed" };
  }

  let native;
  try {
    native = await loadFillNative();
  } catch {
    return { ok: false, code: "no-browser" };
  }
  if (!native.present) return { ok: false, code: "no-browser" };
  if (!native.fillNative) return { ok: false, code: "no-fillNative" };

  let filledClaims = Object.keys(claims);
  let ok = true;
  try {
    const result = await native.fillNative({
      browserSessionId: session,
      kind: item.kind,
      claims,
    });
    if (result && result.ok === false) ok = false;
    if (Array.isArray(result?.filledClaims)) {
      filledClaims = result.filledClaims.filter((name) => typeof name === "string");
    }
  } catch {
    return { ok: false, code: "fill-failed", kind: item.kind, origin: item.account?.origin || null, filledClaims: [] };
  }

  return {
    ok,
    kind: item.kind,
    origin: item.account?.origin || null,
    filledClaims,
  };
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { code: "too-large" }));
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

async function serveVaultHtml(res) {
  const filePath = path.join(here, "..", "public", "vault.html");
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return true;
  } catch {
    json(res, 404, { error: "vault page missing" });
    return true;
  }
}

function normalizePath(url) {
  return (url.pathname || "/").replace(/\/+$/, "") || "/";
}

export async function handleVaultHttp(req, res, url) {
  const p = normalizePath(url);
  const method = (req.method || "GET").toUpperCase();

  if (method === "GET" && (p === "/vault" || p === "/vault.html")) {
    return serveVaultHtml(res);
  }

  if (method === "GET" && p === "/api/vault") {
    const items = await listItems();
    json(res, 200, { items });
    return true;
  }

  if (method === "GET" && p === "/api/vault/setup-form") {
    const token = url.searchParams.get("setup") || url.searchParams.get("token") || "";
    const row = await peekSetupToken(token);
    if (!row) {
      json(res, 404, { error: "unknown or expired setup token" });
      return true;
    }
    json(res, 200, row);
    return true;
  }

  if (method === "POST" && p === "/api/vault/setup") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      const created = await createSetupToken(body || {});
      json(res, 200, { url: created.url });
      return true;
    } catch (err) {
      json(res, err.code === "invalid-kind" ? 400 : 500, {
        error: err.code === "invalid-kind" ? "invalid kind" : "setup failed",
      });
      return true;
    }
  }

  if (method === "POST" && p === "/api/vault/items") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      const saved = await saveItem(body || {});
      json(res, 200, { ok: true, item: saved });
      return true;
    } catch (err) {
      const code = err.code || "save-failed";
      json(res, code === "unavailable" ? 503 : 400, { error: "save failed", code });
      return true;
    }
  }

  if (method === "POST" && p === "/api/vault/oauth-token") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      const plugins = Array.isArray(body?.plugins)
        ? body.plugins
        : [body?.plugin].filter(Boolean);
      if (!plugins.length) {
        json(res, 400, { error: "plugin required" });
        return true;
      }
      const secretFields = body?.secretFields || {
        refresh_token: body?.refresh_token,
        access_token: body?.access_token,
        expires_at: body?.expires_at,
        token: body?.token,
        bot_token: body?.bot_token,
        api_token: body?.api_token,
      };
      const saved = [];
      for (const plugin of plugins) {
        saved.push(
          await saveOAuthToken({
            plugin,
            secretFields,
            account: body?.account,
            label: body?.label || plugin,
          }),
        );
      }
      json(res, 200, { ok: true, items: saved });
      return true;
    } catch (err) {
      const code = err.code || "save-failed";
      json(res, code === "unavailable" ? 503 : 400, { error: "save failed", code });
      return true;
    }
  }

  if (method === "GET" && p === "/api/vault/oauth-token") {
    const items = await listOAuthPublic();
    json(res, 200, { items });
    return true;
  }

  if (method === "POST" && p === "/api/vault/fill") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    const result = await fillFromVault({
      handle: body?.handle,
      browserSessionId: body?.browserSessionId,
    });
    json(res, result.ok ? 200 : 409, result);
    return true;
  }

  return false;
}
