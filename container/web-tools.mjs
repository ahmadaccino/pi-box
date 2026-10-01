/**
 * web_fetch (readable markdown) and web_search (Brave, Tavily, Exa, or a keyless fallback).
 */
import { getOAuthToken } from "./vault.mjs";

const MAX_CHARS = 80_000;
const MAX_BYTES = 1_000_000;

const UNAVAILABLE =
  "Search is unavailable. Set BRAVE_API_KEY, TAVILY_API_KEY, or EXA_API_KEY (or save an API key in the vault on the web-search, brave, tavily, or exa plugin). The keyless fallback did not return results.";

export function htmlToMarkdown(html) {
  let src = String(html || "");
  src = src.replace(/<script[\s\S]*?<\/script>/gi, "");
  src = src.replace(/<style[\s\S]*?<\/style>/gi, "");
  src = src.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  src = src.replace(/<!--[\s\S]*?-->/g, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  src = src.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    return `\n\n${"#".repeat(Number(level))} ${decodeEntities(stripTags(text))}\n\n`;
  });
  src = src.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    return `\n\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, ""))}\n\`\`\`\n\n`;
  });
  src = src.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return `\n\n\`\`\`\n${decodeEntities(stripTags(code))}\n\`\`\`\n\n`;
  });
  src = src.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const label = decodeEntities(stripTags(text)).trim() || href;
    return `[${label}](${href.trim()})`;
  });
  src = convertTables(src);
  src = src.replace(/<br\s*\/?>/gi, "\n");
  src = src.replace(/<\/(p|div|section|article|tr|li|h[1-6])>/gi, "\n");
  src = src.replace(/<li[^>]*>/gi, "\n- ");
  src = src.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `**${stripTags(text)}**`);
  src = src.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `*${stripTags(text)}*`);
  src = stripTags(src);
  src = decodeEntities(src);
  src = src.replace(/\r/g, "");
  src = src.replace(/[ \t]+\n/g, "\n");
  src = src.replace(/\n{3,}/g, "\n\n").trim();
  const heading = title ? `# ${decodeEntities(stripTags(title[1])).trim()}\n\n` : "";
  const body = heading && src.startsWith("# ") ? src : heading + src;
  return body.trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function convertTables(src) {
  return src.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
      const cells = [...match[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
        decodeEntities(stripTags(cell[1])).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(),
      );
      return cells;
    });
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => {
      const next = row.slice();
      while (next.length < width) next.push("");
      return `| ${next.join(" | ")} |`;
    });
    const rule = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
    return `\n\n${padded[0]}\n${rule}\n${padded.slice(1).join("\n")}\n\n`;
  });
}

function clip(text) {
  const value = String(text || "");
  if (value.length <= MAX_CHARS) return value;
  return `${value.slice(0, MAX_CHARS)}\n\n[truncated]`;
}

export function isFetchableUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readBody(res) {
  if (res.arrayBuffer) {
    const buf = await res.arrayBuffer();
    const view = new Uint8Array(buf).subarray(0, MAX_BYTES);
    return new TextDecoder().decode(view);
  }
  const text = await res.text();
  return text.slice(0, MAX_BYTES);
}

export async function webFetch(url, opts = {}) {
  const target = String(url || "").trim();
  if (!isFetchableUrl(target)) {
    return {
      ok: false,
      text: `web_fetch failed: only http and https URLs are allowed (${target || "missing url"}).`,
    };
  }
  const doFetch = opts.fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(target, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.1",
        "user-agent": "pi-box/web-fetch",
      },
    });
  } catch (err) {
    return { ok: false, text: `web_fetch failed: ${err?.message || "network error"}` };
  }
  const status = res.status || 0;
  if (status < 200 || status >= 300) {
    return { ok: false, text: `web_fetch failed: ${target} returned HTTP ${status}.` };
  }
  const raw = await readBody(res);
  const type = String(res.headers?.get?.("content-type") || opts.contentType || "");
  const markdown = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToMarkdown(raw) : raw.trim();
  const text = clip(`<untrusted-web url="${target}">\n${markdown}\n</untrusted-web>`);
  return { ok: true, text };
}

export function resolveSearchProvider(env = {}, vault = {}) {
  const provider = String(env.SEARCH_PROVIDER || vault.provider || "").trim().toLowerCase();
  const keys = {
    brave:
      env.BRAVE_API_KEY ||
      env.BRAVE_SEARCH_API_KEY ||
      (provider === "brave" ? env.SEARCH_API_KEY : "") ||
      vault.brave ||
      "",
    tavily:
      env.TAVILY_API_KEY ||
      (provider === "tavily" ? env.SEARCH_API_KEY : "") ||
      vault.tavily ||
      "",
    exa: env.EXA_API_KEY || (provider === "exa" ? env.SEARCH_API_KEY : "") || vault.exa || "",
  };
  if (provider && keys[provider]) return { provider, key: String(keys[provider]) };
  if (keys.brave) return { provider: "brave", key: String(keys.brave) };
  if (keys.tavily) return { provider: "tavily", key: String(keys.tavily) };
  if (keys.exa) return { provider: "exa", key: String(keys.exa) };
  return { provider: "keyless", key: "" };
}

export async function loadVaultSearchSecrets(loader = getOAuthToken) {
  const out = {};
  const names = ["web-search", "brave", "tavily", "exa"];
  for (const name of names) {
    let row = null;
    try {
      row = await loader(name);
    } catch {
      row = null;
    }
    const secrets = row?.secrets;
    if (!secrets || typeof secrets !== "object") continue;
    const key = String(secrets.api_key || secrets.apiKey || secrets.token || secrets.key || "");
    if (!key) continue;
    const provider = String(secrets.provider || (name === "web-search" ? "" : name)).toLowerCase();
    if (provider === "brave" || provider === "tavily" || provider === "exa") out[provider] = key;
    else if (name !== "web-search") out[name] = key;
  }
  return out;
}

function formatResults(provider, results) {
  const lines = results.slice(0, 8).map((item, index) => {
    const title = String(item.title || item.url || "result").trim();
    const url = String(item.url || "").trim();
    const snippet = String(item.snippet || "").replace(/\s+/g, " ").trim();
    return `${index + 1}. ${title}\n${url}${snippet ? `\n${snippet}` : ""}`;
  });
  return [`Search provider: ${provider}`, "", ...lines].join("\n");
}

function ddgResults(html) {
  const results = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    let href = decodeEntities(match[1]);
    try {
      const url = new URL(href, "https://duckduckgo.com");
      const wrapped = url.searchParams.get("uddg");
      if (wrapped) href = wrapped;
      else if (url.hostname.endsWith("duckduckgo.com")) continue;
      else href = url.toString();
    } catch {
      /* keep href */
    }
    const title = decodeEntities(stripTags(match[2])).replace(/\s+/g, " ").trim();
    if (!href || !title) continue;
    results.push({ title, url: href, snippet: "" });
    if (results.length >= 8) break;
  }
  return results;
}

async function searchBrave(query, key, doFetch) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await doFetch(url, { headers: { accept: "application/json", "x-subscription-token": key } });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  const rows = data?.web?.results || [];
  return rows.map((item) => ({ title: item.title, url: item.url, snippet: item.description || "" }));
}

async function searchTavily(query, key, doFetch) {
  const res = await doFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: 5 }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  return (data?.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content || "",
  }));
}

async function searchExa(query, key, doFetch) {
  const res = await doFetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ query, numResults: 5 }),
  });
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
  const data = await res.json();
  return (data?.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.text || item.snippet || "",
  }));
}

async function searchKeyless(query, doFetch) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await doFetch(url, {
    headers: { "user-agent": "pi-box/web-search", accept: "text/html" },
  });
  if (!res.ok) throw new Error(`keyless HTTP ${res.status}`);
  const html = await readBody(res);
  const results = ddgResults(html);
  if (!results.length) throw new Error("keyless search returned no results");
  return results;
}

function browserRenderingConfigured(env) {
  return Boolean(
    env.CLOUDFLARE_ACCOUNT_ID && (env.CLOUDFLARE_API_TOKEN || env.BROWSER_CDP_TOKEN),
  );
}

async function searchViaBrowserRendering(query, env, doFetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN || env.BROWSER_CDP_TOKEN;
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/markdown`;
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ url: target }),
  });
  if (!res.ok) throw new Error(`browser rendering HTTP ${res.status}`);
  const data = await res.json();
  const markdown = String(data?.result || data?.markdown || "");
  const results = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = re.exec(markdown))) {
    if (/duckduckgo\.com/i.test(match[2])) continue;
    results.push({ title: match[1], url: match[2], snippet: "" });
    if (results.length >= 8) break;
  }
  if (!results.length) throw new Error("browser rendering returned no results");
  return results;
}

export async function webSearch(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, unavailable: true, text: "Search is unavailable: query is empty." };
  const env = opts.env || process.env;
  let vault = opts.vaultSecrets;
  if (!vault) {
    try {
      vault = await loadVaultSearchSecrets(opts.loadVault);
    } catch {
      vault = {};
    }
  }
  const chosen = resolveSearchProvider(env, vault || {});
  const doFetch = opts.fetchImpl || fetch;
  try {
    let results;
    let provider = chosen.provider;
    if (chosen.provider === "brave") results = await searchBrave(q, chosen.key, doFetch);
    else if (chosen.provider === "tavily") results = await searchTavily(q, chosen.key, doFetch);
    else if (chosen.provider === "exa") results = await searchExa(q, chosen.key, doFetch);
    else {
      try {
        results = await searchKeyless(q, doFetch);
        provider = "duckduckgo";
      } catch (err) {
        if (!browserRenderingConfigured(env)) {
          return {
            ok: false,
            unavailable: true,
            text: `${UNAVAILABLE} (${err?.message || "keyless failed"}).`,
          };
        }
        results = await searchViaBrowserRendering(q, env, doFetch);
        provider = "cloudflare-browser-rendering";
      }
    }
    if (!results?.length) {
      return { ok: false, unavailable: true, text: UNAVAILABLE };
    }
    const text = `<untrusted-web>\n${formatResults(provider, results)}\n</untrusted-web>`;
    if (chosen.key && text.includes(chosen.key)) {
      return { ok: true, text: text.split(chosen.key).join("[redacted]") };
    }
    return { ok: true, text };
  } catch (err) {
    const why = err?.message || "search failed";
    if (chosen.provider !== "keyless") {
      return { ok: false, text: `web_search failed (${chosen.provider}): ${why}` };
    }
    return { ok: false, unavailable: true, text: `${UNAVAILABLE} (${why}).` };
  }
}
