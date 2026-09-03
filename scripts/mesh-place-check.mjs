#!/usr/bin/env node
import assert from "node:assert/strict";
import { inflightCap, isLive } from "../src/caps.ts";
import { place } from "../src/place.ts";

const NOW = 1_000_000;

function linux(over = {}) {
  return {
    id: "d_default_linux",
    name: "ryzen-box",
    caps: {
      os: "linux",
      arch: "x64",
      ramGb: 128,
      gpu: "nvidia",
      features: ["browser", "docker", "cuda"],
      platform: "linux",
      ios: false,
      android: false,
      browser: true,
      cloud: false,
    },
    lastSeen: NOW,
    drain: false,
    inflight: 0,
    ...over,
  };
}

function mini(over = {}) {
  return {
    id: "d_default_mini",
    name: "mac-mini",
    caps: {
      os: "darwin",
      arch: "arm64",
      ramGb: 32,
      gpu: "apple",
      features: ["browser", "ios-simulator"],
      platform: "darwin",
      ios: true,
      android: false,
      browser: true,
      cloud: false,
    },
    lastSeen: NOW,
    drain: false,
    inflight: 0,
    ...over,
  };
}

function pi(over = {}) {
  return {
    id: "d_default_pi",
    name: "pi",
    caps: {
      os: "linux",
      arch: "arm64",
      ramGb: 4,
      gpu: "none",
      features: ["browser"],
      platform: "linux",
      ios: false,
      android: false,
      browser: true,
      cloud: false,
    },
    lastSeen: NOW,
    drain: false,
    inflight: 0,
    ...over,
  };
}

function cloud(over = {}) {
  return {
    id: "cloud",
    name: "cloudflare",
    caps: {
      os: "linux",
      arch: "x64",
      ramGb: 4,
      gpu: "none",
      features: ["browser"],
      platform: "linux",
      ios: false,
      android: false,
      browser: true,
      cloud: true,
    },
    lastSeen: NOW,
    drain: false,
    inflight: 0,
    ...over,
  };
}

function job(over = {}) {
  return {
    id: "job_1",
    sessionId: "chat-1",
    agentId: "chat-1",
    require: [],
    prefer: [],
    affinity: null,
    fallback: "cloud",
    ...over,
  };
}

assert.equal(inflightCap(3), 1);
assert.equal(inflightCap(4), 1);
assert.equal(inflightCap(16), 4);
assert.equal(inflightCap(128), 8);
assert.equal(inflightCap(undefined, true), 1);

const asleepMini = mini({ lastSeen: NOW - 60_000 });
assert.equal(isLive(asleepMini, NOW), false);
assert.equal(isLive(linux(), NOW), true);
assert.equal(isLive(mini({ drain: true }), NOW), false);

{
  const got = place(job(), [linux(), asleepMini], cloud(), NOW);
  assert.equal(got.deviceId, "d_default_linux");
}

{
  const got = place(
    job({ require: ["ios"], fallback: "wait" }),
    [linux(), asleepMini],
    cloud(),
    NOW,
  );
  assert.equal(got.wait, true);
  assert.equal(got.deviceId, undefined);
}

{
  const got = place(
    job({ affinity: "d_default_mini" }),
    [linux(), mini()],
    cloud(),
    NOW,
  );
  assert.equal(got.deviceId, "d_default_mini");
}

{
  const got = place(job(), [], cloud(), NOW);
  assert.equal(got.deviceId, "cloud");
}

{
  const got = place(
    job({ require: ["ios"], fallback: "wait" }),
    [],
    cloud(),
    NOW,
  );
  assert.equal(got.wait, true);
  assert.notEqual(got.deviceId, "cloud");
}

{
  const got = place(job(), [linux(), mini({ drain: true })], cloud(), NOW);
  assert.equal(got.deviceId, "d_default_linux");
}

{
  const box = pi();
  assert.equal(inflightCap(box.caps.ramGb), 1);
  const full = place(job(), [pi({ inflight: 1 })], cloud(), NOW);
  assert.equal(full.deviceId, "cloud");
  const open = place(job(), [pi({ inflight: 0 })], null, NOW);
  assert.equal(open.deviceId, "d_default_pi");
}

{
  const got = place(
    job({ require: ["gpu=nvidia"] }),
    [linux(), mini()],
    cloud(),
    NOW,
  );
  assert.equal(got.deviceId, "d_default_linux");
}

{
  const got = place(job({ prefer: ["gpu=nvidia"] }), [linux(), mini()], cloud(), NOW);
  assert.equal(got.deviceId, "d_default_linux");
}

{
  const got = place(job({ require: ["os=darwin"] }), [linux()], cloud(), NOW);
  assert.equal(got.fail, "no_capacity");
}

{
  const deadMini = mini({ lastSeen: NOW - 60_000 });
  const got = place(
    job({ affinity: "d_default_mini" }),
    [linux(), deadMini],
    cloud(),
    NOW,
  );
  assert.equal(got.deviceId, "d_default_linux");
}

{
  const got = place(
    job({ require: ["inference"] }),
    [linux({ caps: { ...linux().caps, features: ["browser", "cuda", "inference"] } }), mini()],
    cloud(),
    NOW,
  );
  assert.equal(got.deviceId, "d_default_linux");
}

{
  const noGpu = linux({
    caps: { ...linux().caps, gpu: "none", features: ["browser"] },
  });
  const got = place(
    job({ require: ["inference"], fallback: "wait" }),
    [noGpu, mini()],
    cloud(),
    NOW,
  );
  assert.equal(got.wait, true);
}

console.log("ok mesh-place-check");
