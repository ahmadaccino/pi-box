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
    !url.pathname.startsWith("/api/oauth/google/callback")
  ) {
    if (!verifyAuthCookie(req.headers.cookie, password)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
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
