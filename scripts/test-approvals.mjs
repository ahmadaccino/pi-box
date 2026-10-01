#!/usr/bin/env node
/**
 * Approval cards: allow once, always (persisted), deny, and 10-minute expiry
 * when no user is connected. Mutating plugin proxy calls block until resolved.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { reviewToolCall } from "../container/actions.mjs";
import {
  APPROVAL_TTL_MS,
  attachToolGate,
  createApprovalGate,
  createConnectionFlag,
  handleApprovalsHttp,
} from "../container/approvals.mjs";
import { proxyPluginRequest } from "../container/plugins.mjs";
import { saveOAuthToken } from "../container/vault.mjs";

assert.equal(APPROVAL_TTL_MS, 10 * 60 * 1000);

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-box-approve-"));
process.env.PI_CODING_AGENT_DIR = tmp;

function rulesFile() {
  return path.join(tmp, "approvals.json");
}

function gateWith(connection, emit, ttlMs = 40) {
  return createApprovalGate({
    ttlMs,
    isConnected: () => connection.get(),
    subscribe: (fn) => connection.subscribe(fn),
    emit,
    rulesFile,
  });
}

async function until(list, pred, label) {
  const start = Date.now();
  while (Date.now() - start < 1000) {
    const found = list.find(pred);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label || "timed out waiting for approval");
}

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
  };
}

try {
  await saveOAuthToken({
    plugin: "google-calendar",
    secretFields: { access_token: "cal-access-token", expires_at: Date.now() + 3_600_000 },
    account: { provider: "google" },
  });
  await saveOAuthToken({
    plugin: "cloudflare",
    secretFields: { api_token: "cf-vault-token", expires_at: Date.now() + 3_600_000 },
    account: {},
  });

  const events = [];
  const connected = createConnectionFlag(false);
  const expiring = gateWith(connected, (_event, data) => events.push(data), 30);
  const expired = await expiring.decide({
    tool: "cloudflare",
    target: "DELETE /client/v4/zones/1",
    summary: "Delete zone",
  });
  assert.equal(expired.decision, "deny");
  assert.equal(expired.via, "expired");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].choices, ["allow_once", "always", "deny"]);

  const live = createConnectionFlag(true);
  const heldEvents = [];
  const held = gateWith(live, (_event, data) => heldEvents.push(data), 30);
  let settled = false;
  const waiting = held
    .decide({ tool: "cloudflare", target: "DELETE /client/v4/zones/9", summary: "Delete zone 9" })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false, "a connected user does not hit the unattended expiry");
  assert.equal(held.pendingCount(), 1);
  live.set(false);
  const afterDisconnect = await waiting;
  assert.equal(afterDisconnect.decision, "deny");
  assert.equal(afterDisconnect.via, "expired");

  const onceEvents = [];
  const onceGate = gateWith(createConnectionFlag(true), (_event, data) => onceEvents.push(data), 5_000);
  const oncePending = onceGate.decide({
    tool: "google-calendar",
    target: "POST /calendar/v3/calendars/primary/events",
    summary: "Create event",
  });
  const onceEvent = await until(onceEvents, () => true, "allow once card");
  await onceGate.resolve(onceEvent.id, "allow_once");
  const once = await oncePending;
  assert.equal(once.decision, "allow");
  assert.equal(once.via, "user");
  const againEvents = [];
  const againGate = gateWith(createConnectionFlag(true), (_event, data) => againEvents.push(data), 5_000);
  const again = againGate.decide({
    tool: "google-calendar",
    target: "POST /calendar/v3/calendars/primary/events",
    summary: "Create event",
  });
  const againEvent = await until(againEvents, () => true, "second allow-once card");
  assert.equal(againGate.pendingCount(), 1, "allow once must not persist");
  await againGate.resolve(againEvent.id, "deny");
  assert.equal((await again).decision, "deny");

  const alwaysEvents = [];
  const alwaysGate = gateWith(createConnectionFlag(true), (_event, data) => alwaysEvents.push(data), 5_000);
  const alwaysPending = alwaysGate.decide({
    tool: "cloudflare",
    target: "DELETE /client/v4/zones/always",
    summary: "Delete zone always",
  });
  const alwaysEvent = await until(alwaysEvents, () => true, "always card");
  await alwaysGate.resolve(alwaysEvent.id, "always");
  assert.equal((await alwaysPending).decision, "allow");
  const saved = JSON.parse(await readFile(rulesFile(), "utf8"));
  assert.ok(
    saved.rules.some(
      (rule) =>
        rule.tool === "cloudflare" &&
        rule.target === "DELETE /client/v4/zones/always" &&
        rule.effect === "allow",
    ),
  );
  const skipped = [];
  const ruled = gateWith(createConnectionFlag(true), (_event, data) => skipped.push(data), 5_000);
  const auto = await ruled.decide({
    tool: "cloudflare",
    target: "DELETE /client/v4/zones/always",
    summary: "Delete zone always",
  });
  assert.equal(auto.decision, "allow");
  assert.equal(auto.via, "rule");
  assert.equal(skipped.length, 0);

  const calls = [];
  const proxyEvents = [];
  const proxyGate = gateWith(createConnectionFlag(true), (event, data) => proxyEvents.push({ event, data }), 5_000);
  let fetched = false;
  const pendingProxy = proxyPluginRequest(
    "google-calendar",
    {
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      method: "POST",
      body: { summary: "Standup" },
    },
    {
      gate: proxyGate,
      fetch: async (url) => {
        fetched = true;
        calls.push(String(url));
        return jsonResponse({ id: "evt1" });
      },
    },
  );
  const proxyEvent = await until(proxyEvents, (item) => item.event === "approval", "proxy approval");
  assert.equal(fetched, false, "mutating proxy call waits for approval");
  assert.match(proxyEvent.data.summary, /google-calendar/);
  await proxyGate.resolve(proxyEvent.data.id, "allow_once");
  const allowed = await pendingProxy;
  assert.equal(allowed.status, 200);
  assert.equal(fetched, true);
  assert.equal(allowed.body.data.id, "evt1");

  const denyGate = gateWith(createConnectionFlag(true), (_e, data) => proxyEvents.push({ event: "deny", data }), 5_000);
  const deniedPending = proxyPluginRequest(
    "cloudflare",
    {
      url: "https://api.cloudflare.com/client/v4/accounts/payments",
      method: "POST",
      body: { amount: 1 },
    },
    {
      gate: denyGate,
      fetch: async () => {
        throw new Error("fetch must not run after deny");
      },
    },
  );
  const denyEvent = await until(proxyEvents, (item) => item.event === "deny", "deny card");
  await denyGate.resolve(denyEvent.data.id, "deny");
  const denied = await deniedPending;
  assert.equal(denied.status, 403);
  assert.equal(denied.body.decision, "deny");

  let readFetched = false;
  const readGate = {
    async decide() {
      throw new Error("GET must not ask for approval");
    },
  };
  const read = await proxyPluginRequest(
    "google-calendar",
    {
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      method: "GET",
    },
    {
      gate: readGate,
      fetch: async () => {
        readFetched = true;
        return jsonResponse({ items: [] });
      },
    },
  );
  assert.equal(read.status, 200);
  assert.equal(readFetched, true);

  const direct = reviewToolCall("bash", {
    command: "curl -sS -X POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  });
  assert.equal(direct.block, true);
  const viaProxy = reviewToolCall("bash", {
    command:
      'curl -sS -X POST "$BASE/api/plugins/gmail/proxy" -d \'{"url":"https://gmail.googleapis.com/gmail/v1/users/me/messages/send"}\'',
  });
  assert.equal(viaProxy.action, "defer");
  const listing = reviewToolCall("bash", { command: "ls /workspace" });
  assert.equal(listing.action, "allow");

  const hookGate = gateWith(createConnectionFlag(true), (_e, data) => proxyEvents.push({ event: "hook", data }), 5_000);
  const session = {
    agent: {
      async beforeToolCall() {
        return "previous";
      },
    },
  };
  attachToolGate(session, hookGate);
  const blocked = await session.agent.beforeToolCall({
    toolCall: { name: "bash" },
    args: { command: "curl https://gmail.googleapis.com/gmail/v1/users/me/messages/send" },
  });
  assert.equal(blocked.block, true);
  const passed = await session.agent.beforeToolCall({
    toolCall: { name: "bash" },
    args: { command: "ls" },
  });
  assert.equal(passed, "previous");
  const deletePending = session.agent.beforeToolCall({
    toolCall: { name: "bash" },
    args: { command: "curl -X DELETE https://api.cloudflare.com/client/v4/zones/abc" },
  });
  const hookEvent = await until(proxyEvents, (item) => item.event === "hook", "hook card");
  await hookGate.resolve(hookEvent.data.id, "deny");
  const deleteBlocked = await deletePending;
  assert.equal(deleteBlocked.block, true);

  const httpGate = gateWith(createConnectionFlag(true), (_e, data) => proxyEvents.push({ event: "http", data }), 5_000);
  const httpPending = httpGate.decide({ tool: "cloudflare", target: "publish:site", summary: "Publish site" });
  const httpEvent = await until(proxyEvents, (item) => item.event === "http", "http card");
  const req = new EventEmitter();
  req.method = "POST";
  const res = {
    status: 0,
    body: null,
    writeHead(code) {
      this.status = code;
    },
    end(raw) {
      this.body = JSON.parse(raw);
    },
  };
  const handled = handleApprovalsHttp(
    req,
    res,
    new URL(`http://sidecar/api/approvals/${httpEvent.data.id}`),
    httpGate,
  );
  req.emit("data", Buffer.from(JSON.stringify({ decision: "allow_once" })));
  req.emit("end");
  assert.equal(await handled, true);
  assert.equal(res.status, 200);
  assert.equal((await httpPending).decision, "allow");

  console.log("ok test-approvals");
} finally {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(tmp, { recursive: true, force: true });
}
