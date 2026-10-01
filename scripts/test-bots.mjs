#!/usr/bin/env node
/**
 * Named bots and server-side chat history.
 * CRUD, per-bot session lists, and transcript restore across a book reload.
 */
import assert from "node:assert/strict";
import { MeshStore } from "../src/mesh-state.ts";
import { handleRoutinesRequest } from "../src/routines.ts";
import {
  BotBook,
  exportBotBook,
  handleBotsRequest,
  importBotBook,
  isBotsApiPath,
  recordAssistantMessage,
  recordUserMessage,
} from "../src/bots.ts";

const NOW = 1_700_000_000_000;

function req(url, method = "GET", body) {
  return new Request(url, {
    method,
    headers: body == null ? {} : { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function read(res) {
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

assert.equal(isBotsApiPath("/api/bots"), true);
assert.equal(isBotsApiPath("/api/bots/default"), true);
assert.equal(isBotsApiPath("/api/bots/default/sessions"), true);
assert.equal(isBotsApiPath("/api/sessions/chat_1/transcript"), true);
assert.equal(isBotsApiPath("/api/bots/default/memory"), false);
assert.equal(isBotsApiPath("/api/bots/default/memory/mem_abc"), false);
assert.equal(isBotsApiPath("/api/sessions/chat_1/steer"), false);
assert.equal(isBotsApiPath("/api/sessions/chat_1/abort"), false);
assert.equal(isBotsApiPath("/api/sessions/chat_1/snapshot"), false);
assert.equal(isBotsApiPath("/api/chat"), false);

{
  const book = new BotBook();
  const listed = await read(await handleBotsRequest({ book, request: req("http://x/api/bots"), now: NOW }));
  assert.equal(listed.status, 200);
  assert.equal(listed.data.bots.length, 1);
  assert.equal(listed.data.bots[0].id, "default");
  assert.equal(listed.data.bots[0].name, "Assistant");
  assert.equal(listed.data.bots[0].default, true);

  const missing = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/bots", "POST", { description: "no name" }),
      now: NOW,
    }),
  );
  assert.equal(missing.status, 400);

  const badColor = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/bots", "POST", { name: "Nope", avatarColor: "blue" }),
      now: NOW,
    }),
  );
  assert.equal(badColor.status, 400);

  const created = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/bots", "POST", {
        name: "Research",
        description: "Reads papers",
        avatarColor: "#7aa2d6",
        instructions: "Cite sources.",
      }),
      now: NOW + 1,
    }),
  );
  assert.equal(created.status, 200);
  const botId = created.data.bot.id;
  assert.match(botId, /^bot[a-z0-9]+$/);
  assert.equal(created.data.bot.name, "Research");
  assert.equal(created.data.bot.description, "Reads papers");
  assert.equal(created.data.bot.avatarColor, "#7aa2d6");
  assert.equal(created.data.bot.instructions, "Cite sources.");
  assert.equal(created.data.bot.default, false);

  const renamed = await read(
    await handleBotsRequest({
      book,
      request: req(`http://x/api/bots/${botId}`, "PATCH", { name: "Papers", description: "Paper bot" }),
      now: NOW + 2,
    }),
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.bot.name, "Papers");
  assert.equal(renamed.data.bot.description, "Paper bot");
  assert.equal(renamed.data.bot.instructions, "Cite sources.");

  const opened = await read(
    await handleBotsRequest({
      book,
      request: req(`http://x/api/bots/${botId}/sessions`, "POST", { id: "chat_restore_1", title: "New chat" }),
      now: NOW + 3,
    }),
  );
  assert.equal(opened.status, 200);
  assert.equal(opened.data.session.id, "chat_restore_1");
  assert.equal(opened.data.session.botId, botId);

  assert.equal(
    recordUserMessage(book, { botId, sessionId: "chat_restore_1", text: "hello from another device", now: NOW + 4 }),
    true,
  );
  assert.equal(
    recordAssistantMessage(book, { sessionId: "chat_restore_1", text: "welcome back", now: NOW + 5 }),
    true,
  );

  const chats = await read(
    await handleBotsRequest({
      book,
      request: req(`http://x/api/bots/${botId}/sessions`),
      now: NOW + 6,
    }),
  );
  assert.equal(chats.status, 200);
  assert.equal(chats.data.sessions.length, 1);
  assert.equal(chats.data.sessions[0].title, "hello from another device");

  const transcript = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/sessions/chat_restore_1/transcript"),
      now: NOW + 6,
    }),
  );
  assert.equal(transcript.status, 200);
  assert.equal(transcript.data.session.botId, botId);
  assert.deepEqual(
    transcript.data.messages.map((message) => ({ role: message.role, text: message.text })),
    [
      { role: "user", text: "hello from another device" },
      { role: "assistant", text: "welcome back" },
    ],
  );

  const other = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/bots/default/sessions"),
      now: NOW + 6,
    }),
  );
  assert.equal(other.data.sessions.length, 0);

  const reloaded = importBotBook(exportBotBook(book));
  const restored = await read(
    await handleBotsRequest({
      book: reloaded,
      request: req("http://x/api/sessions/chat_restore_1/transcript"),
      now: NOW + 7,
    }),
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.data.messages.length, 2);
  assert.equal(restored.data.messages[1].text, "welcome back");
  const botsAgain = await read(
    await handleBotsRequest({ book: reloaded, request: req("http://x/api/bots"), now: NOW + 7 }),
  );
  assert.equal(botsAgain.data.bots.some((bot) => bot.id === botId && bot.name === "Papers"), true);

  const removed = await read(
    await handleBotsRequest({
      book,
      request: req(`http://x/api/bots/${botId}`, "DELETE"),
      now: NOW + 8,
    }),
  );
  assert.equal(removed.status, 200);
  const gone = await read(
    await handleBotsRequest({ book, request: req(`http://x/api/bots/${botId}`), now: NOW + 8 }),
  );
  assert.equal(gone.status, 404);
  const transcriptGone = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/sessions/chat_restore_1/transcript"),
      now: NOW + 8,
    }),
  );
  assert.equal(transcriptGone.status, 404);

  const keepDefault = await read(
    await handleBotsRequest({
      book,
      request: req("http://x/api/bots/default", "DELETE"),
      now: NOW + 9,
    }),
  );
  assert.equal(keepDefault.status, 409);
  const still = await read(await handleBotsRequest({ book, request: req("http://x/api/bots"), now: NOW + 9 }));
  assert.equal(still.data.bots.some((bot) => bot.id === "default"), true);
}

{
  const book = new (await import("../src/routines.ts")).RoutineBook();
  const store = new MeshStore();
  const created = await read(
    await handleRoutinesRequest({
      book,
      store,
      request: req("http://x/api/routines", "POST", {
        name: "digest",
        prompt: "Summarize",
        trigger: "cron",
        schedule: "0 9 * * 1-5",
        botId: "botpapers",
      }),
      meshId: "default",
      now: NOW,
      origin: "http://x",
      mintId: () => "rt.default.abc123",
    }),
  );
  assert.equal(created.status, 200);
  assert.equal(created.data.routine.botId, "botpapers");

  const filtered = await read(
    await handleRoutinesRequest({
      book,
      store,
      request: req("http://x/api/routines?botId=botpapers"),
      meshId: "default",
      now: NOW,
      origin: "http://x",
    }),
  );
  assert.equal(filtered.data.routines.length, 1);

  const otherBot = await read(
    await handleRoutinesRequest({
      book,
      store,
      request: req("http://x/api/routines?botId=default"),
      meshId: "default",
      now: NOW,
      origin: "http://x",
    }),
  );
  assert.equal(otherBot.data.routines.length, 0);

  const all = await read(
    await handleRoutinesRequest({
      book,
      store,
      request: req("http://x/api/routines"),
      meshId: "default",
      now: NOW,
      origin: "http://x",
    }),
  );
  assert.equal(all.data.routines.length, 1);
  assert.equal(all.data.routines[0].botId, "botpapers");
}

console.log("ok test-bots");
