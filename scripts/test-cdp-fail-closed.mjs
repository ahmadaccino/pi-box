#!/usr/bin/env node
/**
 * CDP fail-closed: CLOUDFLARE_BROWSER=1 alone must not claim a browser.
 */
import assert from "node:assert/strict";
import {
  detectBrowserRuntime,
  resetBrowserRuntimeCache,
  cdpConnectHeaders,
} from "../container/browser.mjs";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of ["CLOUDFLARE_BROWSER", "BROWSER_CDP_URL", "BROWSER_CDP_TOKEN"]) {
    if (saved[key] == null) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetBrowserRuntimeCache();
}

try {
  delete process.env.BROWSER_CDP_URL;
  delete process.env.BROWSER_CDP_TOKEN;
  process.env.CLOUDFLARE_BROWSER = "1";
  resetBrowserRuntimeCache();
  const closed = await detectBrowserRuntime();
  assert.equal(
    closed.available,
    false,
    "CLOUDFLARE_BROWSER=1 without BROWSER_CDP_URL must report available:false",
  );
  assert.equal(closed.kind, "cloudflare");

  process.env.BROWSER_CDP_URL =
    "wss://api.cloudflare.com/client/v4/accounts/test/browser-rendering/devtools/browser";
  process.env.BROWSER_CDP_TOKEN = "test-token-not-for-logs";
  resetBrowserRuntimeCache();
  const open = await detectBrowserRuntime();
  assert.equal(open.available, true);
  assert.equal(open.kind, "cloudflare");

  const headers = cdpConnectHeaders();
  assert.equal(headers.Authorization, "Bearer test-token-not-for-logs");
  assert.ok(!JSON.stringify(open).includes("test-token-not-for-logs"));

  console.log("ok test-cdp-fail-closed");
} finally {
  restoreEnv();
}
