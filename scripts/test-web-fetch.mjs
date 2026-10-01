#!/usr/bin/env node
/**
 * web_fetch returns readable markdown. web_search uses a provider key,
 * then a keyless fallback, and says when search is unavailable.
 */
import assert from "node:assert/strict";
import { htmlToMarkdown, resolveSearchProvider, webFetch, webSearch } from "../container/web-tools.mjs";
import { renderMarkdown } from "../public/markdown.js";

const html = `<!doctype html><html><head><title>Hello</title><style>body{}</style><script>alert(1)</script></head>
<body><h1>Title</h1><p>See <a href="https://example.com/a">docs</a>.</p>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<pre><code>const x = 1</code></pre></body></html>`;

const md = htmlToMarkdown(html);
assert.match(md, /# Hello/);
assert.match(md, /# Title/);
assert.match(md, /\[docs\]\(https:\/\/example.com\/a\)/);
assert.match(md, /\| A \| B \|/);
assert.match(md, /\| 1 \| 2 \|/);
assert.match(md, /const x = 1/);
assert.doesNotMatch(md, /alert\(1\)/);
assert.doesNotMatch(md, /body\{\}/);

const fetched = await webFetch("https://example.com/post", {
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    async text() {
      return html;
    },
  }),
});
assert.equal(fetched.ok, true);
assert.match(fetched.text, /<untrusted-web url="https:\/\/example.com\/post">/);
assert.match(fetched.text, /docs/);
assert.doesNotMatch(fetched.text, /alert/);

const blocked = await webFetch("file:///etc/passwd");
assert.equal(blocked.ok, false);
assert.match(blocked.text, /http and https/);

const failed = await webFetch("https://example.com/missing", {
  fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => "text/plain" }, async text() { return "nope"; } }),
});
assert.match(failed.text, /HTTP 404/);

assert.equal(resolveSearchProvider({ BRAVE_API_KEY: "brave-key" }).provider, "brave");
assert.equal(resolveSearchProvider({ SEARCH_PROVIDER: "exa", SEARCH_API_KEY: "exa-key" }).provider, "exa");
assert.equal(resolveSearchProvider({}, { tavily: "from-vault" }).provider, "tavily");
assert.equal(resolveSearchProvider({}).provider, "keyless");

const calls = [];
const brave = await webSearch("pi-box", {
  env: { BRAVE_API_KEY: "brave-secret-value" },
  vaultSecrets: {},
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { web: { results: [{ title: "Pi Box", url: "https://example.com/pi", description: "agent" }] } };
      },
    };
  },
});
assert.equal(brave.ok, true);
assert.match(brave.text, /Pi Box/);
assert.match(brave.text, /https:\/\/example.com\/pi/);
assert.match(calls[0].url, /api\.search\.brave\.com/);
assert.equal(calls[0].init.headers["x-subscription-token"], "brave-secret-value");
assert.doesNotMatch(brave.text, /brave-secret-value/);

const vaulted = await webSearch("calendar", {
  env: {},
  vaultSecrets: { exa: "exa-vault-key" },
  fetchImpl: async (url, init) => {
    assert.match(String(url), /api\.exa\.ai/);
    assert.equal(init.headers["x-api-key"], "exa-vault-key");
    return {
      ok: true,
      status: 200,
      async json() {
        return { results: [{ title: "Exa hit", url: "https://example.com/exa" }] };
      },
    };
  },
});
assert.match(vaulted.text, /Exa hit/);
assert.doesNotMatch(vaulted.text, /exa-vault-key/);

const keyless = await webSearch("open source agent", {
  env: {},
  vaultSecrets: {},
  fetchImpl: async (url) => {
    assert.match(String(url), /duckduckgo\.com/);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      async text() {
        return '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fagent">Agent page</a>';
      },
    };
  },
});
assert.match(keyless.text, /https:\/\/example.com\/agent/);
assert.match(keyless.text, /duckduckgo/);

const unavailable = await webSearch("nothing", {
  env: {},
  vaultSecrets: {},
  fetchImpl: async () => {
    throw new Error("blocked");
  },
});
assert.equal(unavailable.ok, false);
assert.equal(unavailable.unavailable, true);
assert.match(unavailable.text, /Search is unavailable/);
assert.match(unavailable.text, /BRAVE_API_KEY/);

const rendered = await webSearch("via browser", {
  env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "cf-token" },
  vaultSecrets: {},
  fetchImpl: async (url) => {
    const target = String(url);
    if (target.includes("duckduckgo.com")) {
      return { ok: false, status: 403, async text() { return ""; } };
    }
    assert.match(target, /browser-rendering\/markdown/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: "[Docs](https://example.com/docs)\n" };
      },
    };
  },
});
assert.match(rendered.text, /cloudflare-browser-rendering/);
assert.match(rendered.text, /https:\/\/example.com\/docs/);
assert.doesNotMatch(rendered.text, /cf-token/);

const transcript = renderMarkdown(
  "See `code` and\n\n```js\nconst n = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nEnergy $E=mc^2$ and\n\n$$a^2+b^2$$\n\n<script>alert(1)</script>",
);
assert.match(transcript, /<code>code<\/code>/);
assert.match(transcript, /class="language-js"/);
assert.match(transcript, /hl-kw/);
assert.match(transcript, /<table>/);
assert.match(transcript, /data-tex="E=mc\^2"/);
assert.match(transcript, /data-display="block"/);
assert.match(transcript, /&lt;script&gt;/);
assert.doesNotMatch(transcript, /<script>/);

console.log("ok test-web-fetch");
