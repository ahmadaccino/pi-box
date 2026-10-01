/**
 * Agent-facing routines HTTP. The model calls localhost; this process attaches
 * the per-box internal token (or a legacy gateway token) and forwards to Mesh.
 * The model never sees the token: it is stripped from bash in shell-env.mjs.
 */
import http from "node:http";

let sealedInternalToken = "";

/** Copy the sidecar token out of process.env so bash and /proc/1/environ cannot read it. */
export function sealInternalTokenFromEnv(env = process.env) {
  const token = String(env.PI_BOX_INTERNAL_TOKEN || "");
  if (token) sealedInternalToken = token;
  delete env.PI_BOX_INTERNAL_TOKEN;
  delete env.INTERNAL_API_SECRET;
}

function headerValue(value) {
  if (Array.isArray(value)) return String(value[0] || "");
  return value ? String(value) : "";
}

export function rememberRoutinesRoute(req) {
  const mesh = headerValue(req.headers["x-pi-box-mesh"]);
  if (mesh) {
    const bound = process.env.PI_BOX_MESH_ID || "";
    // The container is started with its own mesh id. A tool call must not
    // retarget that id; the internal token is bound to it.
    if (!bound || bound === mesh) process.env.PI_BOX_MESH_ID = mesh;
  }
  const origin = headerValue(req.headers["x-pi-box-origin"]);
  if (origin) process.env.PI_BOX_PUBLIC_URL = origin.replace(/\/+$/, "");
}

export function routinesUpstreamHeaders(env, contentType) {
  const headers = new Headers();
  if (contentType) headers.set("content-type", String(contentType));
  headers.set("x-pi-box-sidecar", "1");
  headers.set("x-pi-box-mesh", env.PI_BOX_MESH_ID || "default");
  const internal = String(env.PI_BOX_INTERNAL_TOKEN || sealedInternalToken || "");
  if (internal) headers.set("x-pi-box-internal", internal);
  else if (env.GATEWAY_TOKEN) headers.set("x-pi-box-internal", String(env.GATEWAY_TOKEN));
  return headers;
}

export async function handleRoutinesProxy(req, res, url) {
  if (!url.pathname.startsWith("/api/routines")) return false;
  const base = (process.env.PI_BOX_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "routines proxy unset" }));
    return true;
  }
  const headers = routinesUpstreamHeaders(process.env, req.headers["content-type"]);
  const chunks = [];
  if (req.method !== "GET" && req.method !== "HEAD") {
    for await (const chunk of req) chunks.push(chunk);
  }
  try {
    const upstream = await fetch(`${base}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const out = {};
    upstream.headers.forEach((value, key) => {
      if (key === "content-encoding" || key === "transfer-encoding") return;
      out[key] = value;
    });
    res.writeHead(upstream.status, out);
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "routines unreachable", detail: err?.message || String(err) }),
    );
  }
  return true;
}

export function startDeviceRoutinesProxy({ origin, deviceId, deviceSecret, port = 8799 }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith("/api/routines")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks = [];
    if (req.method !== "GET" && req.method !== "HEAD") {
      for await (const chunk of req) chunks.push(chunk);
    }
    try {
      const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] || "application/json",
          authorization: `Bearer ${deviceSecret}`,
          "x-pi-box-device": deviceId,
          "x-pi-box-actor": "device",
        },
        body:
          req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
      });
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "routines unreachable", detail: err?.message || String(err) }),
      );
    }
  });
  server.on("error", (err) => {
    console.warn("[pi-box] routines proxy", err?.message || err);
  });
  server.on("listening", () => {
    process.env.PI_BOX_ROUTINES_URL = `http://127.0.0.1:${port}`;
  });
  server.listen(port, "127.0.0.1");
  return server;
}
