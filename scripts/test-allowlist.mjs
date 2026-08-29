#!/usr/bin/env node
import assert from "node:assert/strict";
import { isProxyUrlAllowed, loadPluginPacks } from "../container/plugins.mjs";

const packs = await loadPluginPacks();
const names = packs.map((p) => p.id);
for (const id of ["gmail", "google-calendar", "telegram", "cloudflare"]) {
  assert.ok(names.includes(id), `missing pack ${id}`);
}

assert.equal(
  isProxyUrlAllowed("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/messages"),
  true,
);
assert.equal(
  isProxyUrlAllowed("gmail", "https://www.googleapis.com/gmail/v1/users/me/messages/send"),
  true,
);
assert.equal(isProxyUrlAllowed("gmail", "https://evil.example/steal"), false);
assert.equal(
  isProxyUrlAllowed("gmail", "https://oauth2.googleapis.com/token"),
  false,
  "token refresh host is internal, not on the plugin allowlist",
);

assert.equal(
  isProxyUrlAllowed(
    "google-calendar",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  ),
  true,
);
assert.equal(isProxyUrlAllowed("google-calendar", "http://www.googleapis.com/calendar"), false);

assert.equal(isProxyUrlAllowed("telegram", "https://api.telegram.org/botX/sendMessage"), true);
assert.equal(isProxyUrlAllowed("telegram", "https://api.telegram.org.evil/x"), false);

assert.equal(
  isProxyUrlAllowed("cloudflare", "https://api.cloudflare.com/client/v4/accounts"),
  true,
);
assert.equal(isProxyUrlAllowed("cloudflare", "https://api.cloudflare.com.evil/"), false);

console.log("ok test-allowlist");
