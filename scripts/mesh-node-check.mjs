#!/usr/bin/env node
/**
 * Headless pi-box node: caps, join args, NACK, inference env, HTTP poll inbox.
 */
import assert from "node:assert/strict";
import { MeshStore, hashSecret } from "../src/mesh-state.ts";
import { handleMeshRequest, isDeviceTokenPath } from "../src/mesh-http.ts";
import { satisfiesRequire } from "../src/caps.ts";
import {
  INFERENCE_URL,
  applyJobEnv,
  identityPaths,
  parseNodeArgs,
  sanitizeCaps,
  snapshotUrls,
  unsatisfiedCaps,
} from "../container/node-logic.mjs";

{
  const linux = sanitizeCaps({
    os: "linux",
    platform: "linux",
    arch: "arm64",
    ios: true,
    features: ["ios-simulator", "browser"],
  });
  assert.equal(linux.ios, false);
  assert.equal(linux.features.includes("ios-simulator"), false);
  assert.equal(linux.features.includes("browser"), true);
}

{
  const darwin = sanitizeCaps({
    os: "darwin",
    platform: "darwin",
    ios: true,
    features: ["ios-simulator"],
  });
  assert.equal(darwin.ios, true);
  assert.deepEqual(darwin.features, ["ios-simulator"]);
}

{
  const caps = sanitizeCaps({
    os: "linux",
    platform: "linux",
    ios: false,
    browser: true,
    features: ["browser"],
  });
  assert.deepEqual(unsatisfiedCaps({ require: ["ios"] }, caps), ["ios"]);
  assert.deepEqual(unsatisfiedCaps({ require: ["ios-simulator"] }, caps), [
    "ios-simulator",
  ]);
  assert.deepEqual(unsatisfiedCaps({ require: ["browser"] }, caps), []);
}

{
  const parsed = parseNodeArgs([
    "node",
    "--origin",
    "http://127.0.0.1:8787",
    "--name",
    "ryzen-box",
    "--password",
    "secret",
  ]);
  assert.equal(parsed.command, "node");
  assert.equal(parsed.origin, "http://127.0.0.1:8787");
  assert.equal(parsed.name, "ryzen-box");
  assert.equal(parsed.password, "secret");
}

{
  const parsed = parseNodeArgs(["join", "--origin", "https://pi-box.ahmad-096.workers.dev"]);
  assert.equal(parsed.command, "node");
  assert.equal(parsed.origin, "https://pi-box.ahmad-096.workers.dev");
}

{
  const paths = identityPaths("/tmp/pi-box-home");
  assert.equal(paths.dir, "/tmp/pi-box-home");
  assert.ok(paths.secret.endsWith("device.secret"));
  assert.ok(paths.meta.endsWith("device.json"));
}

{
  const urls = snapshotUrls("http://127.0.0.1:8787", "chat-1");
  assert.equal(urls.get, "http://127.0.0.1:8787/api/sessions/chat-1/snapshot");
  assert.equal(urls.put, "http://127.0.0.1:8787/api/sessions/chat-1/snapshot");
}

{
  const withGpu = {
    gpu: "nvidia",
    features: ["inference", "cuda"],
  };
  const env = applyJobEnv(
    { env: { OPENROUTER_API_KEY: "sk-cloud", OPENAI_API_KEY: "" } },
    withGpu,
    {},
  );
  assert.equal(env.OPENAI_BASE_URL, INFERENCE_URL);
  assert.notEqual(env.OPENROUTER_API_KEY, "sk-cloud");
}

{
  const portable = applyJobEnv(
    { env: { OPENROUTER_API_KEY: "sk-cloud", ANTHROPIC_API_KEY: "sk-ant" } },
    { gpu: "none", features: ["browser"] },
    { OPENROUTER_API_KEY: "" },
  );
  assert.equal(portable.OPENROUTER_API_KEY, "sk-cloud");
  assert.equal(portable.ANTHROPIC_API_KEY, "sk-ant");
  assert.equal(portable.OPENAI_BASE_URL, undefined);
}

assert.equal(satisfiesRequire({ features: ["inference"] }, "inference"), true);
assert.equal(
  satisfiesRequire({ features: ["inference"] }, "inference=openai-compat"),
  true,
);
assert.equal(satisfiesRequire({ features: ["browser"] }, "inference"), false);

assert.equal(isDeviceTokenPath("/api/devices/poll"), true);
assert.equal(isDeviceTokenPath("/api/devices/ack"), true);
assert.equal(isDeviceTokenPath("/api/devices/nack"), true);
assert.equal(isDeviceTokenPath("/api/devices/event"), true);

const NOW = 5_000_000;
const store = new MeshStore();
const uuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "c".repeat(64);
const hash = await hashSecret(secret);
const registered = store.register({
  meshId: "default",
  name: "pi",
  caps: { os: "linux", arch: "arm64", ramGb: 4, ios: false, browser: true },
  tokenHash: hash,
  now: NOW,
  uuid,
});
const job = store.enqueue({
  id: "job_poll",
  sessionId: "chat-poll",
  require: [],
  now: NOW,
});
store.tryLease({ jobId: job.id, deviceId: registered.deviceId, now: NOW });
assert.equal(store.inbox(registered.deviceId).length, 1);
assert.equal(store.inbox(registered.deviceId)[0].id, "job_poll");

async function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("x-pi-box-mesh", "default");
  const req = new Request("https://pi-box.test" + path, { ...init, headers });
  return handleMeshRequest({
    store,
    request: req,
    meshId: "default",
    now: NOW,
    browser: true,
  });
}

{
  const res = await call("/api/devices/poll", {
    method: "POST",
    headers: {
      "x-pi-box-actor": "device",
      "x-pi-box-device": registered.deviceId,
      authorization: "Bearer " + secret,
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.job.id, "job_poll");
  assert.equal(body.job.sessionId, "chat-poll");
}

{
  const res = await call("/api/devices/nack", {
    method: "POST",
    headers: {
      "x-pi-box-actor": "device",
      "x-pi-box-device": registered.deviceId,
      authorization: "Bearer " + secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jobId: "job_poll", unsatisfied: ["ios"] }),
  });
  assert.equal(res.status, 200);
  const after = store.getJob("job_poll");
  assert.equal(after.state, "queued");
  assert.ok(after.require.includes("ios"));
}

{
  store.tryLease({
    jobId: "job_poll",
    deviceId: registered.deviceId,
    now: NOW + 10,
  });
  const res = await call("/api/devices/ack", {
    method: "POST",
    headers: {
      "x-pi-box-actor": "device",
      "x-pi-box-device": registered.deviceId,
      authorization: "Bearer " + secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jobId: "job_poll" }),
  });
  assert.equal(res.status, 200);
  assert.equal(store.getJob("job_poll")?.state, "done");
  assert.equal(store.lastDevice("chat-poll"), registered.deviceId);
}

console.log("ok mesh-node-check");
