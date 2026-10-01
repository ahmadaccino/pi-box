#!/usr/bin/env node
/**
 * Push subscription storage, plus the background-notification decision.
 */
import assert from "node:assert/strict";
import {
  listSubscriptions,
  noticeFromAgentEvent,
  removeSubscription,
  upsertSubscription,
} from "../src/push.ts";
import { backgroundNotice } from "../public/notify.js";

const first = upsertSubscription([], {
  endpoint: "https://push.example/one",
  keys: { p256dh: "pub", auth: "auth" },
  meshId: "default",
});
assert.equal(first.ok, true);
const second = upsertSubscription(first.list, {
  endpoint: "https://push.example/two",
  keys: { p256dh: "pub2", auth: "auth2" },
  meshId: "default",
});
assert.equal(second.list.length, 2);
const replaced = upsertSubscription(second.list, {
  endpoint: "https://push.example/one",
  keys: { p256dh: "rotated", auth: "auth" },
  meshId: "other",
});
assert.equal(replaced.list.length, 2);
assert.equal(replaced.list.find((item) => item.endpoint.endsWith("/one")).keys.p256dh, "rotated");
assert.equal(listSubscriptions(replaced.list, "other").length, 1);
assert.equal(listSubscriptions(replaced.list, "default").length, 1);
const removed = removeSubscription(replaced.list, "https://push.example/two");
assert.equal(removed.length, 1);
assert.equal(removed[0].endpoint, "https://push.example/one");

const bad = upsertSubscription(removed, { endpoint: "http://insecure.example", keys: { p256dh: "a", auth: "b" } });
assert.equal(bad.ok, false);
assert.equal(bad.error, "invalid subscription");
const missing = upsertSubscription(removed, { endpoint: "https://push.example/three", keys: { p256dh: "" } });
assert.equal(missing.ok, false);

const many = [];
let book = [];
for (let i = 0; i < 25; i++) {
  const saved = upsertSubscription(book, {
    endpoint: `https://push.example/${i}`,
    keys: { p256dh: "p", auth: "a" },
    meshId: "default",
  });
  assert.equal(saved.ok, true);
  book = saved.list;
}
assert.equal(book.length, 20);
assert.equal(book[0].endpoint, "https://push.example/5");

const done = noticeFromAgentEvent("done", { mock: false });
assert.equal(done.body, "Turn finished");
assert.equal(noticeFromAgentEvent("done", { waiting: true }), null);
const draft = noticeFromAgentEvent("card", { kind: "draft", id: "d1", subject: "Hello" });
assert.equal(draft.title, "Ready to send");
assert.equal(draft.tag, "draft-d1");
assert.equal(noticeFromAgentEvent("approval", { summary: "send mail" }), null);

assert.equal(backgroundNotice({ hidden: false, unfocused: false, kind: "done" }), null);
assert.equal(backgroundNotice({ hidden: true, kind: "artifact", title: "File" }), null);
const waiting = backgroundNotice({
  hidden: true,
  kind: "approval",
  title: "Approval needed",
  body: "bash rm",
  tag: "approval-1",
});
assert.equal(waiting.title, "Approval needed");
assert.equal(waiting.body, "bash rm");
const routine = backgroundNotice({ unfocused: true, kind: "routine", title: "Routine finished", body: "digest" });
assert.equal(routine.tag, "routine");

console.log("ok test-push");
