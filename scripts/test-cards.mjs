#!/usr/bin/env node
/**
 * The card event round-trip: a question card goes out, the picked answer
 * comes back as the user's reply.
 */
import assert from "node:assert/strict";
import { answerQuestion, askUser, formatAnswer, handleCardsHttp, resetCardsForTests } from "../container/cards.mjs";

function fakeReq(method, body) {
  const listeners = {};
  return {
    method,
    on(ev, fn) {
      listeners[ev] = fn;
      if (listeners.data && listeners.end) {
        if (body != null) listeners.data(Buffer.from(JSON.stringify(body)));
        listeners.end();
      }
    },
  };
}

function fakeRes() {
  return {
    code: 0,
    writeHead(code) {
      this.code = code;
    },
    end(body) {
      this.raw = body;
      this.json = JSON.parse(body);
    },
  };
}

resetCardsForTests();
const events = [];
const pending = askUser(
  { prompt: "Pick a color", options: ["red", "blue"], multiple: false, allowCustom: true },
  { emit: (event, data) => events.push({ event, data }), ttlMs: 60_000 },
);
assert.equal(events.length, 1);
assert.equal(events[0].event, "card");
assert.equal(events[0].data.kind, "question");
assert.equal(events[0].data.type, "question");
assert.deepEqual(events[0].data.options, ["red", "blue"]);
assert.equal(events[0].data.multiple, false);

const unknown = answerQuestion(events[0].data.id, { options: ["green"] });
assert.equal(unknown.ok, false);
assert.equal(unknown.status, 400);

const req = fakeReq("POST", { options: ["blue"], custom: "navy" });
const res = fakeRes();
const handled = await handleCardsHttp(
  req,
  res,
  new URL(`http://sidecar/api/cards/${events[0].data.id}/answer`),
);
assert.equal(handled, true);
assert.equal(res.code, 200);
assert.equal(res.json.reply, "blue, navy");
assert.equal(await pending, "blue, navy");

const again = answerQuestion(events[0].data.id, { options: ["red"] });
assert.equal(again.status, 404);

resetCardsForTests();
const multi = askUser(
  { prompt: "Which days?", options: ["mon", "tue"], multiple: true, allowCustom: false },
  { emit: () => {}, ttlMs: 60_000 },
);
const multiRes = fakeRes();
await handleCardsHttp(
  fakeReq("POST", { options: ["mon", "tue"], custom: "wed" }),
  multiRes,
  new URL("http://sidecar/api/cards/ignored/answer"),
);
assert.equal(multiRes.code, 404);

const events2 = [];
const pending2 = askUser(
  { id: "q-fixed", prompt: "Which days?", options: ["mon", "tue"], multiple: true, allowCustom: false },
  { emit: (event, data) => events2.push(data), ttlMs: 60_000 },
);
const closed = answerQuestion("q-fixed", { options: ["mon"], custom: "wed" });
assert.equal(closed.ok, false);
const picked = answerQuestion("q-fixed", { options: ["mon", "tue"] });
assert.equal(picked.reply, "mon, tue");
assert.equal(await pending2, "mon, tue");
assert.equal(events2[0].kind, "question");
void multi;

assert.equal(formatAnswer({ options: ["a"], multiple: false, allowCustom: true }, { custom: "typed" }).reply, "typed");

console.log("ok test-cards");
