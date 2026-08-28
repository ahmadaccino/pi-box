#!/usr/bin/env node
/**
 * Pi HTTP/SSE sidecar. Same process locally (`npm run dev`) and in the container.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";
const CWD = process.env.PI_CWD || "/workspace";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent";

const sessions = new Map();
let piMod = null;
let piLoadError = null;

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
    process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.XAI_API_KEY,
  );
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const mod = await loadPi();
  if (!mod || !hasProviderKey()) {
    const mock = { kind: "mock", id };
    sessions.set(id, mock);
    return mock;
  }
  const modelRuntime = await mod.ModelRuntime.create();
  const { session } = await mod.createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    sessionManager: mod.SessionManager.inMemory(CWD),
    modelRuntime,
    tools: ["read", "bash", "edit", "write", "ls", "grep", "find"],
  });
  const wrapped = { kind: "pi", id, session };
  sessions.set(id, wrapped);
  return wrapped;
}

async function runMock(res, message) {
  sseWrite(res, "status", { state: "mock", reason: piLoadError ? "sdk" : "no-api-key" });
  sseWrite(res, "tool", {
    id: "t-ls",
    name: "ls",
    status: "start",
    args: { path: CWD },
  });
  await new Promise((r) => setTimeout(r, 180));
  sseWrite(res, "tool", {
    id: "t-ls",
    name: "ls",
    status: "end",
    isError: false,
    output: "(mock) /workspace is empty in this demo",
  });
  const text =
    `Mock mode — no model key, so Pi did not run.\n\n` +
    `You said: ${message}\n\n` +
    `Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / XAI_API_KEY) and restart. ` +
    `This card is here so the UI can be demoed without Cloudflare or a provider.`;
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk) continue;
    sseWrite(res, "text", { delta: chunk });
    await new Promise((r) => setTimeout(r, 12));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-pi-box-session, x-pi-box-token");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pi: Boolean(await loadPi()),
        mock: !hasProviderKey() || Boolean(piLoadError),
      }),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const message = String(body.message || "").trim();
    if (!message) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "message required" }));
      return;
    }
    const sessionId =
      url.searchParams.get("session") ||
      req.headers["x-pi-box-session"] ||
      body.session ||
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

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`[pi-box] agent listening on http://${HOST}:${PORT}`);
});
