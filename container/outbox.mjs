/**
 * Ready-to-send drafts. The model can file them. Only a user click sends.
 * The click nonce is delivered on the SSE card, never in the tool result.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const drafts = new Map();
let sender = async () => ({ status: 500, body: { error: "outbox sender unset" } });

export function setOutboxSender(fn) {
  sender = fn;
}

export function resetOutboxForTests() {
  drafts.clear();
}

function nonce() {
  return randomBytes(18).toString("base64url");
}

function sameNonce(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function fileDraft(fields) {
  const id = randomUUID();
  const secret = nonce();
  const record = {
    id,
    nonce: secret,
    status: "ready",
    channel: fields.channel,
    to: fields.to || fields.recipients || "",
    cc: fields.cc || "",
    subject: fields.subject || "",
    body: fields.body || fields.text || "",
    chatId: fields.chatId || "",
    raw: fields.raw || "",
    gmailDraftId: fields.gmailDraftId || "",
    request: fields.request || null,
    fetchImpl: fields.fetchImpl || null,
  };
  drafts.set(id, record);
  const preview = {
    kind: "draft",
    type: "draft",
    title: "Ready to send",
    id: record.id,
    channel: record.channel,
    to: record.to,
    cc: record.cc,
    subject: record.subject,
    body: record.body,
    chatId: record.chatId,
    status: "ready",
  };
  return {
    record,
    card: { ...preview, nonce: secret },
    model: {
      ok: true,
      draft: true,
      sent: false,
      id: record.id,
      status: "ready",
      channel: record.channel,
      to: record.to,
      subject: record.subject,
      chatId: record.chatId,
      message:
        "Ready to send. The user must click Send in the chat. Do not send it yourself and do not claim it was sent.",
    },
  };
}

export function getDraft(id) {
  return drafts.get(String(id)) || null;
}

function take(id, givenNonce) {
  const row = drafts.get(String(id));
  if (!row || row.status !== "ready" || !sameNonce(row.nonce, givenNonce)) return null;
  return row;
}

export async function sendDraft(id, givenNonce) {
  const row = take(id, givenNonce);
  if (!row) return { status: 404, body: { error: "not found" } };
  row.status = "sending";
  try {
    const result = await sender(row, "send");
    row.status = result.status >= 200 && result.status < 300 ? "sent" : "ready";
    if (row.status !== "sent") row.status = "ready";
    return {
      status: result.status,
      body: { ...(result.body || {}), sent: row.status === "sent", id: row.id },
    };
  } catch (err) {
    row.status = "ready";
    return { status: 502, body: { error: err?.message || "send failed", sent: false } };
  }
}

export async function discardDraft(id, givenNonce) {
  const row = take(id, givenNonce);
  if (!row) return { status: 404, body: { error: "not found" } };
  row.status = "discarded";
  try {
    await sender(row, "discard");
  } catch {
    /* local discard still stands; the message was not sent */
  }
  return { status: 200, body: { ok: true, discarded: true, sent: false, id: row.id } };
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function handleOutboxHttp(req, res, url) {
  const matched = url.pathname.match(/^\/api\/outbox\/([^/]+)\/(send|discard)$/);
  if (!matched) return false;
  if ((req.method || "GET").toUpperCase() !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "invalid json" });
    return true;
  }
  const id = decodeURIComponent(matched[1]);
  const op = matched[2];
  const result =
    op === "send" ? await sendDraft(id, body.nonce) : await discardDraft(id, body.nonce);
  json(res, result.status, result.body);
  return true;
}
