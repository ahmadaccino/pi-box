#!/usr/bin/env node
/**
 * Pi HTTP/SSE sidecar. Skills are a first-class primitive on this box.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadSkills, annotateAvailability, toPiSkills, publicSkill } from "./skills.mjs";
import { detectCapabilities } from "./host.mjs";
import { handleVaultHttp, VAULT_ROUTES, vaultPublicStatus } from "./vault.mjs";
import { handleBrowserHttp, browserPublicStatus } from "./browser.mjs";
import { handlePluginsHttp } from "./plugins.mjs";
import { handleSnapshotHttp } from "./snapshot.mjs";
import { handleGoogleOAuthHttp } from "./google-oauth.mjs";

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";
const CWD = process.env.PI_CWD || "/workspace";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent";
const BOX_ID = process.env.PI_BOX_ID || "local";
const BOX_NAME = process.env.PI_BOX_NAME || "this machine";
const DEFAULT_MODEL = process.env.PI_MODEL || "openrouter/z-ai/glm-5.3-flash";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const sessions = new Map();
let piMod = null;
let piLoadError = null;
let capabilities = null;
let catalog = [];

function seedAgentDir() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const src = path.join(HERE, "models.json");
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(AGENT_DIR, "models.json"));
  }
  const settingsPath = path.join(AGENT_DIR, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    settings = {};
  }
  settings.defaultProvider = process.env.PI_PROVIDER || "openrouter";
  const raw = DEFAULT_MODEL;
  settings.defaultModel = raw.startsWith("openrouter/")
    ? raw.slice("openrouter/".length)
    : raw;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function refreshCatalog() {
  capabilities = await detectCapabilities();
  const raw = await loadSkills();
  catalog = annotateAvailability(raw, capabilities);
  return catalog;
}

async function loadPi() {
  if (piMod || piLoadError) return piMod;
  try {
    piMod = await import("@earendil-works/pi-coding-agent");
    return piMod;
  } catch (err) {
    piLoadError = err;
    console.warn("[pi-box] Pi SDK not loaded, mock mode:", err?.message || err);
    return null;
  }
}

function hasProviderKey() {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.XAI_API_KEY,
  );
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function diskSessionManager(mod, sessionId) {
  const sessionDir = path.join(AGENT_DIR, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  if (typeof mod.SessionManager?.create !== "function") {
    return mod.SessionManager.inMemory(CWD);
  }
  try {
    if (typeof mod.SessionManager.list === "function") {
      const listed = await mod.SessionManager.list(CWD, sessionDir);
      const found = Array.isArray(listed)
        ? listed.find(
            (s) =>
              s?.id === sessionId ||
              (typeof s?.path === "string" && s.path.includes(sessionId)),
          )
        : null;
      if (found?.path && typeof mod.SessionManager.open === "function") {
        return mod.SessionManager.open(found.path, sessionDir);
      }
    }
    return mod.SessionManager.create(CWD, sessionDir, { id: sessionId });
  } catch {
    return mod.SessionManager.inMemory(CWD);
  }
}

function thisBox() {
  return {
    id: BOX_ID,
    name: BOX_NAME,
    kind: capabilities?.cloud ? "cloudflare" : "machine",
    platform: capabilities?.platform || process.platform,
    capabilities,
    vault: vaultPublicStatus(),
    browser: browserPublicStatus(),
    skills: catalog.map(publicSkill),
  };
}

async function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const mod = await loadPi();
  if (!mod || !hasProviderKey()) {
    const mock = { kind: "mock", id };
    sessions.set(id, mock);
    return mock;
  }
  await refreshCatalog();
  seedAgentDir();
  const modelRuntime = await mod.ModelRuntime.create({
    authPath: path.join(AGENT_DIR, "auth.json"),
    modelsPath: path.join(AGENT_DIR, "models.json"),
    allowModelNetwork: true,
  });
  const resolved = mod.resolveCliModel({
    cliModel: DEFAULT_MODEL.includes("/") && !DEFAULT_MODEL.startsWith("openrouter/")
      ? `openrouter/${DEFAULT_MODEL}`
      : DEFAULT_MODEL,
    modelRuntime,
  });
  if (resolved.error) {
    console.warn("[pi-box] model resolve:", resolved.error);
  } else {
    console.log(
      `[pi-box] model ${resolved.model?.provider || "openrouter"}/${resolved.model?.id || DEFAULT_MODEL}`,
    );
  }
  const loader = new mod.DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    skillsOverride: (current) => ({
      skills: [
        ...current.skills,
        ...toPiSkills(catalog),
      ],
      diagnostics: current.diagnostics,
    }),
  });
  await loader.reload();
  const { session } = await mod.createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    sessionManager: await diskSessionManager(mod, id),
    modelRuntime,
    resourceLoader: loader,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel || "medium",
    tools: ["read", "bash", "edit", "write", "ls", "grep", "find"],
  });
  const wrapped = { kind: "pi", id, session };
  sessions.set(id, wrapped);
  return wrapped;
}

async function runMock(res, message) {
  sseWrite(res, "status", { state: "mock", reason: piLoadError ? "sdk" : "no-api-key" });
  const live = catalog.filter((s) => s.available).map((s) => s.name);
  sseWrite(res, "tool", {
    id: "t-skills",
    name: "skills",
    status: "start",
    args: { list: true },
  });
  await new Promise((r) => setTimeout(r, 120));
  sseWrite(res, "tool", {
    id: "t-skills",
    name: "skills",
    status: "end",
    isError: false,
    output: live.length ? live.join(", ") : "(none available on this host)",
  });
  const text =
    `Mock mode — no model key, so Pi did not run.\n\n` +
    `You said: ${message}\n\n` +
    `Skills on this box: ${live.join(", ") || "none live"}. ` +
    `Unavailable: ${catalog.filter((s) => !s.available).map((s) => s.name).join(", ") || "none"}.\n\n` +
    `Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY) and restart for a real Pi loop.`;
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk) continue;
    sseWrite(res, "text", { delta: chunk });
    await new Promise((r) => setTimeout(r, 8));
  }
  sseWrite(res, "done", { mock: true });
}

async function runPi(wrapped, res, message) {
  sseWrite(res, "status", { state: "pi" });
  const { session } = wrapped;
  const unsub = session.subscribe((event) => {
    try {
      if (event.type === "message_update") {
        const inner = event.assistantMessageEvent;
        if (inner?.type === "text_delta" && inner.delta) {
          sseWrite(res, "text", { delta: inner.delta });
        }
      } else if (event.type === "tool_execution_start") {
        sseWrite(res, "tool", {
          id: event.toolCallId || event.toolName,
          name: event.toolName,
          status: "start",
          args: event.args ?? event.toolCall?.arguments ?? undefined,
        });
      } else if (event.type === "tool_execution_update") {
        sseWrite(res, "tool", {
          id: event.toolCallId || event.toolName,
          name: event.toolName,
          status: "update",
          output: event.delta || event.output,
        });
      } else if (event.type === "tool_execution_end") {
        sseWrite(res, "tool", {
          id: event.toolCallId || event.toolName,
          name: event.toolName,
          status: "end",
          isError: Boolean(event.isError),
        });
      }
    } catch (err) {
      console.error("[pi-box] sse event failed", err);
    }
  });
  try {
    await session.prompt(message);
  } finally {
    unsub();
  }
  sseWrite(res, "done", { mock: false });
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
  if (VAULT_ROUTES && (await handleVaultHttp(req, res, url))) return;
  if (await handlePluginsHttp(req, res, url)) return;
  if (await handleBrowserHttp(req, res, url)) return;

  if (!capabilities) await refreshCatalog();

  if (url.pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      pi: Boolean(await loadPi()),
      mock: !hasProviderKey() || Boolean(piLoadError),
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
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    await refreshCatalog();
    json(res, 200, { skills: catalog.map(publicSkill) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/boxes") {
    await refreshCatalog();
    json(res, 200, { boxes: [thisBox()] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const message = String(body.message || "").trim();
    if (!message) {
      json(res, 400, { error: "message required" });
      return;
    }
    const sessionId =
      url.searchParams.get("session") ||
      req.headers["x-pi-box-session"] ||
      body.session ||
      body.boxId ||
      randomUUID();

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-pi-box-session": String(sessionId),
    });

    try {
      const wrapped = await getSession(String(sessionId));
      if (wrapped.kind === "mock") await runMock(res, message);
      else await runPi(wrapped, res, message);
    } catch (err) {
      console.error("[pi-box] chat failed", err);
      sseWrite(res, "error", { message: err?.message || String(err) });
      sseWrite(res, "done", { error: true });
    }
    res.end();
    return;
  }

  json(res, 404, { error: "not found" });
});

refreshCatalog()
  .then(() => {
    const live = catalog.filter((s) => s.available).map((s) => s.name);
    console.log(
      `[pi-box] skills: ${catalog.map((s) => s.name).join(", ") || "(none)"} (live: ${live.join(", ") || "none"})`,
    );
  })
  .catch((err) => console.warn("[pi-box] skill index failed", err));

server.listen(PORT, HOST, () => {
  console.log(`[pi-box] agent listening on http://${HOST}:${PORT}`);
});
