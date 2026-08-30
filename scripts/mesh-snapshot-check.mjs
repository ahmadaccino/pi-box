#!/usr/bin/env node
import assert from "node:assert/strict";
import { MeshStore } from "../src/mesh-state.ts";
import { snapshotKey } from "../src/snapshot-r2.ts";

assert.equal(
  snapshotKey("default", "chat-1"),
  "sessions/default/chat-1/snapshot.json",
);

const store = new MeshStore();
store.putPointer({
  sessionId: "chat-1",
  r2Key: snapshotKey("default", "chat-1"),
  etag: "etag-1",
  updatedAt: 9,
});
assert.equal(store.getPointer("chat-1")?.etag, "etag-1");
assert.equal(store.getPointer("missing"), undefined);

console.log("ok mesh-snapshot-check");
