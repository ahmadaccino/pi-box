/**
 * Persist vault ciphertext + Pi session files across ephemeral container sleep.
 * Caller (Worker DO) stores the JSON in ctx.storage.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOTS = ["vault", "sessions"];
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 80;

function isSafeRel(rel) {
  if (!rel || rel.includes("\0")) return false;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || norm.includes("..")) return false;
  const top = norm.split("/")[0];
  return ROOTS.includes(top);
}

async function walk(dir, prefix, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(full, rel, acc);
    } else if (entry.isFile()) {
      acc.push({ rel, full });
    }
  }
  return acc;
}

export async function collectSnapshot(agentDir) {
  const root = path.resolve(agentDir);
  const files = {};
  for (const top of ROOTS) {
    const found = await walk(path.join(root, top), top, []);
    for (const { rel, full } of found) {
      if (!isSafeRel(rel)) continue;
      try {
        const buf = await readFile(full);
        if (buf.length > MAX_FILE) continue;
        files[rel] = buf.toString("utf8");
      } catch {
        /* skip unreadable */
      }
    }
  }
  return { version: 1, files };
}

export async function restoreSnapshot(agentDir, payload) {
  const root = path.resolve(agentDir);
  const files = payload?.files && typeof payload.files === "object" ? payload.files : {};
  let written = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (!isSafeRel(rel)) continue;
    if (typeof content !== "string") continue;
    if (content.length > MAX_FILE) continue;
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, content, { mode: 0o600 });
    written += 1;
  }
  return { ok: true, written };
}

export function snapshotAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent";
}

export function requireInternal(req) {
  const expected = process.env.GATEWAY_TOKEN;
  if (!expected) return true;
  const given = req.headers["x-pi-box-internal"];
  return String(given || "") === expected;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 8 * 1024 * 1024) {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || "{}"));
    req.on("error", reject);
  });
}

export async function handleSnapshotHttp(req, res, url) {
  const p = (url.pathname || "/").replace(/\/+$/, "") || "/";
  if (p !== "/internal/snapshot") return false;
  if (!requireInternal(req)) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  const method = (req.method || "GET").toUpperCase();
  const agentDir = snapshotAgentDir();
  if (method === "GET") {
    const snap = await collectSnapshot(agentDir);
    json(res, 200, snap);
    return true;
  }
  if (method === "PUT") {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      json(res, 400, { error: "invalid body" });
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    const out = await restoreSnapshot(agentDir, payload);
    json(res, 200, out);
    return true;
  }
  json(res, 405, { error: "method not allowed" });
  return true;
}
