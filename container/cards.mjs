/**
 * One inline card event for approvals, drafts, questions, and artifacts.
 * A question waits until the user answers; that answer is the user's reply.
 */
import { randomUUID } from "node:crypto";
import { emitLive } from "./live-turn.mjs";

const pending = new Map();

export function resetCardsForTests() {
  pending.clear();
}

export function approvalCardEvent(payload) {
  return {
    id: payload.id,
    kind: "approval",
    type: "approval",
    title: "Approval needed",
    tool: payload.tool,
    target: payload.target,
    summary: payload.summary,
    choices: payload.choices || ["allow_once", "always", "deny"],
  };
}

export function formatAnswer(question, body) {
  const options = Array.isArray(body?.options) ? body.options.map((item) => String(item)) : [];
  const custom = String(body?.custom || "").trim();
  const allowed = new Set(question.options || []);
  if (options.some((option) => !allowed.has(option))) {
    return { ok: false, error: "unknown option" };
  }
  if (!question.multiple && options.length > 1) {
    return { ok: false, error: "pick one option" };
  }
  if (custom && question.allowCustom === false) {
    return { ok: false, error: "custom answer is closed" };
  }
  if (!options.length && !custom) return { ok: false, error: "answer required" };
  const parts = [...options];
  if (custom) parts.push(custom);
  return { ok: true, reply: parts.join(", ") };
}

export function askUser(input, opts = {}) {
  const emit = opts.emit || ((event, data) => emitLive(event, data));
  const id = input.id || randomUUID();
  const options = Array.isArray(input.options) ? input.options.map((item) => String(item)).filter(Boolean) : [];
  const question = {
    id,
    prompt: String(input.prompt || "Choose one"),
    options,
    multiple: Boolean(input.multiple),
    allowCustom: input.allowCustom !== false,
  };
  const card = {
    id,
    kind: "question",
    type: "question",
    title: "Question",
    prompt: question.prompt,
    options: question.options,
    multiple: question.multiple,
    allowCustom: question.allowCustom,
  };
  emit("card", card);
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve("The user did not answer.");
    }, ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    pending.set(id, { ...question, resolve, timer });
  });
}

export function answerQuestion(id, body) {
  const question = pending.get(String(id || ""));
  if (!question) return { ok: false, status: 404, error: "unknown" };
  const formatted = formatAnswer(question, body);
  if (!formatted.ok) return { ok: false, status: 400, error: formatted.error };
  clearTimeout(question.timer);
  pending.delete(question.id);
  question.resolve(formatted.reply);
  return { ok: true, status: 200, reply: formatted.reply };
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
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

export async function handleCardsHttp(req, res, url) {
  const matched = url.pathname.match(/^\/api\/cards\/([^/]+)\/answer$/);
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
  const result = answerQuestion(decodeURIComponent(matched[1]), body);
  json(res, result.status, result.ok ? { ok: true, reply: result.reply } : { error: result.error });
  return true;
}
