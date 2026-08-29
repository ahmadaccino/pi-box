#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pluginAuthenticateUrl,
  authenticatePlugin,
} from "../container/plugins.mjs";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PI_BOX_PUBLIC_URL"]) {
    if (saved[key] == null) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-box-auth-"));
process.env.PI_CODING_AGENT_DIR = tmp;

try {
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.PI_BOX_PUBLIC_URL = "https://pi-box.ahmad-096.workers.dev";

  const gmail = pluginAuthenticateUrl("gmail");
  assert.equal(gmail.mode, "google");
  assert.equal(
    gmail.url,
    "https://pi-box.ahmad-096.workers.dev/api/oauth/google/start?plugin=gmail",
  );

  const cal = pluginAuthenticateUrl("google-calendar");
  assert.equal(cal.mode, "google");
  assert.ok(cal.url.includes("plugin=google-calendar"));

  const viaHandler = await authenticatePlugin("gmail");
  assert.ok(viaHandler.url.includes("/api/oauth/google/start?plugin=gmail"));
  assert.ok(!JSON.stringify(viaHandler).toLowerCase().includes("client-secret"));

  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const fallback = pluginAuthenticateUrl("gmail");
  assert.equal(fallback.mode, "vault");

  const vaulted = await authenticatePlugin("gmail");
  assert.ok(vaulted.url.includes("/vault"), "unset Google env must fall back to vault setup");
  assert.ok(vaulted.url.includes("setup="));
  assert.ok(!JSON.stringify(vaulted).includes("refresh_token"));

  const tg = pluginAuthenticateUrl("telegram");
  assert.equal(tg.mode, "vault");
  const tgUrl = await authenticatePlugin("telegram");
  assert.ok(tgUrl.url.includes("/vault"));

  console.log("ok test-authenticate-url");
} finally {
  restoreEnv();
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(tmp, { recursive: true, force: true });
}
