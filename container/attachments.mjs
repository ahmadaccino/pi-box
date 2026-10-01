/**
 * Save non-image uploads under the workspace and publish files the agent sends back.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  bindAttachments,
  bytesToBase64,
  isModelImage,
  normalizeMime,
  safeFileName,
  safeUploadRel,
  validateAttachments,
} from "./chat-body.mjs";
import { requireInternal } from "./snapshot.mjs";

const INLINE_IMAGE_BYTES = 1_200_000;

function uploadsRoot(cwd) {
  return path.resolve(cwd, "uploads");
}

export function resolveUploadPath(cwd, rel) {
  const root = uploadsRoot(cwd);
  const dest = path.resolve(cwd, String(rel || ""));
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    const err = new Error("upload path escapes the workspace");
    err.status = 400;
    throw err;
  }
  return dest;
}

export async function writeUpload(cwd, rel, bytes) {
  const dest = resolveUploadPath(cwd, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return dest;
}

async function rememberUpload(agentDir, entry) {
  if (!agentDir) return;
  const file = path.join(agentDir, "uploads", "index.json");
  let index = { files: [] };
  try {
    index = JSON.parse(await readFile(file, "utf8"));
  } catch {
    index = { files: [] };
  }
  const files = Array.isArray(index.files) ? index.files : [];
  const next = files.filter((item) => item?.rel !== entry.rel);
  next.push({
    rel: entry.rel,
    name: entry.name,
    mime: entry.mime,
    r2Key: entry.r2Key || "",
  });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ files: next.slice(-200) }, null, 2), { mode: 0o600 });
}

function materialize(file) {
  if (!file || typeof file !== "object") return null;
  if (file.bytes && file.bytes.byteLength) return file;
  if (file.data) {
    const clean = String(file.data).replace(/^data:[^,]*,/, "");
    const bytes = Buffer.from(clean, "base64");
    if (!bytes.length) return null;
    return { ...file, bytes, size: bytes.length };
  }
  return { ...file, missing: true };
}

export async function prepareAttachments({ attachments, cwd, agentDir, sessionId } = {}) {
  const present = [];
  const missing = [];
  for (const file of attachments || []) {
    const ready = materialize(file);
    if (!ready) continue;
    if (ready.missing) missing.push(ready);
    else present.push(ready);
  }
  const bound = bindAttachments(present, sessionId || "session");
  const checked = validateAttachments(bound);
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.status = 413;
    throw err;
  }
  const images = [];
  const saved = [];
  for (const file of bound) {
    const mime = normalizeMime(file.mime);
    if (isModelImage(mime)) {
      images.push({
        type: "image",
        data: bytesToBase64(file.bytes),
        mimeType: mime,
      });
      continue;
    }
    const rel = safeUploadRel(file.rel, sessionId, file.id, file.name);
    const dest = await writeUpload(cwd, rel, file.bytes);
    saved.push({ ...file, mime, rel, path: dest });
    await rememberUpload(agentDir, { rel, name: file.name, mime, r2Key: file.r2Key });
  }
  const lines = [];
  if (saved.length) {
    lines.push("Attached files saved in the workspace:");
    for (const file of saved) {
      lines.push(`- ${file.path} (${file.mime}, ${file.size} bytes)`);
    }
  }
  if (images.length) {
    lines.push(
      images.length === 1
        ? "1 image is attached for you to see."
        : `${images.length} images are attached for you to see.`,
    );
  }
  if (missing.length) {
    lines.push(
      `These attachments are stored for the cloud workspace and were not copied onto this machine: ${missing
        .map((file) => file.name || file.rel || "file")
        .join(", ")}.`,
    );
  }
  return { images, saved, note: lines.join("\n") };
}

const published = new Map();

export function resetPublishedFilesForTests() {
  published.clear();
}

export async function publishWorkspaceFile({ cwd, sourcePath, bytes, name, mime } = {}) {
  const id = randomUUID();
  const safe = safeFileName(name || path.basename(sourcePath || "") || "file");
  const rel = `uploads/out/${id}/${safe}`;
  let data = bytes;
  if (!data) {
    const abs = path.resolve(cwd, sourcePath || "");
    const root = path.resolve(cwd);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      const err = new Error("path is outside the workspace");
      err.code = "outside";
      throw err;
    }
    data = await readFile(abs);
  }
  if (data.length > 25 * 1024 * 1024) {
    const err = new Error("file exceeds 25 MB");
    err.code = "too-large";
    throw err;
  }
  const dest = await writeUpload(cwd, rel, data);
  const type = normalizeMime(mime) || "application/octet-stream";
  const image = isModelImage(type);
  const record = {
    id,
    name: safe,
    mime: type,
    path: dest,
    rel,
    url: `/api/files/${id}`,
    size: data.length,
  };
  published.set(id, record);
  const card = {
    id,
    kind: "artifact",
    type: "artifact",
    title: image ? "Image" : "File",
    name: safe,
    mime: type,
    path: dest,
    url: record.url,
    size: data.length,
    image,
  };
  if (image && data.length <= INLINE_IMAGE_BYTES) {
    card.src = `data:${type};base64,${bytesToBase64(data)}`;
  }
  return { record, card };
}

export async function readPublishedFile(id) {
  const key = String(id || "");
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  const known = published.get(key);
  if (known) {
    try {
      const bytes = await readFile(known.path);
      return { ...known, bytes };
    } catch {
      return null;
    }
  }
  return null;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readRaw(req, limit) {
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

export async function handleAttachmentHttp(req, res, url, opts = {}) {
  const cwd = opts.cwd || process.env.PI_CWD || "/workspace";
  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && (req.method || "GET").toUpperCase() === "GET") {
    const file = await readPublishedFile(decodeURIComponent(fileMatch[1]));
    if (!file) {
      json(res, 404, { error: "not found" });
      return true;
    }
    const download = url.searchParams.get("download") === "1";
    res.writeHead(200, {
      "content-type": file.mime || "application/octet-stream",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${file.name}"`,
      "cache-control": "private, max-age=60",
    });
    res.end(file.bytes);
    return true;
  }
  const internal = (url.pathname || "").replace(/\/+$/, "") || "/";
  if (internal === "/internal/uploads" && (req.method || "GET").toUpperCase() === "PUT") {
    if (!requireInternal(req)) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    const rel = String(req.headers["x-pi-box-rel"] || "");
    let bytes;
    try {
      bytes = await readRaw(req, 32 * 1024 * 1024);
    } catch {
      json(res, 413, { error: "body too large" });
      return true;
    }
    try {
      const dest = await writeUpload(cwd, rel, bytes);
      json(res, 200, { ok: true, path: dest });
    } catch (err) {
      json(res, err.status || 400, { error: err.message || "bad path" });
    }
    return true;
  }
  return false;
}
