/**
 * Durable per-bot memory. Profile facts are always placed in the prompt.
 * Dated log facts are searched with memory_search.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { botLayout, ensureBotLayout, safeBotId } from "./bot-files.mjs";

function emptyMemory() {
  return { profile: [], log: [] };
}

export function readMemory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      profile: Array.isArray(parsed?.profile) ? parsed.profile : [],
      log: Array.isArray(parsed?.log) ? parsed.log : [],
    };
  } catch {
    return emptyMemory();
  }
}

function writeMemory(file, memory) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(memory, null, 2), { mode: 0o600 });
}

function factId() {
  return `mem_${randomBytes(6).toString("hex")}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function memoryWrite(file, input = {}) {
  const text = String(input.text || "").trim().slice(0, 2_000);
  if (!text) return { ok: false, error: "text required" };
  const kind = input.kind === "log" ? "log" : "profile";
  const memory = readMemory(file);
  const fact = {
    id: factId(),
    text,
    kind,
    createdAt: new Date().toISOString(),
  };
  if (kind === "log") {
    const at = String(input.at || "").trim();
    fact.at = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : today();
    memory.log.push(fact);
  } else {
    memory.profile.push(fact);
  }
  writeMemory(file, memory);
  return { ok: true, fact };
}

export function memoryForget(file, id) {
  const want = String(id || "").trim();
  if (!want) return { ok: false, error: "id required" };
  const memory = readMemory(file);
  const before = memory.profile.length + memory.log.length;
  memory.profile = memory.profile.filter((fact) => fact.id !== want);
  memory.log = memory.log.filter((fact) => fact.id !== want);
  const after = memory.profile.length + memory.log.length;
  if (after === before) return { ok: false, error: "not found" };
  writeMemory(file, memory);
  return { ok: true, id: want };
}

export function memorySearch(file, query) {
  const needle = String(query || "").trim().toLowerCase();
  const memory = readMemory(file);
  const facts = memory.log.filter((fact) => {
    if (!needle) return true;
    const hay = `${fact.text || ""} ${fact.at || ""}`.toLowerCase();
    return hay.includes(needle);
  });
  return { facts: facts.slice(-20) };
}

export function promptWithProfile(message, memory) {
  const facts = (memory?.profile || []).map((fact) => String(fact.text || "").trim()).filter(Boolean);
  if (!facts.length) return String(message || "");
  const lines = facts.map((text) => `- ${text}`).join("\n");
  return `<profile-memory>\n${lines}\n</profile-memory>\n\n${message}`;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function memoryFileFor(root, botId) {
  return botLayout(root, { id: safeBotId(botId) }).memoryFile;
}

export async function handleMemoryHttp(req, res, url) {
  const matched = (url.pathname || "").match(/^\/api\/bots\/([^/]+)\/memory(?:\/([^/]+))?$/);
  if (!matched) return false;
  const method = (req.method || "GET").toUpperCase();
  const root = process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent";
  const botId = safeBotId(decodeURIComponent(matched[1]));
  if (botId !== decodeURIComponent(matched[1]).replace(/[^a-zA-Z0-9_-]/g, "")) {
    json(res, 404, { error: "not found" });
    return true;
  }
  ensureBotLayout(root, { id: botId, name: botId === "default" ? "Assistant" : botId });
  const file = memoryFileFor(root, botId);
  if (method === "GET" && !matched[2]) {
    const memory = readMemory(file);
    json(res, 200, {
      profile: memory.profile.map((fact) => ({ ...fact, kind: "profile" })),
      log: memory.log.map((fact) => ({ ...fact, kind: "log" })),
    });
    return true;
  }
  if (method === "DELETE" && matched[2]) {
    const result = memoryForget(file, decodeURIComponent(matched[2]));
    json(res, result.ok ? 200 : 404, result);
    return true;
  }
  json(res, 405, { error: "method not allowed" });
  return true;
}
