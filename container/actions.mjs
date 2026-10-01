/**
 * Classify plugin proxy calls and direct shell bypasses.
 * Outbound email/Telegram is draft-then-send. Other mutations need approval.
 */

const TELEGRAM_OUTBOUND = new Set([
  "sendMessage",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendVideoNote",
  "sendMediaGroup",
  "sendLocation",
  "sendVenue",
  "sendContact",
  "sendPoll",
  "sendDice",
  "sendSticker",
  "sendInvoice",
  "forwardMessage",
  "copyMessage",
]);

export function pathnameOf(raw) {
  try {
    return new URL(String(raw || "")).pathname || "/";
  } catch {
    return "";
  }
}

export function telegramMethod(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export function isGmailSend(pathname) {
  return /\/gmail\/v1\/users\/[^/]+\/(?:messages\/send|drafts\/send)$/.test(pathname);
}

export function isGmailDraftCreate(method, pathname) {
  return method === "POST" && /\/gmail\/v1\/users\/[^/]+\/drafts$/.test(pathname);
}

function headerValue(headers, name) {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const line of String(headers).split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === want) return line.slice(idx + 1).trim();
  }
  return "";
}

export function decodeBase64Url(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function parseEmailText(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const splitAt = normalized.indexOf("\n\n");
  const headerBlock = splitAt === -1 ? normalized : normalized.slice(0, splitAt);
  const body = splitAt === -1 ? "" : normalized.slice(splitAt + 2);
  return {
    to: headerValue(headerBlock, "to"),
    cc: headerValue(headerBlock, "cc"),
    bcc: headerValue(headerBlock, "bcc"),
    subject: headerValue(headerBlock, "subject"),
    body,
  };
}

export function gmailRawFrom(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.raw === "string") return body.raw;
  if (body.message && typeof body.message.raw === "string") return body.message.raw;
  return "";
}

function gmailDraftFields(body) {
  const raw = gmailRawFrom(body);
  const parsed = parseEmailText(raw ? decodeBase64Url(raw) : "");
  const recipients = [parsed.to, parsed.cc, parsed.bcc].filter(Boolean).join(", ");
  return { raw, ...parsed, recipients };
}

function telegramFields(pathname, body) {
  const method = telegramMethod(pathname);
  const payload = body && typeof body === "object" ? body : {};
  const text = String(payload.text || payload.caption || "");
  const chatId = payload.chat_id != null ? String(payload.chat_id) : "";
  return { method, text, chatId };
}

export function classifyOutbound(pluginId, method, pathname, req) {
  if (pluginId === "gmail" && (isGmailSend(pathname) || isGmailDraftCreate(method, pathname))) {
    const fields = gmailDraftFields(req?.body);
    return {
      channel: "gmail",
      holdSend: isGmailSend(pathname),
      createDraft: isGmailDraftCreate(method, pathname),
      ...fields,
    };
  }
  if (pluginId === "telegram" && method === "POST" && TELEGRAM_OUTBOUND.has(telegramMethod(pathname))) {
    const fields = telegramFields(pathname, req?.body);
    return {
      channel: "telegram",
      holdSend: true,
      createDraft: false,
      ...fields,
      request: {
        url: req?.url,
        method,
        body: req?.body,
        headers: req?.headers,
      },
    };
  }
  return null;
}

function looksLikePayment(pluginId, pathname, body) {
  const blob = `${pluginId} ${pathname} ${JSON.stringify(body || {})}`.toLowerCase();
  return /\/(payments?|charges?|checkout|payouts?|transfers)\b/.test(blob);
}

export function describeMutation(pluginId, method, pathname, body) {
  if (looksLikePayment(pluginId, pathname, body)) {
    return `Payment ${pluginId} ${method} ${pathname}`;
  }
  if (method === "DELETE") return `Delete ${pluginId} ${pathname}`;
  if (pluginId === "cloudflare") return `Cloudflare ${method} ${pathname}`;
  return `${pluginId} ${method} ${pathname}`;
}

export function classifyPluginCall(pluginId, req) {
  const method = String(req?.method || "GET").toUpperCase();
  const url = String(req?.url || req?.href || "");
  const pathname = pathnameOf(url);
  const outbound = classifyOutbound(pluginId, method, pathname, req);
  if (outbound) return { kind: "outbound", outbound, method, pathname };
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { kind: "read", method, pathname };
  }
  return {
    kind: "mutation",
    method,
    pathname,
    approval: {
      tool: pluginId,
      target: `${method} ${pathname || "/"}`,
      summary: describeMutation(pluginId, method, pathname, req?.body),
    },
  };
}

export function publishApproval(body) {
  const name = String(body?.name || body?.dir || ".").slice(0, 120);
  return {
    tool: "cloudflare",
    target: `publish:${name}`,
    summary: `Publish ${name}`,
  };
}

function isDirectGmailSend(command) {
  return /gmail\.googleapis\.com\/[^\s'"]*\/(?:messages\/send|drafts\/send)\b/.test(command);
}

function isDirectTelegramSend(command) {
  if (/\/api\/plugins\/telegram\/proxy/.test(command)) return false;
  return /api\.telegram\.org\/[^\s'"]*\/(?:send[A-Z][A-Za-z]+|forwardMessage|copyMessage)\b/.test(command);
}

function directMutation(command) {
  const external =
    /api\.cloudflare\.com/.test(command) ||
    /googleapis\.com/.test(command) ||
    /api\.telegram\.org/.test(command);
  const mutating = /(?:-X|--request)\s+(POST|PUT|PATCH|DELETE)\b/i.test(command) || /\bwrangler\s+deploy\b/.test(command);
  if (!external || !mutating) return null;
  if (isDirectGmailSend(command) || isDirectTelegramSend(command)) return null;
  const method = (command.match(/(?:-X|--request)\s+(POST|PUT|PATCH|DELETE)\b/i) || [])[1];
  const verb = method ? method.toUpperCase() : "MUTATE";
  return {
    tool: "bash",
    target: `${verb} direct`,
    summary: "Shell command would mutate an external service",
  };
}

export function reviewToolCall(toolName, input) {
  const command =
    toolName === "bash"
      ? String(input?.command || "")
      : "";
  if (toolName === "bash" && /\/api\/plugins\/[^/\s'"]+\/(?:proxy|publish)\b/.test(command)) {
    return { action: "defer" };
  }
  if (toolName === "bash" && (isDirectGmailSend(command) || isDirectTelegramSend(command))) {
    return {
      action: "block",
      block: true,
      reason:
        "Outbound email and messages must go through the plugin proxy so the user can send them from the Ready to send card.",
    };
  }
  if (toolName === "bash") {
    const approval = directMutation(command);
    if (approval) return { action: "approval", approval };
  }
  return { action: "allow" };
}
