#!/usr/bin/env node
/**
 * Stop calls abort on the running session. Messages during a turn go to steer.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { composerAction, composerView } from "../public/turn-control.js";
import { createAgentRuntime } from "../container/agent.mjs";
import { handleSessionControl } from "../container/session-control.mjs";

const idleView = composerView(false);
assert.equal(idleView.placeholder, "Message this box…");
assert.equal(idleView.sendLabel, "Send");
assert.equal(idleView.stopHidden, true);
assert.equal(idleView.sendDisabled, false);

const liveView = composerView(true);
assert.equal(liveView.placeholder, "Steer this turn…");
assert.equal(liveView.sendLabel, "Steer");
assert.equal(liveView.stopHidden, false);
assert.equal(liveView.sendDisabled, false);

assert.deepEqual(composerAction(false, "  hello "), { type: "turn", message: "hello" });
assert.deepEqual(composerAction(true, "change course"), { type: "steer", message: "change course" });
assert.deepEqual(composerAction(true, "   "), { type: "ignore" });

const runtime = createAgentRuntime();
const calls = [];
runtime.sessions.set("chat-1", {
  kind: "pi",
  id: "chat-1",
  running: true,
  session: {
    async steer(text) {
      calls.push(["steer", text]);
    },
    async abort() {
      calls.push(["abort"]);
    },
  },
});

const steered = await runtime.steer("chat-1", "look at the tests");
assert.equal(steered.steered, true);
assert.deepEqual(calls[0], ["steer", "look at the tests"]);

runtime.sessions.get("chat-1").running = false;
const idle = await runtime.steer("chat-1", "too late");
assert.equal(idle.ok, false);
assert.equal(idle.error, "idle");
assert.equal(calls.length, 1, "an idle session must not start a steered turn");

runtime.sessions.get("chat-1").running = true;
const aborted = await runtime.abort("chat-1");
assert.equal(aborted.ok, true);
assert.deepEqual(calls[1], ["abort"]);

function mockRes() {
  return {
    status: 0,
    body: null,
    writeHead(code) {
      this.status = code;
    },
    end(raw) {
      this.body = JSON.parse(raw);
    },
  };
}

const steerReq = new EventEmitter();
steerReq.method = "POST";
const steerRes = mockRes();
const steerHandled = handleSessionControl(
  steerReq,
  steerRes,
  new URL("http://sidecar/api/sessions/chat-1/steer"),
  runtime,
);
steerReq.emit("data", Buffer.from(JSON.stringify({ message: "via http" })));
steerReq.emit("end");
assert.equal(await steerHandled, true);
assert.equal(steerRes.status, 200);
assert.deepEqual(calls[2], ["steer", "via http"]);

const abortReq = new EventEmitter();
abortReq.method = "POST";
const abortRes = mockRes();
const abortHandled = handleSessionControl(
  abortReq,
  abortRes,
  new URL("http://sidecar/api/sessions/chat-1/abort"),
  runtime,
);
assert.equal(await abortHandled, true);
assert.equal(abortRes.status, 200);
assert.deepEqual(calls[3], ["abort"]);

console.log("ok test-stop-steer");
