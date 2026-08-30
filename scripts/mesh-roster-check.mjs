#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  hashSecret,
  mintDeviceId,
  parseMeshId,
  MeshStore,
} from "../src/mesh-state.ts";
import { jobFallback } from "../src/caps.ts";
import { place } from "../src/place.ts";

const NOW = 2_000_000;
const meshId = "default";

const linuxCaps = {
  os: "linux",
  arch: "x64",
  ramGb: 128,
  gpu: "nvidia",
  platform: "linux",
  ios: false,
  android: false,
  browser: true,
  cloud: false,
};

const miniCaps = {
  os: "darwin",
  arch: "arm64",
  ramGb: 32,
  gpu: "apple",
  platform: "darwin",
  ios: true,
  android: false,
  browser: true,
  cloud: false,
};

const secret = "dev-secret-once";
const hash = await hashSecret(secret);
assert.equal(hash.length, 64);
assert.notEqual(hash, secret);

const id = mintDeviceId(meshId, "11111111-1111-4111-8111-111111111111");
assert.equal(id, "d_default_11111111-1111-4111-8111-111111111111");
assert.equal(parseMeshId(id), "default");

const store = new MeshStore();
const registered = store.register({
  meshId,
  name: "ryzen-box",
  caps: linuxCaps,
  tokenHash: hash,
  now: NOW,
  uuid: "11111111-1111-4111-8111-111111111111",
});
assert.equal(registered.deviceId, id);
assert.equal(registered.device.tokenHash, hash);
assert.equal(JSON.stringify(registered.device).includes(secret), false);
assert.equal(store.get(id)?.name, "ryzen-box");

const bad = store.heartbeat({
  deviceId: id,
  tokenHash: await hashSecret("wrong"),
  caps: linuxCaps,
  now: NOW + 1000,
});
assert.equal(bad.ok, false);

const hb = store.heartbeat({
  deviceId: id,
  tokenHash: hash,
  caps: { ...linuxCaps, ramGb: 64 },
  now: NOW + 1000,
});
assert.equal(hb.ok, true);
assert.equal(store.get(id)?.caps.ramGb, 64);
assert.equal(store.get(id)?.lastSeen, NOW + 1000);

const mini = store.register({
  meshId,
  name: "mac-mini",
  caps: miniCaps,
  tokenHash: await hashSecret("mini-secret"),
  now: NOW,
  uuid: "22222222-2222-4222-8222-222222222222",
});

const job = store.enqueue({
  id: "job_1",
  sessionId: "chat-1",
  require: [],
  prefer: [],
  affinity: mini.deviceId,
  fallback: "cloud",
  now: NOW,
});
assert.equal(job.state, "queued");

const first = store.tryLease({ jobId: "job_1", deviceId: mini.deviceId, now: NOW });
assert.equal(first.ok, true);
assert.equal(store.getJob("job_1")?.leasedTo, mini.deviceId);
assert.equal(store.get(mini.deviceId)?.inflight, 1);

const loser = store.tryLease({ jobId: "job_1", deviceId: id, now: NOW + 10 });
assert.equal(loser.ok, false);
assert.equal(store.getJob("job_1")?.leasedTo, mini.deviceId);

store.nack({ jobId: "job_1", unsatisfied: ["ios"], now: NOW + 20 });
const afterNack = store.getJob("job_1");
assert.equal(afterNack?.state, "queued");
assert.deepEqual(afterNack?.require, ["ios"]);
assert.equal(afterNack?.fallback, "wait");
assert.equal(afterNack?.leasedTo, null);
assert.equal(store.get(mini.deviceId)?.inflight, 0);
assert.equal(jobFallback(afterNack.require), "wait");

store.tryLease({ jobId: "job_1", deviceId: mini.deviceId, now: NOW + 30 });
const swept = store.sweep(NOW + 46_000);
assert.ok(swept.dead.includes(id));
assert.ok(swept.dead.includes(mini.deviceId));
assert.equal(store.getJob("job_1")?.state, "queued");
assert.equal(store.get(mini.deviceId)?.inflight, 0);

store.heartbeat({
  deviceId: id,
  tokenHash: hash,
  caps: linuxCaps,
  now: NOW + 50_000,
});
store.heartbeat({
  deviceId: mini.deviceId,
  tokenHash: await hashSecret("mini-secret"),
  caps: miniCaps,
  now: NOW + 50_000,
});

assert.equal(store.drain(mini.deviceId), true);
assert.equal(store.get(mini.deviceId)?.drain, true);

const portable = store.enqueue({
  id: "job_2",
  sessionId: "chat-2",
  require: [],
  prefer: [],
  affinity: mini.deviceId,
  fallback: "cloud",
  now: NOW + 50_000,
});
const placed = place(
  portable,
  store.listDevices(),
  store.cloudDevice(NOW + 50_000),
  NOW + 50_000,
);
assert.equal(placed.deviceId, id);

const stillBusy = store.delete(mini.deviceId);
assert.equal(stillBusy.ok, true);
assert.equal(store.get(mini.deviceId), undefined);

console.log("ok mesh-roster-check");
