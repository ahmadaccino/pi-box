#!/usr/bin/env node
import assert from "node:assert/strict";
import { MeshStore, hashSecret } from "../src/mesh-state.ts";
import { handleMeshRequest } from "../src/mesh-http.ts";

const NOW = 3_000_000;
const store = new MeshStore();
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = "b".repeat(64);

async function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("x-pi-box-actor")) headers.set("x-pi-box-actor", "user");
  headers.set("x-pi-box-mesh", "default");
  const req = new Request("https://pi-box.test" + path, { ...init, headers });
  return handleMeshRequest({
    store,
    request: req,
    meshId: "default",
    now: NOW,
    browser: true,
    mintUuid: () => uuid,
    mintSecret: () => secret,
  });
}

{
  const res = await call("/api/devices", { method: "GET" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.devices[0].id, "cloud");
  assert.equal(body.devices[0].caps.ios, false);
  assert.equal(body.devices[0].caps.browser, true);
  assert.equal(body.devices.length, 1);
}

{
  const res = await call("/api/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "ryzen-box",
      caps: { os: "linux", ramGb: 128, ios: false, browser: true },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deviceId, `d_default_${uuid}`);
  assert.equal(body.deviceSecret, secret);
  assert.equal(store.get(body.deviceId)?.tokenHash, await hashSecret(secret));
}

{
  const listed = await (await call("/api/devices")).json();
  const row = listed.devices.find((d) => d.id !== "cloud");
  assert.equal(row.name, "ryzen-box");
  assert.equal(row.tokenHash, undefined);
  assert.equal(row.online, true);
}

{
  const res = await call("/api/devices/heartbeat", {
    method: "POST",
    headers: {
      "x-pi-box-actor": "device",
      "x-pi-box-device": `d_default_${uuid}`,
      authorization: "Bearer " + secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ caps: { os: "linux", ramGb: 64, browser: true } }),
  });
  assert.equal(res.status, 200);
  assert.equal(store.get(`d_default_${uuid}`)?.caps.ramGb, 64);
}

{
  const res = await call("/api/devices/heartbeat", {
    method: "POST",
    headers: {
      "x-pi-box-actor": "device",
      "x-pi-box-device": `d_default_${uuid}`,
      authorization: "Bearer wrong",
    },
  });
  assert.equal(res.status, 401);
}

{
  const res = await call(`/api/devices/d_default_${uuid}/drain`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(store.get(`d_default_${uuid}`)?.drain, true);
}

{
  const res = await call(`/api/devices/d_default_${uuid}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(store.get(`d_default_${uuid}`), undefined);
}

{
  const res = await call("/api/devices/connect", {
    method: "GET",
    headers: {
      upgrade: "websocket",
      "x-pi-box-actor": "device",
      "x-pi-box-device": "d_default_missing",
      authorization: "Bearer x",
    },
  });
  assert.equal(res.status, 401);
}

console.log("ok mesh-routes-check");
