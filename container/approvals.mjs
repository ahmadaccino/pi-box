/**
 * Approval gate. Allow once, Always allow (persisted per tool+target), or Deny.
 * Requests made while no user is connected expire after 10 minutes as Deny.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishApproval, reviewToolCall } from "./actions.mjs";
import { approvalCardEvent } from "./cards.mjs";
import { emitLive, isUserConnected, subscribeConnection } from "./live-turn.mjs";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

const DECISIONS = new Set(["allow_once", "always", "deny"]);

export function createConnectionFlag(initial = false) {
  let value = Boolean(initial);
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = Boolean(next);
      for (const fn of [...listeners]) fn(value);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

async function readRules(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

async function writeRules(file, rules) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ rules }, null, 2), { mode: 0o600 });
}

export function createApprovalGate(opts = {}) {
  const ttlMs = opts.ttlMs ?? APPROVAL_TTL_MS;
  const isConnected = opts.isConnected || isUserConnected;
  const subscribe = opts.subscribe || subscribeConnection;
  const emit = opts.emit || ((event, data) => emitLive(event, data));
  const rulesFile =
    opts.rulesFile ||
    (() =>
      path.join(process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent", "approvals.json"));
  const schedule = opts.schedule || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  const pending = new Map();

  function findRule(rules, tool, target) {
    return rules.find((rule) => rule?.effect === "allow" && rule.tool === tool && rule.target === target);
  }

  async function persistAlways(tool, target) {
    const file = rulesFile();
    const rules = await readRules(file);
    if (findRule(rules, tool, target)) return;
    rules.push({ tool, target, effect: "allow" });
    await writeRules(file, rules);
  }

  function settle(entry, decision, via) {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimer(entry.timer);
    if (entry.unsub) entry.unsub();
    pending.delete(entry.id);
    entry.resolve({ decision, via, id: entry.id });
  }

  function arm(entry) {
    if (entry.done || entry.timer) return;
    entry.timer = schedule(() => settle(entry, "deny", "expired"), ttlMs);
  }

  async function decide(action) {
    const tool = String(action?.tool || "");
    const target = String(action?.target || "");
    const summary = String(action?.summary || `${tool} ${target}`);
    const rules = await readRules(rulesFile());
    if (findRule(rules, tool, target)) {
      return { decision: "allow", via: "rule", id: null };
    }
    const id = randomUUID();
    const approval = {
      id,
      tool,
      target,
      summary,
      choices: ["allow_once", "always", "deny"],
    };
    emit("approval", approval);
    emit("card", approvalCardEvent(approval));
    return new Promise((resolve) => {
      const entry = { id, tool, target, resolve, done: false, timer: null, unsub: null };
      pending.set(id, entry);
      if (!isConnected()) arm(entry);
      else {
        entry.unsub = subscribe((on) => {
          if (!on) arm(entry);
        });
      }
    });
  }

  async function resolve(id, decision) {
    if (!DECISIONS.has(decision)) return { ok: false, error: "bad decision" };
    const entry = pending.get(String(id));
    if (!entry) return { ok: false, error: "unknown" };
    if (decision === "always") await persistAlways(entry.tool, entry.target);
    const allowed = decision === "allow_once" || decision === "always";
    settle(entry, allowed ? "allow" : "deny", "user");
    return { ok: true, decision };
  }

  return {
    decide,
    resolve,
    pendingCount: () => pending.size,
    ttlMs,
  };
}

let singleton = null;

export function getApprovalGate() {
  if (!singleton) singleton = createApprovalGate();
  return singleton;
}

export function resetApprovalGateForTests() {
  singleton = null;
}

export function attachToolGate(session, gate = getApprovalGate()) {
  const agent = session?.agent;
  if (!agent) return false;
  const previous =
    typeof agent.beforeToolCall === "function" ? agent.beforeToolCall.bind(agent) : null;
  agent.beforeToolCall = async (ctx, signal) => {
    const toolName = ctx?.toolCall?.name || ctx?.toolName || "";
    const args = ctx?.args || ctx?.input || {};
    const review = reviewToolCall(toolName, args);
    if (review.action === "block") {
      return { block: true, reason: review.reason };
    }
    if (review.action === "approval") {
      const decision = await gate.decide(review.approval);
      if (decision.decision !== "allow") {
        return {
          block: true,
          reason:
            decision.via === "expired"
              ? "Approval expired with no user connected."
              : "User denied this action.",
        };
      }
    }
    if (previous) return previous(ctx, signal);
    return undefined;
  };
  return true;
}

export async function requireApproval(action, gate = getApprovalGate()) {
  const decision = await gate.decide(action);
  return decision.decision === "allow";
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

export async function handleApprovalsHttp(req, res, url, gate = getApprovalGate()) {
  const matched = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
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
  const decision = body.decision;
  if (decision !== "allow_once" && decision !== "always" && decision !== "deny") {
    json(res, 400, { error: "decision must be allow_once, always, or deny" });
    return true;
  }
  const out = await gate.resolve(decodeURIComponent(matched[1]), decision);
  json(res, out.ok ? 200 : 404, out);
  return true;
}

export { publishApproval };
