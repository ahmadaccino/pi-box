/**
 * Named bots and their chat transcripts. Stored in the Mesh Durable Object
 * (key "bots") so any device can list and restore history without the browser.
 */
export const MAX_BOTS = 50;
export const MAX_SESSIONS = 100;
export const MAX_MESSAGES = 200;
export const MAX_TEXT = 8_000;
export const MAX_INSTRUCTIONS = 16_000;

export type Bot = {
  id: string;
  name: string;
  description: string;
  avatarColor: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
  default: boolean;
};

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
};

export type ChatSession = {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
};

export type BotSnapshot = {
  version: 1;
  bots: Bot[];
  sessions: ChatSession[];
};

const DEFAULT_COLOR = "#e6a23c";

export function isBotsApiPath(pathname: string): boolean {
  if (pathname === "/api/bots") return true;
  if (pathname.startsWith("/api/bots/")) {
    return !/\/memory(?:\/|$)/.test(pathname);
  }
  return /^\/api\/sessions\/[^/]+\/transcript$/.test(pathname);
}

export function normalizeBotId(raw: unknown): string {
  const id = String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return id || "default";
}

function cleanSessionId(raw: unknown): string {
  return String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mint(prefix: string, bytes = 6): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return prefix + hex(buf);
}

function clip(raw: unknown, max: number): string {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function colorOrNull(raw: unknown): string | null {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_COLOR;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function defaultBot(now: number): Bot {
  return {
    id: "default",
    name: "Assistant",
    description: "",
    avatarColor: DEFAULT_COLOR,
    instructions: "",
    createdAt: now,
    updatedAt: now,
    default: true,
  };
}

export class BotBook {
  bots = new Map<string, Bot>();
  sessions = new Map<string, ChatSession>();
  dirty = false;

  ensureDefault(now: number): Bot {
    const existing = this.bots.get("default");
    if (existing) return existing;
    const bot = defaultBot(now);
    this.bots.set(bot.id, bot);
    this.dirty = true;
    return bot;
  }

  get(id: string): Bot | undefined {
    return this.bots.get(id);
  }

  upsert(bot: Bot) {
    this.bots.set(bot.id, bot);
    this.dirty = true;
  }

  deleteBot(id: string): boolean {
    if (id === "default") return false;
    const ok = this.bots.delete(id);
    if (!ok) return false;
    for (const [sessionId, session] of this.sessions) {
      if (session.botId === id) this.sessions.delete(sessionId);
    }
    this.dirty = true;
    return true;
  }
}

export function exportBotBook(book: BotBook): BotSnapshot {
  return {
    version: 1,
    bots: [...book.bots.values()],
    sessions: [...book.sessions.values()],
  };
}

export function importBotBook(raw: unknown): BotBook {
  const book = new BotBook();
  const data = raw && typeof raw === "object" ? (raw as Partial<BotSnapshot>) : {};
  for (const item of data.bots || []) {
    if (!item?.id) continue;
    book.bots.set(item.id, {
      id: String(item.id),
      name: String(item.name || "Assistant"),
      description: String(item.description || ""),
      avatarColor: colorOrNull(item.avatarColor) || DEFAULT_COLOR,
      instructions: String(item.instructions || "").slice(0, MAX_INSTRUCTIONS),
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt) || 0,
      default: item.id === "default" || Boolean(item.default),
    });
  }
  for (const item of data.sessions || []) {
    if (!item?.id || !item.botId) continue;
    const messages = Array.isArray(item.messages) ? item.messages : [];
    book.sessions.set(item.id, {
      id: String(item.id),
      botId: String(item.botId),
      title: String(item.title || "New chat"),
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt) || 0,
      messages: messages
        .filter((message) => message && (message.role === "user" || message.role === "assistant"))
        .slice(-MAX_MESSAGES)
        .map((message) => ({
          id: String(message.id || mint("msg")),
          role: message.role,
          text: String(message.text || "").slice(0, MAX_TEXT),
          at: Number(message.at) || 0,
        })),
    });
  }
  book.dirty = false;
  return book;
}

export function publicBot(bot: Bot) {
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    avatarColor: bot.avatarColor,
    instructions: bot.instructions,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    default: bot.id === "default" || bot.default,
  };
}

function publicSession(session: ChatSession) {
  return {
    id: session.id,
    botId: session.botId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

function pushMessage(session: ChatSession, role: "user" | "assistant", text: string, now: number) {
  const clipped = text.trim().slice(0, MAX_TEXT);
  if (!clipped) return false;
  session.messages.push({ id: mint("msg"), role, text: clipped, at: now });
  if (session.messages.length > MAX_MESSAGES) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES);
  }
  session.updatedAt = now;
  if (role === "user" && (!session.title || session.title === "New chat")) {
    session.title = clipped.slice(0, 80);
  }
  return true;
}

export function recordUserMessage(
  book: BotBook,
  input: { botId: string; sessionId: string; text: string; now: number },
): boolean {
  const botId = normalizeBotId(input.botId);
  const sessionId = cleanSessionId(input.sessionId);
  const text = String(input.text || "");
  if (!sessionId || !text.trim()) return false;
  if (botId === "default") book.ensureDefault(input.now);
  if (!book.get(botId)) return false;
  let session = book.sessions.get(sessionId);
  if (session && session.botId !== botId) return false;
  if (!session) {
    if ([...book.sessions.values()].filter((item) => item.botId === botId).length >= MAX_SESSIONS) {
      return false;
    }
    session = {
      id: sessionId,
      botId,
      title: "New chat",
      createdAt: input.now,
      updatedAt: input.now,
      messages: [],
    };
    book.sessions.set(sessionId, session);
  }
  const ok = pushMessage(session, "user", text, input.now);
  if (ok) book.dirty = true;
  return ok;
}

export function recordAssistantMessage(
  book: BotBook,
  input: { sessionId: string; text: string; now: number },
): boolean {
  const session = book.sessions.get(cleanSessionId(input.sessionId));
  if (!session) return false;
  const ok = pushMessage(session, "assistant", String(input.text || ""), input.now);
  if (ok) book.dirty = true;
  return ok;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const text = await request.text();
  if (text.length > 64_000) return { ok: false, error: "body too large" };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "invalid json" };
  }
}

export type BotsHttpOpts = {
  book: BotBook;
  request: Request;
  now: number;
};

export async function handleBotsRequest(opts: BotsHttpOpts): Promise<Response | null> {
  const url = new URL(opts.request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!isBotsApiPath(path)) return null;
  const actor = (opts.request.headers.get("x-pi-box-actor") || "user").toLowerCase();
  if (actor !== "user") return json({ error: "unauthorized" }, 401);
  const method = opts.request.method.toUpperCase();
  const { book, now } = opts;
  book.ensureDefault(now);

  if (method === "GET" && path === "/api/bots") {
    const bots = [...book.bots.values()].sort((a, b) => {
      if (a.id === "default") return -1;
      if (b.id === "default") return 1;
      return a.createdAt - b.createdAt;
    });
    return json({ bots: bots.map(publicBot) });
  }

  if (method === "POST" && path === "/api/bots") {
    const body = await readBody(opts.request);
    if (!body.ok) return json({ error: body.error }, 400);
    const name = clip(body.value.name, 80);
    if (!name) return json({ error: "name required" }, 400);
    if (book.bots.size >= MAX_BOTS) return json({ error: "too many bots" }, 400);
    const avatarColor = colorOrNull(body.value.avatarColor);
    if (!avatarColor) return json({ error: "avatarColor must be #rrggbb" }, 400);
    const bot: Bot = {
      id: mint("bot"),
      name,
      description: clip(body.value.description, 500),
      avatarColor,
      instructions: String(body.value.instructions || "").slice(0, MAX_INSTRUCTIONS),
      createdAt: now,
      updatedAt: now,
      default: false,
    };
    book.upsert(bot);
    return json({ bot: publicBot(bot) });
  }

  const transcript = path.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcript) {
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    const session = book.sessions.get(cleanSessionId(decodeURIComponent(transcript[1])));
    if (!session || !book.get(session.botId)) return json({ error: "not found" }, 404);
    return json({
      session: publicSession(session),
      messages: session.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        at: message.at,
      })),
    });
  }

  const sessions = path.match(/^\/api\/bots\/([^/]+)\/sessions$/);
  if (sessions) {
    const rawId = decodeURIComponent(sessions[1]);
    const botId = cleanSessionId(rawId);
    if (!botId || botId !== rawId || !book.get(botId)) return json({ error: "not found" }, 404);
    if (method === "GET") {
      const list = [...book.sessions.values()]
        .filter((session) => session.botId === botId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(publicSession);
      return json({ sessions: list });
    }
    if (method === "POST") {
      const body = await readBody(opts.request);
      if (!body.ok) return json({ error: body.error }, 400);
      const count = [...book.sessions.values()].filter((session) => session.botId === botId).length;
      if (count >= MAX_SESSIONS) return json({ error: "too many chats" }, 400);
      const requested = cleanSessionId(body.value.id);
      const id = requested || mint("chat");
      const existing = book.sessions.get(id);
      if (existing) {
        if (existing.botId !== botId) return json({ error: "session belongs to another bot" }, 409);
        return json({ session: publicSession(existing) });
      }
      const title = clip(body.value.title, 80) || "New chat";
      const session: ChatSession = {
        id,
        botId,
        title,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      book.sessions.set(id, session);
      book.dirty = true;
      return json({ session: publicSession(session) });
    }
    return json({ error: "method not allowed" }, 405);
  }

  const one = path.match(/^\/api\/bots\/([^/]+)$/);
  if (!one) return json({ error: "not found" }, 404);
  const botId = cleanSessionId(decodeURIComponent(one[1]));
  if (!botId || botId !== decodeURIComponent(one[1]).replace(/[^a-zA-Z0-9_-]/g, "")) {
    return json({ error: "not found" }, 404);
  }
  const bot = book.get(botId);
  if (method === "GET") {
    if (!bot) return json({ error: "not found" }, 404);
    return json({ bot: publicBot(bot) });
  }
  if (method === "DELETE") {
    if (botId === "default") return json({ error: "cannot delete the default bot" }, 409);
    if (!bot) return json({ error: "not found" }, 404);
    book.deleteBot(botId);
    return json({ ok: true, deleted: botId });
  }
  if (method === "PATCH") {
    if (!bot) return json({ error: "not found" }, 404);
    const body = await readBody(opts.request);
    if (!body.ok) return json({ error: body.error }, 400);
    if (body.value.name != null) {
      const name = clip(body.value.name, 80);
      if (!name) return json({ error: "name required" }, 400);
      bot.name = name;
    }
    if (body.value.description != null) bot.description = clip(body.value.description, 500);
    if (body.value.instructions != null) {
      bot.instructions = String(body.value.instructions || "").slice(0, MAX_INSTRUCTIONS);
    }
    if (body.value.avatarColor != null) {
      const avatarColor = colorOrNull(body.value.avatarColor);
      if (!avatarColor) return json({ error: "avatarColor must be #rrggbb" }, 400);
      bot.avatarColor = avatarColor;
    }
    bot.updatedAt = now;
    book.dirty = true;
    return json({ bot: publicBot(bot) });
  }
  return json({ error: "method not allowed" }, 405);
}
