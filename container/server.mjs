#!/usr/bin/env node
/**
 * Pi HTTP/SSE sidecar. Skills are a first-class primitive on this box.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { publicSkill } from "./skills.mjs";
import { handleVaultHttp, VAULT_ROUTES, vaultPublicStatus } from "./vault.mjs";
import { handleBrowserHttp, browserPublicStatus } from "./browser.mjs";
import { handlePluginsHttp } from "./plugins.mjs";
import { handleSnapshotHttp } from "./snapshot.mjs";
import { handleGoogleOAuthHttp } from "./google-oauth.mjs";
import { handleApprovalsHttp } from "./approvals.mjs";
import { handleAttachmentHttp } from "./attachments.mjs";
import { handleCardsHttp } from "./cards.mjs";
import { MAX_CHAT_BODY, parseChatBody } from "./chat-body.mjs";
import { handleOutboxHttp } from "./outbox.mjs";
import { handleSessionControl } from "./session-control.mjs";
import { openLiveTurn } from "./live-turn.mjs";
import { sealVaultKeyFromEnv } from "./vault.mjs";
import { createAgentRuntime, hasProviderKey } from "./agent.mjs";
import { handleRoutinesProxy, rememberRoutinesRoute, sealInternalTokenFromEnv } from "./routines-proxy.mjs";

sealVaultKeyFromEnv();
sealInternalTokenFromEnv();

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";
const BOX_ID = process.env.PI_BOX_ID || "local";
const BOX_NAME = process.env.PI_BOX_NAME || "this machine";
const DEFAULT_MODEL = process.env.PI_MODEL || "openrouter/z-ai/glm-5.3-flash";

const runtime = createAgentRuntime();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function thisBox() {
  return {
    id: BOX_ID,
    name: BOX_NAME,
    kind: runtime.capabilities()?.cloud ? "cloudflare" : "machine",
    platform: runtime.capabilities()?.platform || process.platform,
    capabilities: runtime.capabilities(),
    vault: vaultPublicStatus(),
    browser: browserPublicStatus(),
    skills: runtime.catalog().map(publicSkill),
  };
}

function readRaw(req, limit = MAX_CHAT_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (chunk) => {
      n += chunk.length;
      if (n > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  rememberRoutinesRoute(req);
  if (await handleRoutinesProxy(req, res, url)) return;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-pi-box-session, x-pi-box-token, x-pi-box-internal",
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (await handleSnapshotHttp(req, res, url)) return;
  if (await handleGoogleOAuthHttp(req, res, url)) return;
  if (await handleApprovalsHttp(req, res, url)) return;
  if (await handleCardsHttp(req, res, url)) return;
  if (await handleAttachmentHttp(req, res, url, { cwd: process.env.PI_CWD || "/workspace" })) return;
  if (await handleOutboxHttp(req, res, url)) return;
  if (await handleSessionControl(req, res, url, runtime)) return;
  if (VAULT_ROUTES && (await handleVaultHttp(req, res, url))) return;
  if (await handlePluginsHttp(req, res, url)) return;
  if (await handleBrowserHttp(req, res, url)) return;

  if (!runtime.capabilities()) await runtime.refreshCatalog();

  if (url.pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      pi: Boolean(await runtime.loadPi()),
      mock: !hasProviderKey() || Boolean(runtime.piLoadError()),
      model: DEFAULT_MODEL,
      box: thisBox(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    json(res, 200, {
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
      authRequired: Boolean(process.env.CLERK_SECRET_KEY),
      passwordRequired: Boolean(process.env.PI_BOX_PASSWORD),
      googleOAuth: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
      ),
      pushPublicKey: process.env.VAPID_PUBLIC_KEY || "",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    await runtime.refreshCatalog();
    json(res, 200, { skills: runtime.catalog().map(publicSkill) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/boxes") {
    await runtime.refreshCatalog();
    json(res, 200, { boxes: [thisBox()] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let raw;
    try {
      raw = await readRaw(req);
    } catch (err) {
      json(res, err.status || 400, { error: err.status === 413 ? "body too large" : "invalid body" });
      return;
    }
    const sessionHint =
      url.searchParams.get("session") || req.headers["x-pi-box-session"] || "";
    const parsed = parseChatBody(raw, req.headers["content-type"] || "", { sessionId: sessionHint });
    if (!parsed.ok) {
      json(res, parsed.status || 400, { error: parsed.error || "invalid body" });
      return;
    }
    const message = parsed.message;
    const sessionId = sessionHint || parsed.session || randomUUID();

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-pi-box-session": String(sessionId),
    });

    const turn = openLiveTurn(String(sessionId), (event, data) => sseWrite(res, event, data));
    // Response close covers the client hanging up. Request close also fires
    // once the POST body is read, which is still during the turn.
    res.on("close", () => turn.disconnect());
    try {
      await runtime.runTurn({
        sessionId: String(sessionId),
        message,
        attachments: parsed.attachments,
        emit: (event, data) => sseWrite(res, event, data),
      });
    } catch (err) {
      console.error("[pi-box] chat failed", err);
      sseWrite(res, "error", { message: err?.message || String(err) });
      sseWrite(res, "done", { error: true });
    } finally {
      turn.close();
    }
    res.end();
    return;
  }

  json(res, 404, { error: "not found" });
});

runtime
  .refreshCatalog()
  .then(() => {
    const catalog = runtime.catalog();
    const live = catalog.filter((s) => s.available).map((s) => s.name);
    console.log(
      `[pi-box] skills: ${catalog.map((s) => s.name).join(", ") || "(none)"} (live: ${live.join(", ") || "none"})`,
    );
  })
  .catch((err) => console.warn("[pi-box] skill index failed", err));

server.listen(PORT, HOST, () => {
  console.log(`[pi-box] agent listening on http://${HOST}:${PORT}`);
});
