#!/usr/bin/env node
import assert from "node:assert/strict";
import { fetchPrettyAsset } from "../src/pretty-asset.ts";

/**
 * Mimic Cloudflare Assets html_handling=auto-trailing-slash:
 * /foo.html → 307 /foo, /foo → 200 foo.html body.
 */
function mockAssets() {
  /** @type {{ pathname: string, redirect: RequestRedirect }[]} */
  const fetches = [];
  return {
    fetches,
    async fetch(request) {
      const url = new URL(request.url);
      fetches.push({ pathname: url.pathname, redirect: request.redirect });
      if (url.pathname === "/plugins.html") {
        return new Response(null, {
          status: 307,
          headers: { Location: "/plugins" + url.search },
        });
      }
      if (url.pathname === "/vault.html") {
        return new Response(null, {
          status: 307,
          headers: { Location: "/vault" + url.search },
        });
      }
      if (url.pathname === "/plugins") {
        return new Response(
          "<!doctype html><title>pi-box plugins</title><h1>plugins</h1>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname === "/vault") {
        return new Response(
          "<!doctype html><title>pi-box vault</title><h1>vault</h1>",
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  };
}

async function serve(path) {
  const assets = mockAssets();
  const res = await fetchPrettyAsset(
    assets,
    new Request("https://pi-box.example" + path),
  );
  return { assets, res };
}

{
  const { assets, res } = await serve("/plugins");
  assert.ok(res, "GET /plugins must be handled");
  assert.equal(res.status, 200, "must not 307-loop back to /plugins");
  assert.equal(res.headers.get("location"), null);
  assert.match(await res.text(), /pi-box plugins/);
  assert.equal(assets.fetches.length, 1);
  assert.equal(assets.fetches[0].pathname, "/plugins");
  assert.equal(
    assets.fetches[0].redirect,
    "manual",
    "ASSETS.fetch must not follow a 307 back onto the pretty path",
  );
}

{
  const { assets, res } = await serve("/plugins.html?google=connected");
  assert.ok(res);
  assert.equal(res.status, 200, "/plugins.html must not 307 to /plugins");
  assert.match(await res.text(), /pi-box plugins/);
  assert.equal(assets.fetches[0].pathname, "/plugins");
  assert.equal(assets.fetches[0].redirect, "manual");
}

{
  const { assets, res } = await serve("/vault");
  assert.ok(res);
  assert.equal(res.status, 200, "must not 307-loop back to /vault");
  assert.match(await res.text(), /pi-box vault/);
  assert.equal(assets.fetches[0].pathname, "/vault");
  assert.equal(assets.fetches[0].redirect, "manual");
}

{
  const { res } = await serve("/vault.html");
  assert.ok(res);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /pi-box vault/);
}

{
  const { res } = await serve("/");
  assert.equal(res, null, "chat/index stays on the default ASSETS path");
}

console.log("ok test-pretty-asset");
