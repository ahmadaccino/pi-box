/**
 * Chat body parser shared by the sidecar and the Mesh worker.
 * Accepts JSON or multipart/form-data. No filesystem access.
 */

export const MAX_ATTACHMENTS = 6;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_CHAT_BODY = MAX_VIDEO_BYTES + 1024 * 1024;

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;

export function attachmentLimit(mime) {
  return String(mime || "").toLowerCase().startsWith("video/") ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
}

export function isModelImage(mime) {
  return IMAGE_MIME.test(normalizeMime(mime));
}

export function normalizeMime(mime) {
  const value = String(mime || "").split(";")[0].trim().toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  return value;
}

export function safeSession(id) {
  const cleaned = String(id || "session").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 80);
  return cleaned || "session";
}

export function safeFileName(name) {
  const base = String(name || "file").split(/[/\\]/).pop() || "file";
  const cleaned = base.replace(/\0/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 120);
}

export function uploadObjectKey(meshId, id) {
  const mesh = safeSession(meshId);
  const fileId = String(id || "").replace(/[^A-Za-z0-9_-]+/g, "");
  return `uploads/${mesh}/${fileId}`;
}

export function uploadRel(sessionId, id, name) {
  return `uploads/${safeSession(sessionId)}/${id}-${safeFileName(name)}`;
}

export function validateAttachments(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `too many attachments (max ${MAX_ATTACHMENTS})` };
  }
  for (const file of list) {
    const size = Number.isFinite(file?.size) ? file.size : file?.bytes?.byteLength || 0;
    const limit = attachmentLimit(file?.mime);
    if (size > limit) {
      return {
        ok: false,
        error: `${file?.name || "attachment"} exceeds ${limit} bytes`,
      };
    }
  }
  return { ok: true };
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return new TextEncoder().encode(input);
  return new Uint8Array(input || []);
}

function indexOfBytes(hay, needle, from = 0) {
  if (!needle.length) return from;
  const last = hay.length - needle.length;
  for (let i = from; i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function decodeBase64(data) {
  const clean = String(data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (!clean) return new Uint8Array();
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(clean, "base64"));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  const view = toBytes(bytes);
  if (typeof Buffer !== "undefined") return Buffer.from(view).toString("base64");
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < view.length; i += step) {
    binary += String.fromCharCode(...view.subarray(i, i + step));
  }
  return btoa(binary);
}

function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "";
}

function headerMap(text) {
  const headers = {};
  for (const line of String(text || "").split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function contentDisposition(value) {
  const disp = String(value || "");
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disp) || /(?:^|;)\s*name=([^;\s]+)/i.exec(disp);
  const star = /filename\*=(?:UTF-8'')?([^;\s]+)/i.exec(disp);
  const quoted = /filename="([^"]*)"/i.exec(disp);
  const plain = /filename=([^;\s]+)/i.exec(disp);
  let filename = "";
  if (star) {
    try {
      filename = decodeURIComponent(star[1].replace(/^UTF-8''/i, ""));
    } catch {
      filename = star[1];
    }
  } else if (quoted) filename = quoted[1];
  else if (plain && !/name=/i.test(plain[0])) filename = plain[1];
  return { name: name ? name[1] : "", filename };
}

function parseMultipart(bytes, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ""));
  if (!match) return { ok: false, status: 400, error: "missing multipart boundary" };
  const token = new TextEncoder().encode(`--${match[1] || match[2]}`);
  const positions = [];
  let from = 0;
  while (from <= bytes.length - token.length) {
    const at = indexOfBytes(bytes, token, from);
    if (at < 0) break;
    positions.push(at);
    from = at + token.length;
  }
  if (positions.length < 2) return { ok: false, status: 400, error: "bad multipart body" };
  const fields = [];
  const files = [];
  for (let i = 0; i < positions.length; i++) {
    let begin = positions[i] + token.length;
    if (bytes[begin] === 45 && bytes[begin + 1] === 45) break;
    if (bytes[begin] === 13 && bytes[begin + 1] === 10) begin += 2;
    else if (bytes[begin] === 10) begin += 1;
    const next = positions[i + 1];
    if (next == null) break;
    let end = next;
    if (end >= 2 && bytes[end - 2] === 13 && bytes[end - 1] === 10) end -= 2;
    else if (end >= 1 && bytes[end - 1] === 10) end -= 1;
    const chunk = bytes.subarray(begin, end);
    const sep = indexOfBytes(chunk, new Uint8Array([13, 10, 13, 10]), 0);
    if (sep < 0) continue;
    const headers = headerMap(new TextDecoder().decode(chunk.subarray(0, sep)));
    const body = chunk.subarray(sep + 4);
    const disp = contentDisposition(headers["content-disposition"]);
    if (disp.filename) {
      const declared = normalizeMime(headers["content-type"] || "");
      const sniffed = sniffImageMime(body);
      const mime = isModelImage(declared) || declared.startsWith("video/") || declared.startsWith("application/") || declared.startsWith("text/")
        ? declared || sniffed || "application/octet-stream"
        : sniffed || declared || "application/octet-stream";
      files.push({
        name: disp.filename || "file",
        mime: normalizeMime(mime) || "application/octet-stream",
        bytes: body,
        size: body.byteLength,
      });
    } else if (disp.name) {
      fields.push({ name: disp.name, value: new TextDecoder().decode(body) });
    }
  }
  return { ok: true, fields, files };
}

function fieldValue(fields, name) {
  const found = fields.find((item) => item.name === name);
  return found ? found.value : "";
}

function normalizeFileList(files) {
  return files.map((file) => {
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : toBytes(file.bytes);
    const declared = normalizeMime(file.mime || file.type || "");
    const sniffed = sniffImageMime(bytes);
    const mime =
      declared && declared !== "application/octet-stream"
        ? declared
        : sniffed || declared || "application/octet-stream";
    return {
      id: file.id ? String(file.id) : "",
      name: file.name || "file",
      mime: normalizeMime(mime) || "application/octet-stream",
      bytes,
      size: bytes.byteLength,
      rel: file.rel ? String(file.rel) : "",
      r2Key: file.r2Key ? String(file.r2Key) : "",
    };
  });
}

export function parseChatBody(input, contentType, opts = {}) {
  const bytes = toBytes(input);
  if (bytes.byteLength > MAX_CHAT_BODY) {
    return { ok: false, status: 413, error: "body too large" };
  }
  const type = String(contentType || "");
  let message = "";
  let session = String(opts.sessionId || "");
  let require = [];
  let files = [];
  let botId = "";
  let bot = null;
  if (/multipart\/form-data/i.test(type)) {
    const parsed = parseMultipart(bytes, type);
    if (!parsed.ok) return parsed;
    message = fieldValue(parsed.fields, "message").trim();
    session = session || fieldValue(parsed.fields, "session").trim();
    botId = fieldValue(parsed.fields, "botId").trim();
    const botRaw = fieldValue(parsed.fields, "bot").trim();
    if (botRaw) {
      try {
        const parsedBot = JSON.parse(botRaw);
        if (parsedBot && typeof parsedBot === "object" && !Array.isArray(parsedBot)) bot = parsedBot;
      } catch {
        bot = null;
      }
    }
    const rawRequire = fieldValue(parsed.fields, "require");
    if (rawRequire) {
      try {
        const parsedRequire = JSON.parse(rawRequire);
        if (Array.isArray(parsedRequire)) require = parsedRequire.map((item) => String(item));
      } catch {
        require = rawRequire.split(",").map((item) => item.trim()).filter(Boolean);
      }
    }
    files = parsed.files;
  } else {
    let body;
    try {
      const text = new TextDecoder().decode(bytes).trim();
      body = JSON.parse(text || "{}");
    } catch {
      return { ok: false, status: 400, error: "invalid json" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, status: 400, error: "invalid json" };
    }
    message = String(body.message || "").trim();
    session = session || String(body.session || "").trim();
    botId = String(body.botId || "");
    if (body.bot && typeof body.bot === "object" && !Array.isArray(body.bot)) bot = body.bot;
    if (Array.isArray(body.require)) require = body.require.map((item) => String(item));
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    for (const item of attachments) {
      if (!item || typeof item !== "object") continue;
      const rawBytes = item.bytes instanceof Uint8Array ? item.bytes : decodeBase64(item.data || "");
      files.push({
        id: item.id ? String(item.id) : "",
        name: item.name || "file",
        mime: item.mime || item.type || "",
        rel: item.rel ? String(item.rel) : "",
        r2Key: item.r2Key ? String(item.r2Key) : "",
        bytes: rawBytes,
        size: rawBytes.byteLength,
      });
    }
  }
  files = normalizeFileList(files);
  for (const file of files) {
    if (!file.size) return { ok: false, status: 400, error: `${file.name || "attachment"} is empty` };
  }
  const checked = validateAttachments(files);
  if (!checked.ok) return { ok: false, status: 413, error: checked.error };
  if (!message && files.length) message = "See the attached files.";
  if (!message) return { ok: false, status: 400, error: "message required" };
  return { ok: true, message, session, require, attachments: files, botId, bot };
}

export function bindAttachments(files, sessionId) {
  return (files || []).map((file) => {
    const id = String(file.id || "").replace(/[^A-Za-z0-9_-]+/g, "") || crypto.randomUUID();
    const rel = safeUploadRel(file.rel, sessionId, id, file.name);
    return {
      id,
      name: safeFileName(file.name),
      mime: normalizeMime(file.mime) || "application/octet-stream",
      bytes: file.bytes,
      size: file.size || file.bytes?.byteLength || 0,
      rel,
      r2Key: file.r2Key ? String(file.r2Key) : "",
    };
  });
}

export function safeUploadRel(rel, sessionId, id, name) {
  const fallback = uploadRel(sessionId, id, name);
  const value = String(rel || "").replace(/\\/g, "/");
  if (!value || value.includes("\0") || value.split("/").includes("..") || value.startsWith("/")) {
    return fallback;
  }
  if (!value.startsWith("uploads/")) return fallback;
  return value;
}

export function attachmentMeta(files) {
  return (files || []).map((file) => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size || file.bytes?.byteLength || 0,
    rel: file.rel || "",
    r2Key: file.r2Key || "",
  }));
}

export function uploadsFromSnapshot(text) {
  try {
    const snap = JSON.parse(String(text || ""));
    const raw = snap?.files?.["uploads/index.json"];
    if (!raw || typeof raw !== "string") return [];
    const index = JSON.parse(raw);
    return Array.isArray(index.files) ? index.files : [];
  } catch {
    return [];
  }
}
