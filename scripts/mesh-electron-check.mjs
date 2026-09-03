#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  DEFAULT_ORIGIN,
  KEYCHAIN_SERVICE,
  builderTargets,
  keychainAccount,
  sidecarArgs,
} from "../desktop/logic.mjs";

assert.equal(DEFAULT_ORIGIN, "https://pi-box.ahmad-096.workers.dev");
assert.equal(KEYCHAIN_SERVICE, "pi-box");

const targets = builderTargets();
assert.deepEqual(targets.mac, ["arm64", "x64"]);
assert.deepEqual(targets.linux, ["x64"]);
assert.ok(targets.linuxExcluded.includes("arm64"));

assert.equal(
  keychainAccount("https://pi-box.ahmad-096.workers.dev", "d_default_1"),
  "https://pi-box.ahmad-096.workers.dev::d_default_1",
);

const args = sidecarArgs({
  origin: "http://127.0.0.1:8787",
  name: "mac-mini",
  cookie: "pi_box_auth=abc",
});
assert.ok(args.includes("node"));
assert.ok(args.includes("--origin"));
assert.ok(args.includes("http://127.0.0.1:8787"));
assert.ok(args.includes("--name"));
assert.ok(args.includes("mac-mini"));

console.log("ok mesh-electron-check");
