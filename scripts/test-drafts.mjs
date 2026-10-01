#!/usr/bin/env node
/**
 * Gmail and Telegram sends become Ready to send drafts. The upstream send
 * runs only when the user posts the card nonce.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { proxyPluginRequest } from "../container/plugins.mjs";
import { resetOutboxForTests, sendDraft, discardDraft } from "../container/outbox.mjs";
import { saveOAuthToken } from "../container/vault.mjs";
import { GOOGLE_SCOPES as workerScopes } from "../src/oauth.ts";
import { GOOGLE_SCOPES as sidecarScopes } from "../container/google-oauth.mjs";

assert.match(workerScopes, /gmail\.compose/);
assert.match(workerScopes, /gmail\.send/);
assert.match(sidecarScopes, /gmail\.compose/);

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-box-drafts-"));
process.env.PI_CODING_AGENT_DIR = tmp;

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function encodeRaw(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

try {
  await saveOAuthToken({
    plugin: "gmail",
    secretFields: { access_token: "gmail-access-token", expires_at: Date.now() + 3_600_000 },
    account: { provider: "google" },
  });
  await saveOAuthToken({
    plugin: "telegram",
    secretFields: { bot_token: "123456:TESTTOKEN" },
    account: {},
  });

  const calls = [];
  const cards = [];
  const raw = encodeRaw(
    "To: ada@example.com\nCc: grace@example.com\nSubject: Hello\n\nBody of the note.\n",
  );
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).endsWith("/drafts")) return jsonResponse({ id: "draft-1", message: { id: "msg-1" } });
    if (String(url).endsWith("/drafts/send")) return jsonResponse({ id: "msg-1" });
    if (String(url).includes("/sendMessage")) return jsonResponse({ ok: true, result: { message_id: 7 } });
    if (init?.method === "DELETE") return jsonResponse({ ok: true });
    return jsonResponse({ error: "unexpected" }, 500);
  };

  const filed = await proxyPluginRequest(
    "gmail",
    {
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      method: "POST",
      body: { raw },
    },
    {
      fetch: fetchImpl,
      emit: (event, data) => cards.push({ event, data }),
    },
  );
  assert.equal(filed.status, 200);
  assert.equal(filed.body.draft, true);
  assert.equal(filed.body.sent, false);
  assert.equal(filed.body.to, "ada@example.com");
  assert.equal(filed.body.subject, "Hello");
  assert.equal(filed.body.nonce, undefined);
  assert.ok(!JSON.stringify(filed.body).includes(cards[0].data.nonce));
  assert.equal(cards[0].event, "card");
  assert.equal(cards[0].data.title, "Ready to send");
  assert.equal(cards[0].data.to, "ada@example.com");
  assert.equal(cards[0].data.cc, "grace@example.com");
  assert.equal(cards[0].data.subject, "Hello");
  assert.match(cards[0].data.body, /Body of the note/);
  assert.ok(cards[0].data.nonce);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/gmail\/v1\/users\/me\/drafts$/);
  assert.ok(!calls.some((call) => call.url.includes("/messages/send") || call.url.includes("/drafts/send")));

  const missing = await sendDraft(filed.body.id, "wrong-nonce");
  assert.equal(missing.status, 404);
  assert.equal(calls.length, 1);

  const sent = await sendDraft(filed.body.id, cards[0].data.nonce);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sent, true);
  assert.match(calls[1].url, /\/drafts\/send$/);
  assert.ok(!calls.some((call) => String(call.url).includes("/messages/send")));

  resetOutboxForTests();
  calls.length = 0;
  cards.length = 0;
  const draftCreate = await proxyPluginRequest(
    "gmail",
    {
      url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      method: "POST",
      body: { message: { raw } },
    },
    { fetch: fetchImpl, emit: (event, data) => cards.push({ event, data }) },
  );
  assert.equal(draftCreate.body.sent, false);
  assert.equal(calls.length, 1);
  const dropped = await discardDraft(draftCreate.body.id, cards[0].data.nonce);
  assert.equal(dropped.body.discarded, true);
  assert.equal(dropped.body.sent, false);
  assert.ok(calls.some((call) => call.method === "DELETE"));
  assert.ok(!calls.some((call) => String(call.url).includes("/send")));

  resetOutboxForTests();
  calls.length = 0;
  cards.length = 0;
  const telegram = await proxyPluginRequest(
    "telegram",
    {
      url: "https://api.telegram.org/bot/sendMessage",
      method: "POST",
      body: { chat_id: "42", text: "ping from the bot" },
    },
    { fetch: fetchImpl, emit: (event, data) => cards.push({ event, data }) },
  );
  assert.equal(telegram.body.draft, true);
  assert.equal(telegram.body.sent, false);
  assert.equal(telegram.body.chatId, "42");
  assert.equal(calls.length, 0, "telegram must not be called before Send");
  assert.equal(cards[0].data.title, "Ready to send");
  assert.equal(cards[0].data.body, "ping from the bot");
  assert.equal(cards[0].data.chatId, "42");
  assert.ok(!JSON.stringify(telegram.body).includes("TESTTOKEN"));
  assert.ok(!JSON.stringify(telegram.body).includes(cards[0].data.nonce));

  const delivered = await sendDraft(telegram.body.id, cards[0].data.nonce);
  assert.equal(delivered.body.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bot123456:TESTTOKEN\/sendMessage$/);
  assert.ok(!calls[0].url.includes("/bot/sendMessage"));

  console.log("ok test-drafts");
} finally {
  resetOutboxForTests();
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(tmp, { recursive: true, force: true });
}
