#!/usr/bin/env node
/**
 * Local slice: static UI on :8787, Pi sidecar on :8788. No Cloudflare required.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPassword,
  mintAuthCookie,
  clearAuthCookie,
  verifyAuthCookie,
} from "./password.mjs";
import { MeshStore } from "../src/mesh-state.ts";
import { handleMeshRequest, isDeviceTokenPath, isMeshDevicePath } from "../src/mesh-http.ts";
import { failSseBody, planChatTurn, sseChunk, waitingSseBody } from "../src/mesh-chat.ts";
import { sanitizeSession } from "../src/password.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const UI_PORT = Number(process.env.UI_PORT || 8787);
const AGENT_PORT = Number(process.env.PORT || 8788);

try {
  const raw = await readFile(path.join(root, ".dev.vars"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
} catch {
  /* no .dev.vars */
}

const mesh = new MeshStore();
const snapshots = new Map();
const pending = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const agent = spawn(process.execPath, ["server.mjs"], {
  cwd: path.join(root, "container"),
  env: {
    ...process.env,
    PORT: String(AGENT_PORT),
    HOST: "127.0.0.1",
    PI_CWD: process.env.PI_CWD || path.join(root, "workspace"),
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || path.join(root, ".pi-agent"),
    PI_PLUGINS_DIR: process.env.PI_PLUGINS_DIR || path.join(root, "plugins"),
    PI_BOX_PUBLIC_URL: process.env.PI_BOX_PUBLIC_URL || `http://127.0.0.1:${UI_PORT}`,
  },
  stdio: "inherit",
});
agent.on("exit", (code) => {
  if (code) console.error(`[pi-box] agent exited ${code}`);
});
process.on("exit", () => agent.kill());
process.on("SIGINT", () => {
  agent.kill();
  process.exit(0);
});

async function serveFile(res, filePath) {
  const body = await readFile(filePath);
  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  res.end(body);
}

function sendJson(res, code, body, headers = {}) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function writePending(jobId, event, data) {
  const res = pending.get(jobId);
  if (!res) return;
  res.write(sseChunk(event, data));
}

function writeRaw(jobId, body) {
  const res = pending.get(jobId);
  if (!res) return;
  res.write(body);
}

function closePending(jobId) {
  const res = pending.get(jobId);
  pending.delete(jobId);
  if (!res) return;
  try {
    res.end();
  } catch {
    /* already closed */
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const https = url.protocol === "https:";
  const password = process.env.PI_BOX_PASSWORD || "";

  if (url.pathname === "/api/login" && req.method === "POST") {
    if (!password) {
      sendJson(res, 200, { ok: true, skipped: true });
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    if (!checkPassword(String(body.password || ""), password)) {
      sendJson(res, 401, { error: "invalid password" });
      return;
    }
    sendJson(res, 200, { ok: true }, { "set-cookie": mintAuthCookie(password, { https }) });
    return;
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    sendJson(res, 200, { ok: true }, { "set-cookie": clearAuthCookie({ https }) });
    return;
  }

  if (
    password &&
    (url.pathname.startsWith("/api/") || url.pathname === "/healthz") &&
    url.pathname !== "/api/config" &&
    !url.pathname.startsWith("/api/oauth/google/callback") &&
    !isDeviceTokenPath(url.pathname) &&
    !(req.headers["x-pi-box-device"] && /^\/api\/sessions\/[^/]+\/snapshot$/.test(url.pathname))
  ) {
    if (!verifyAuthCookie(req.headers.cookie, password)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
  }

  if (isMeshDevicePath(url.pathname)) {
    const chunks = [];
    if (req.method !== "GET" && req.method !== "HEAD") {
      for await (const c of req) chunks.push(c);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    headers.set(
      "x-pi-box-actor",
      isDeviceTokenPath(url.pathname) ? "device" : "user",
    );
    headers.set("x-pi-box-mesh", "default");
    const request = new Request(`http://127.0.0.1:${UI_PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const upstream = await handleMeshRequest({
      store: mesh,
      request,
      meshId: "default",
      now: Date.now(),
      browser: true,
      onDeviceEvent: (jobId, event, data) => writePending(jobId, event, data),
      onDeviceAck: async (jobId, deviceId) => {
        writePending(jobId, "status", { state: "pi", runtime: deviceId });
        writePending(jobId, "done", { mock: false, runtime: deviceId });
        closePending(jobId);
      },
      replaceJob: async (job) => {
        const next = planChatTurn(mesh, {
          sessionId: job.sessionId,
          require: job.require,
          prefer: job.prefer,
          affinity: null,
          payload: job.payload,
          jobId: job.id,
          now: Date.now(),
        });
        if (next.decision.wait) {
          writeRaw(job.id, waitingSseBody(next.job));
          closePending(job.id);
        }
      },
    });
    const outHeaders = Object.fromEntries(upstream.headers);
    res.writeHead(upstream.status, outHeaders);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return;
  }

  if (/^\/api\/sessions\/[^/]+\/snapshot$/.test(url.pathname)) {
    const sessionId = sanitizeSession(url.pathname.split("/")[3] || "");
    if (req.method === "GET") {
      const body = snapshots.get(sessionId);
      if (!body) {
        sendJson(res, 404, { error: "no_pointer" });
        return;
      }
      sendJson(res, 200, body);
      return;
    }
    if (req.method === "PUT") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        snapshots.set(sessionId, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        sendJson(res, 400, { error: "invalid json" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const sessionId = sanitizeSession(
      url.searchParams.get("session") || req.headers["x-pi-box-session"] || body.session,
    );
    mesh.sweep(Date.now());
    const planned = planChatTurn(mesh, {
      sessionId,
      message: body.message,
      require: body.require,
      now: Date.now(),
      payload: { message: body.message, raw, sessionId },
    });
    const { job, decision } = planned;
    if (decision.wait) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-pi-box-runtime": "waiting",
      });
      res.end(waitingSseBody(job));
      return;
    }
    if (decision.fail || !decision.deviceId) {
      mesh.fail(job.id);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "x-pi-box-runtime": "none",
      });
      res.end(failSseBody("no_capacity"));
      return;
    }
    if (decision.deviceId !== "cloud") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-pi-box-runtime": decision.deviceId,
        "x-pi-box-session": sessionId,
      });
      pending.set(job.id, res);
      res.write(sseChunk("status", { state: "pi", runtime: decision.deviceId }));
      return;
    }
    try {
      const target = `http://127.0.0.1:${AGENT_PORT}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.set("content-type", "application/json");
      const upstream = await fetch(target, { method: "POST", headers, body: raw });
      res.writeHead(upstream.status, {
        ...Object.fromEntries(upstream.headers),
        "x-pi-box-runtime": "cloud",
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      mesh.ack({ jobId: job.id, deviceId: "cloud", now: Date.now() });
    } catch (err) {
      mesh.fail(job.id, "cloud");
      sendJson(res, 502, { error: "agent not ready", detail: err?.message });
    }
    return;
  }

  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    const target = `http://127.0.0.1:${AGENT_PORT}${url.pathname}${url.search}`;
    try {
      const headers = new Headers(req.headers);
      headers.delete("host");
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await new Promise((resolve, reject) => {
              const chunks = [];
              req.on("data", (c) => chunks.push(c));
              req.on("end", () => resolve(Buffer.concat(chunks)));
              req.on("error", reject);
            });
      const upstream = await fetch(target, { method: req.method, headers, body });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agent not ready", detail: err?.message }));
    }
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  if (rel === "/vault") rel = "/vault.html";
  if (rel === "/plugins") rel = "/plugins.html";
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    await serveFile(res, filePath);
  } catch {
    try {
      await serveFile(res, path.join(publicDir, "index.html"));
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }
});

server.listen(UI_PORT, "127.0.0.1", () => {
  console.log(`[pi-box] ui http://127.0.0.1:${UI_PORT}`);
});
