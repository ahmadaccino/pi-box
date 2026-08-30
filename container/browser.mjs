/**
 * Real browser execution for pi-box.
 * Playwright locally; CDP / CLOUDFLARE_BROWSER for Cloudflare Browser Rendering.
 * HTTP is mounted by server.mjs via handleBrowserHttp (see docs/browser.md).
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

const VIEWPORT = { width: 1280, height: 720 };
const SNIPPET_MS = 25_000;
const GOTO_MS = 20_000;
const MAX_CODE = 24_000;
const TEXT_SNIP = 1500;

const SEARCH_HOSTS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "yahoo.com",
  "startpage.com",
  "search.brave.com",
  "ecosia.org",
  "kagi.com",
  "www.google.com",
  "www.bing.com",
]);

const CLAIM_SELECTORS = {
  username: [
    "input[autocomplete=\"username\"]",
    "input[name=\"username\"]",
    "input[name=\"user\"]",
    "input[id=\"username\"]",
    "input[type=\"email\"]",
    "input[name=\"email\"]",
    "input[autocomplete=\"email\"]",
  ],
  email: [
    "input[type=\"email\"]",
    "input[autocomplete=\"email\"]",
    "input[name=\"email\"]",
  ],
  password: [
    "input[type=\"password\"]",
    "input[autocomplete=\"current-password\"]",
    "input[autocomplete=\"new-password\"]",
    "input[name=\"password\"]",
  ],
  name: [
    "input[autocomplete=\"cc-name\"]",
    "input[name=\"name\"]",
  ],
  cardNumber: [
    "input[autocomplete=\"cc-number\"]",
    "input[name=\"cardNumber\"]",
  ],
  cardExp: ["input[autocomplete=\"cc-exp\"]"],
  cardExpMonth: ["input[autocomplete=\"cc-exp-month\"]", "select[autocomplete=\"cc-exp-month\"]"],
  cardExpYear: ["input[autocomplete=\"cc-exp-year\"]", "select[autocomplete=\"cc-exp-year\"]"],
  cardCvc: ["input[autocomplete=\"cc-csc\"]", "input[name=\"cvc\"]", "input[name=\"cvv\"]"],
};

const sessions = new Map();
let cachedRuntime = null;
let cachedRuntimeAt = 0;
let enginePromise = null;
let playwrightMod = null;
let playwrightSpec = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function hasBin(bin) {
  try {
    await exec(process.platform === "win32" ? "where" : "which", [bin], { timeout: 1500 });
    return true;
  } catch { return false; }
}

async function pathExists(p, mode = fsConstants.F_OK) {
  try { await access(p, mode); return true; } catch { return false; }
}

export function profileDir() {
  if (process.env.PI_BROWSER_PROFILE) return process.env.PI_BROWSER_PROFILE;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) return path.resolve(agentDir, "..", "browser-profile");
  return path.join(os.homedir(), ".pi", "browser-profile");
}

function shotDir() { return path.join(os.tmpdir(), "pi-box-browser"); }
function shotPath(id) { return path.join(shotDir(), id + ".png"); }

function isSearchHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (SEARCH_HOSTS.has(host) || SEARCH_HOSTS.has(bare)) return true;
  if (bare === "google.com" || bare.endsWith(".google.com")) return true;
  if (bare === "bing.com" || bare.endsWith(".bing.com")) return true;
  return false;
}

export function assertNotSearchEngine(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) urls are allowed");
  if (isSearchHost(u.hostname)) {
    throw new Error("search engines are not allowed in the browser; use web_search / web_fetch, then open a specific result URL");
  }
  return u.href;
}

async function loadPlaywright() {
  if (playwrightMod) return playwrightMod;
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      const mod = await import(spec);
      const pw = mod.chromium ? mod : mod.default;
      if (pw && pw.chromium) {
        playwrightMod = pw;
        playwrightSpec = spec;
        return playwrightMod;
      }
    } catch { /* not installed */ }
  }
  return null;
}

async function findChromium(pw) {
  if (pw && pw.chromium) {
    try {
      const exe = pw.chromium.executablePath();
      if (exe && (await pathExists(exe))) return { kind: "playwright-browser", path: exe };
    } catch { /* browsers not installed */ }
  }
  const bins = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "playwright"];
  for (const bin of bins) {
    if (await hasBin(bin)) return { kind: "binary", path: bin };
  }
  const extras = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  for (const extra of extras) {
    if (await pathExists(extra)) return { kind: "path", path: extra };
  }
  return null;
}

export function resetBrowserRuntimeCache() {
  cachedRuntime = null;
  cachedRuntimeAt = 0;
}

/** Headers for Playwright connectOverCDP. Never log BROWSER_CDP_TOKEN. */
export function cdpConnectHeaders() {
  const token = process.env.BROWSER_CDP_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function detectBrowserRuntime() {
  const now = Date.now();
  if (cachedRuntime && now - cachedRuntimeAt < 4000) return cachedRuntime;
  const cdp = process.env.BROWSER_CDP_URL;
  if (cdp) {
    cachedRuntime = { available: true, kind: "cloudflare", detail: "BROWSER_CDP_URL" };
    cachedRuntimeAt = now;
    return cachedRuntime;
  }
  if (process.env.CLOUDFLARE_BROWSER === "1") {
    cachedRuntime = {
      available: false,
      kind: "cloudflare",
      detail: "CLOUDFLARE_BROWSER=1 but BROWSER_CDP_URL is unset",
    };
    cachedRuntimeAt = now;
    return cachedRuntime;
  }
  const pw = await loadPlaywright();
  const chrome = await findChromium(pw);
  if (pw && chrome) {
    cachedRuntime = { available: true, kind: "playwright", detail: (playwrightSpec || "playwright") + " + " + chrome.kind + ":" + chrome.path };
  } else if (pw) {
    cachedRuntime = { available: true, kind: "playwright", detail: (playwrightSpec || "playwright") + " loaded (chromium resolved at launch)" };
  } else if (chrome) {
    cachedRuntime = { available: true, kind: "playwright", detail: "chromium at " + chrome.path + "; install playwright to drive it" };
  } else {
    cachedRuntime = { available: false, kind: null, detail: "no playwright module, chromium binary, or BROWSER_CDP_URL" };
  }
  cachedRuntimeAt = now;
  return cachedRuntime;
}

function publicSession(s) {
  return {
    id: s.id,
    startUrl: s.startUrl || null,
    url: s.url || null,
    title: s.title || null,
    kind: s.kind,
    takeover: Boolean(s.takeover),
    secretsFilled: Boolean(s.secretsFilled),
    createdAt: s.createdAt,
    liveView: "/api/browsers/" + s.id + "/live",
  };
}

export function browserPublicStatus() {
  const runtime = cachedRuntime || { available: false, kind: null };
  return {
    available: Boolean(runtime.available),
    kind: runtime.kind,
    sessions: [...sessions.values()].map(publicSession),
  };
}

async function refreshMeta(session) {
  if (!session || !session.page) return session;
  try { session.url = session.page.url(); } catch { /* closed */ }
  try { session.title = await session.page.title(); } catch { /* ignore */ }
  session.lastActionAt = Date.now();
  return session;
}

function compactValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => {
      if (typeof v === "string" && v.length > 400) return v.slice(0, 400) + "\u2026";
      if (typeof v === "function") return undefined;
      return v;
    }));
  } catch {
    return String(value).slice(0, 400);
  }
}

async function pageText(page) {
  try {
    const t = await page.innerText("body");
    return String(t || "").replace(/\s+/g, " ").trim().slice(0, TEXT_SNIP);
  } catch {
    return null;
  }
}

async function snapshot(session, extra) {
  await refreshMeta(session);
  const text = session.page ? await pageText(session.page) : null;
  return Object.assign({
    id: session.id,
    url: session.url || null,
    title: session.title || null,
    text,
    takeover: Boolean(session.takeover),
    liveView: "/api/browsers/" + session.id + "/live",
  }, extra || {});
}

async function ensureEngine() {
  if (!enginePromise) {
    enginePromise = bootEngine().catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

async function bootEngine() {
  const runtime = await detectBrowserRuntime();
  const pw = await loadPlaywright();
  if (!runtime.available) {
    return { kind: null, playwright: pw, browser: null, context: null, pending: runtime.detail };
  }
  if (runtime.kind === "cloudflare") {
    const cdp = process.env.BROWSER_CDP_URL;
    if (cdp && pw) {
      const browser = await pw.chromium.connectOverCDP(cdp, {
        headers: cdpConnectHeaders(),
      });
      const context = browser.contexts()[0] || (await browser.newContext({ viewport: VIEWPORT }));
      return { kind: "cloudflare", playwright: pw, browser, context, persistent: false };
    }
    return {
      kind: "cloudflare",
      playwright: pw,
      browser: null,
      context: null,
      pending: cdp ? "playwright/playwright-core required to connectOverCDP" : "CLOUDFLARE_BROWSER set; missing BROWSER_CDP_URL",
    };
  }
  if (!pw) {
    return { kind: "playwright", playwright: null, browser: null, context: null, pending: "playwright module not installed" };
  }
  return launchLocal(pw);
}

async function launchLocal(pw) {
  const profile = profileDir();
  await mkdir(profile, { recursive: true });
  const headless = process.env.PI_BROWSER_HEADLESS !== "0";
  const chrome = await findChromium(pw);
  const launchOpts = {
    headless,
    viewport: VIEWPORT,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
  if (chrome && (chrome.kind === "path" || (chrome.kind === "binary" && String(chrome.path).includes("/")))) {
    launchOpts.executablePath = chrome.path;
  } else if (chrome && chrome.kind === "binary" && /chrome/.test(chrome.path) && chrome.path !== "playwright") {
    if (chrome.path.includes("chromium")) launchOpts.executablePath = chrome.path;
    else launchOpts.channel = "chrome";
  }
  try {
    const context = await pw.chromium.launchPersistentContext(profile, launchOpts);
    return { kind: "playwright", playwright: pw, browser: context.browser(), context, persistent: true };
  } catch (err) {
    const browser = await pw.chromium.launch({
      headless,
      args: launchOpts.args,
      executablePath: launchOpts.executablePath,
      channel: launchOpts.channel,
    });
    const context = await browser.newContext({ viewport: VIEWPORT });
    return { kind: "playwright", playwright: pw, browser, context, persistent: false, launchNote: err && err.message ? err.message : String(err) };
  }
}

export async function create(opts) {
  opts = opts || {};
  let href = null;
  if (opts.startUrl) href = assertNotSearchEngine(String(opts.startUrl));
  const runtime = await detectBrowserRuntime();
  let engine;
  try { engine = await ensureEngine(); }
  catch (err) {
    engine = { kind: runtime.kind, context: null, browser: null, pending: err && err.message ? err.message : String(err) };
  }
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  let page = null;
  let context = engine.context || null;
  let error = null;
  try {
    if (engine.context) {
      page = await engine.context.newPage();
      await page.setViewportSize(VIEWPORT);
      if (href) await page.goto(href, { waitUntil: "domcontentloaded", timeout: GOTO_MS });
    } else if (engine.browser) {
      context = await engine.browser.newContext({ viewport: VIEWPORT });
      page = await context.newPage();
      if (href) await page.goto(href, { waitUntil: "domcontentloaded", timeout: GOTO_MS });
    } else {
      error = engine.pending || runtime.detail || "browser runtime unavailable";
    }
  } catch (err) {
    error = err && err.message ? err.message : String(err);
    try { if (page) await page.close(); } catch { /* ignore */ }
    page = null;
  }
  const session = {
    id, startUrl: href, createdAt: Date.now(), lastActionAt: Date.now(),
    url: href, title: null, page, context, kind: engine.kind || runtime.kind,
    takeover: false, secretsFilled: false, lastScreenshotPath: null, error,
  };
  sessions.set(id, session);
  await refreshMeta(session);
  return session;
}

export function get(id) { return sessions.get(id) || null; }
export function list() { return [...sessions.values()].map(publicSession); }

export async function remove(id) {
  const session = sessions.get(id);
  if (!session) return false;
  try { if (session.page) await session.page.close({ runBeforeUnload: false }); } catch { /* ignore */ }
  sessions.delete(id);
  return true;
}

export async function liveView(id) {
  const session = sessions.get(id);
  if (!session) return null;
  return { url: "/api/browsers/" + id + "/live", screenshot: "/api/browsers/" + id + "/screenshot", session: publicSession(session) };
}

async function writeScreenshot(session) {
  await mkdir(shotDir(), { recursive: true });
  const dest = shotPath(session.id);
  if (!session.page) throw new Error(session.error || "no live page");
  await session.page.screenshot({ path: dest, type: "png", fullPage: false });
  session.lastScreenshotPath = dest;
  return dest;
}

export async function screenshot(id, opts) {
  opts = opts || {};
  const session = sessions.get(id);
  if (!session) throw new Error("unknown browser session");
  if (opts.agent && session.secretsFilled) {
    return {
      skipped: true,
      reason: "secrets filled - not capturing",
      path: session.lastScreenshotPath,
      url: "/api/browsers/" + id + "/screenshot",
    };
  }
  const dest = await writeScreenshot(session);
  const info = await stat(dest);
  return { skipped: false, path: dest, bytes: info.size, contentType: "image/png", url: "/api/browsers/" + id + "/screenshot" };
}

export async function executePlaywright(opts) {
  opts = opts || {};
  const session = sessions.get(opts.sessionId);
  if (!session) throw new Error("unknown browser session");
  if (!session.page) {
    return snapshot(session, { result: null, error: session.error || "browser runtime unavailable" });
  }
  const code = opts.code;
  if (typeof code !== "string" || !code.trim()) {
    return snapshot(session, { result: null, error: "code required" });
  }
  if (code.length > MAX_CODE) {
    return snapshot(session, { result: null, error: "code too large" });
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let result = null;
  let error = null;
  let timer;
  try {
    const fn = new AsyncFunction("page", "context", code);
    result = await Promise.race([
      fn(session.page, session.context),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("playwright snippet timed out after 25s")), SNIPPET_MS);
      }),
    ]);
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  await refreshMeta(session);
  return snapshot(session, { result: compactValue(result), error });
}

export async function computerAction(opts) {
  opts = opts || {};
  const session = sessions.get(opts.sessionId);
  if (!session) throw new Error("unknown browser session");
  const act = String(opts.action || "").toLowerCase();
  if (!act) throw new Error("action required");
  if (act === "takeover") {
    session.takeover = true;
    return {
      status: "takeover",
      message: "browser preserved; finish CAPTCHA/OTP/3DS in live view, then resume",
      liveView: "/api/browsers/" + session.id + "/live",
      session: publicSession(session),
    };
  }
  if (!session.page) {
    return { status: "error", message: session.error || "browser runtime unavailable", liveView: "/api/browsers/" + session.id + "/live" };
  }
  if (act === "screenshot") {
    const shot = await screenshot(session.id, { agent: true });
    return Object.assign({ status: shot.skipped ? "skipped" : "ok" }, shot, await snapshot(session));
  }
  if (act === "click") {
    if (opts.selector) {
      await session.page.locator(String(opts.selector)).first().click({ timeout: 8000 });
    } else {
      const x = Number(opts.x);
      const y = Number(opts.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires x,y or selector");
      await session.page.mouse.click(x, y);
    }
    return snapshot(session, { status: "ok", action: "click" });
  }
  if (act === "type") {
    const text = opts.text == null ? "" : String(opts.text);
    if (opts.selector) await session.page.locator(String(opts.selector)).first().fill(text);
    else await session.page.keyboard.type(text, { delay: opts.delay ? Number(opts.delay) : 20 });
    if (opts.submit) await session.page.keyboard.press("Enter");
    return snapshot(session, { status: "ok", action: "type" });
  }
  return computerActionMore(session, act, opts);
}

async function computerActionMore(session, act, opts) {
  if (act === "key" || act === "press") {
    await session.page.keyboard.press(String(opts.key || opts.name || "Enter"));
    return snapshot(session, { status: "ok", action: "key" });
  }
  if (act === "scroll") {
    const dx = Number(opts.dx || opts.deltaX || 0) || 0;
    const dy = Number(opts.dy || opts.deltaY || opts.y || 400) || 0;
    await session.page.mouse.wheel(dx, dy);
    return snapshot(session, { status: "ok", action: "scroll" });
  }
  if (act === "hover") {
    const x = Number(opts.x);
    const y = Number(opts.y);
    if (Number.isFinite(x) && Number.isFinite(y)) await session.page.mouse.move(x, y);
    else if (opts.selector) await session.page.locator(String(opts.selector)).first().hover();
    else throw new Error("hover requires x,y or selector");
    return snapshot(session, { status: "ok", action: "hover" });
  }
  if (act === "goto") {
    const href = assertNotSearchEngine(String(opts.url || opts.startUrl || ""));
    await session.page.goto(href, { waitUntil: "domcontentloaded", timeout: GOTO_MS });
    return snapshot(session, { status: "ok", action: "goto" });
  }
  if (act === "wait") {
    const ms = Math.min(10000, Math.max(0, Number(opts.ms || opts.timeout || 1000) || 0));
    await sleep(ms);
    return snapshot(session, { status: "ok", action: "wait" });
  }
  throw new Error("unknown action: " + act);
}

async function fillBySelectors(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const n = await loc.count();
      if (!n) continue;
      if (sel.startsWith("select")) {
        await loc.selectOption({ label: String(value) }).catch(async () => {
          await loc.selectOption({ value: String(value) });
        });
      } else {
        await loc.fill(String(value), { timeout: 4000 });
      }
      return true;
    } catch { /* try next */ }
  }
  return false;
}

export async function fillNative(opts) {
  opts = opts || {};
  const sessionId = opts.browserSessionId || opts.sessionId;
  if (!sessionId) throw new Error("no browser session");
  const session = sessions.get(sessionId);
  if (!session) throw new Error("no browser session");
  if (!session.page) throw new Error(session.error || "no live page");
  const claims = opts.claims && typeof opts.claims === "object" ? opts.claims : {};
  const kind = String(opts.kind || "focused");
  const filled = [];
  const tryKey = async (key) => {
    if (claims[key] == null || claims[key] === "") return;
    const selectors = CLAIM_SELECTORS[key];
    if (selectors && (await fillBySelectors(session.page, selectors, claims[key]))) filled.push(key);
  };
  if (kind === "focused") {
    const first = Object.values(claims).find((v) => v != null && v !== "");
    if (first == null) throw new Error("no claim to fill");
    await session.page.keyboard.type(String(first), { delay: 15 });
    filled.push("focused");
  } else if (kind === "login") {
    await tryKey("username");
    if (!filled.includes("username")) await tryKey("email");
    await tryKey("password");
  } else if (kind === "card" || kind === "payment") {
    await tryKey("name");
    await tryKey("cardNumber");
    await tryKey("cardExp");
    await tryKey("cardExpMonth");
    await tryKey("cardExpYear");
    await tryKey("cardCvc");
  } else {
    for (const key of Object.keys(CLAIM_SELECTORS)) await tryKey(key);
    if (!filled.length) {
      const first = Object.values(claims).find((v) => v != null && v !== "");
      if (first != null) {
        await session.page.keyboard.type(String(first), { delay: 15 });
        filled.push("focused");
      }
    }
  }
  session.secretsFilled = true;
  session.lastActionAt = Date.now();
  await refreshMeta(session);
  return { status: "ok", filled, kind, sessionId: session.id, url: session.url || null };
}

function liveHtml(session) {
  const id = session.id;
  const banner = session.takeover
    ? "<div class=\"banner\">Takeover - finish CAPTCHA / OTP / 3DS here, then tell the agent to resume.</div>"
    : "";
  return "<!doctype html><html lang=en><head><meta charset=utf-8 /><meta name=viewport content=\"width=device-width, initial-scale=1\" /><title>pi-box live</title><style>:root{--bg:#12110e;--ink:#ece7dc;--mute:#9a9283;--line:#2c2922;--amber:#e6a23c;--paper:#1b1914}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}.bar{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--paper);font-family:ui-monospace,Menlo,monospace;font-size:12px}.url{color:var(--mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.banner{background:#241f18;color:var(--amber);padding:8px 12px;font-size:13px;border-bottom:1px solid var(--line)}.stage{display:grid;place-items:center;height:calc(100% - 48px);overflow:auto}img{max-width:100%;background:#000}</style></head><body><div class=bar><span>session " + id + "</span><span class=url id=url></span></div>" + banner + "<div class=stage><img id=shot alt=browser /></div><script>const img=document.getElementById('shot');const urlEl=document.getElementById('url');const sid=" + JSON.stringify(id) + ";function tick(){img.src='/api/browsers/'+sid+'/screenshot?t='+Date.now()}tick();setInterval(tick,900);fetch('/api/browsers/'+sid).then(function(r){return r.json()}).then(function(j){if(j&&j.url)urlEl.textContent=j.url}).catch(function(){});</script></body></html>";
}

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res, code, html) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function readBody(req, limit) {
  limit = limit || 1000000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function matchBrowserPath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/api/browsers") return { op: "root" };
  const m = p.match(/^\/api\/browsers\/([^/]+)(?:\/(live|screenshot|playwright|computer))?$/);
  if (!m) return null;
  return { op: m[2] || "one", id: decodeURIComponent(m[1]) };
}

export async function handleBrowserHttp(req, res, url) {
  const matched = matchBrowserPath(url.pathname);
  if (!matched) return false;
  const method = req.method || "GET";
  try {
    if (matched.op === "root" && method === "GET") {
      const runtime = await detectBrowserRuntime();
      sendJson(res, 200, Object.assign({}, runtime, { sessions: list() }));
      return true;
    }
    if (matched.op === "root" && method === "POST") {
      let body = {};
      try { body = await readBody(req); }
      catch { sendJson(res, 400, { error: "invalid json" }); return true; }
      try {
        const session = await create({ startUrl: body.startUrl || body.url || body.start_url });
        const runtime = await detectBrowserRuntime();
        sendJson(res, session.page ? 201 : 503, Object.assign({}, publicSession(session), {
          available: runtime.available,
          kind: runtime.kind,
          error: session.page ? null : session.error,
        }));
      } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
      }
      return true;
    }
    if (matched.op === "root") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    const session = get(matched.id);
    if (!session) {
      sendJson(res, 404, { error: "unknown browser session" });
      return true;
    }
    if (matched.op === "one" && method === "GET") {
      sendJson(res, 200, publicSession(session));
      return true;
    }
    if (matched.op === "one" && method === "DELETE") {
      await remove(matched.id);
      sendJson(res, 200, { ok: true, id: matched.id });
      return true;
    }
    return handleBrowserHttpRest(req, res, url, matched, session, method);
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
    return true;
  }
}

async function handleBrowserHttpRest(req, res, url, matched, session, method) {
  if (matched.op === "live" && method === "GET") {
    if (url.searchParams.get("takeover") === "1") session.takeover = true;
    sendHtml(res, 200, liveHtml(session));
    return true;
  }
  if (matched.op === "screenshot" && method === "GET") {
    try {
      const dest = await writeScreenshot(session);
      const buf = await readFile(dest);
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
        "content-length": buf.length,
      });
      res.end(buf);
    } catch (err) {
      sendJson(res, 503, { error: err && err.message ? err.message : String(err) });
    }
    return true;
  }
  if (matched.op === "playwright" && method === "POST") {
    let body = {};
    try { body = await readBody(req); }
    catch { sendJson(res, 400, { error: "invalid json" }); return true; }
    const out = await executePlaywright({ sessionId: session.id, code: body.code });
    sendJson(res, out.error && !session.page ? 503 : 200, out);
    return true;
  }
  if (matched.op === "computer" && method === "POST") {
    let body = {};
    try { body = await readBody(req); }
    catch { sendJson(res, 400, { error: "invalid json" }); return true; }
    try {
      const out = await computerAction(Object.assign({ sessionId: session.id }, body));
      sendJson(res, 200, out);
    } catch (err) {
      sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
    }
    return true;
  }
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}

export { sessions as _sessionsForTest };

export async function closeBrowserEngine() {
  if (!enginePromise) return;
  try {
    const eng = await enginePromise;
    try { if (eng && eng.context) await eng.context.close(); } catch { /* ignore */ }
    try { if (eng && eng.browser) await eng.browser.close(); } catch { /* ignore */ }
  } catch { /* ignore */ }
  enginePromise = null;
}
