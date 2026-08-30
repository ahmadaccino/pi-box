#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectSnapshot, restoreSnapshot } from "../container/snapshot.mjs";

const tmp = path.join(os.tmpdir(), `pi-box-snap-${process.pid}-${Date.now()}`);
const agentDir = path.join(tmp, "agent");
const vaultDir = path.join(agentDir, "vault");
const sessionsDir = path.join(agentDir, "sessions");

await mkdir(vaultDir, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

const items = JSON.stringify(
  [
    {
      handle: "vlt_abc",
      kind: "login",
      ciphertext: { alg: "aes-256-gcm", iv: "aa", tag: "bb", data: "cc" },
    },
  ],
  null,
  2,
);
const sessionBody = `{"type":"session","id":"chat-1"}\n{"type":"message","role":"user","text":"hi"}\n`;

await writeFile(path.join(vaultDir, "items.json"), items, { mode: 0o600 });
await writeFile(path.join(sessionsDir, "2026-01-01_chat-1.jsonl"), sessionBody, {
  mode: 0o600,
});

const snap = await collectSnapshot(agentDir);
assert.ok(snap.files["vault/items.json"]);
assert.ok(snap.files["sessions/2026-01-01_chat-1.jsonl"]);
assert.equal(snap.files["vault/items.json"], items);
assert.equal(snap.files["sessions/2026-01-01_chat-1.jsonl"], sessionBody);

await rm(agentDir, { recursive: true, force: true });
await restoreSnapshot(agentDir, snap);

const items2 = await readFile(path.join(vaultDir, "items.json"), "utf8");
const sess2 = await readFile(path.join(sessionsDir, "2026-01-01_chat-1.jsonl"), "utf8");
assert.equal(items2, items);
assert.equal(sess2, sessionBody);

const outside = path.join(tmp, "pwned");
await restoreSnapshot(agentDir, {
  version: 1,
  files: {
    "../pwned": "nope",
    "vault/../../pwned": "nope",
    "sessions/ok.jsonl": "safe\n",
  },
});
const leaked = await readFile(outside, "utf8").catch(() => "");
assert.equal(leaked, "");
const ok = await readFile(path.join(sessionsDir, "ok.jsonl"), "utf8");
assert.equal(ok, "safe\n");

const big = "x".repeat(3 * 1024 * 1024);
await writeFile(path.join(sessionsDir, "big.jsonl"), big);
const tight = await collectSnapshot(agentDir);
assert.equal(tight.files["sessions/big.jsonl"], undefined);
const wide = await collectSnapshot(agentDir, {
  maxFile: 32 * 1024 * 1024,
  maxFiles: 500,
});
assert.equal(wide.files["sessions/big.jsonl"], big);

await rm(tmp, { recursive: true, force: true });
console.log("ok test-snapshot");
