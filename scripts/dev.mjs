#!/usr/bin/env node
/**
 * Local slice: static UI on :8787, Pi sidecar on :8788. No Cloudflare required.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const UI_PORT = Number(process.env.UI_PORT || 8787);
const AGENT_PORT = Number(process.env.PORT || 8788);

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

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
