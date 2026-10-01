/**
 * Agent-facing routines HTTP. The model calls localhost; this process attaches
 * the device secret or gateway token and forwards to the Mesh Durable Object.
 */
import http from "node:http";

export function rememberRoutinesRoute(req) {
  const mesh = req.headers["x-pi-box-mesh"];
  if (mesh) process.env.PI_BOX_MESH_ID = String(Array.isArray(mesh) ? mesh[0] : mesh);
  const origin = req.headers["x-pi-box-origin"];
  if (origin) {
    process.env.PI_BOX_PUBLIC_URL = String(Array.isArray(origin) ? origin[0] : origin).replace(
      /\/+$/,
      "",
    );
  }
}

export async function handleRoutinesProxy(req, res, url) {
  if (!url.pathname.startsWith("/api/routines")) return false;
  const base = (process.env.PI_BOX_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "routines proxy unset" }));
    return true;
  }
  const headers = new Headers();
  const contentType = req.headers["content-type"];
  if (contentType) headers.set("content-type", String(contentType));
  headers.set("x-pi-box-sidecar", "1");
  headers.set("x-pi-box-mesh", process.env.PI_BOX_MESH_ID || "default");
  if (process.env.GATEWAY_TOKEN) headers.set("x-pi-box-internal", process.env.GATEWAY_TOKEN);
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
