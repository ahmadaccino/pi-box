---
name: browser
description: Drive a real browser on this box (create a session with start_url, Playwright for DOM, computer_action for coordinates, live view for takeover). Use when a KNOWN url needs clicks, forms, or a screenshot. Do not use for general web search.
license: MIT
compatibility: Requires a browser on this host (Playwright/Chromium, or Cloudflare Browser Rendering via BROWSER_CDP_URL / CLOUDFLARE_BROWSER).
metadata: host=browser
---

# Browser execution

This skill is live only when the host reports `browser: true`.

The **coordinator** (chat sidecar) does `web_search` / `web_fetch`. Open the browser only for a **known URL that needs interaction**. Never open a search engine (Google, Bing, DDG, etc.) in the browser.

## Session contract

- One browser per assignment. Create with `startUrl`, then **reuse that session id**.
- Tools (via HTTP on this sidecar): `manage_browsers`, `execute_playwright_code`, `computer_action`, live view.
- Fast path: about **90 seconds** / **6 tool calls**. At most **two different tactics**. Then stop, report the blocker, and give the live-view URL.
- Prefer **Playwright** for DOM (selectors, fill, click, text). Use **computer_action** when you need a screenshot or x/y coordinates.
- Final reply is compact JSON: `{ "status": "ok"|"blocked"|"takeover", "message": "..." }` plus `liveView` when relevant.

## Base URL

```bash
BASE="${PI_BROWSER_API:-http://127.0.0.1:${PORT:-8788}}"
```

## manage_browsers

```bash
# list
curl -sS "$BASE/api/browsers"

# create (pass start_url)
curl -sS -X POST "$BASE/api/browsers" -H 'content-type: application/json' \
  -d '{"startUrl":"https://example.com/login"}'

# delete
curl -sS -X DELETE "$BASE/api/browsers/$ID"
```

Reuse `id` from create. Do not spawn a second session for the same assignment.

## execute_playwright_code

Bounded snippet. `page` and `context` are in scope. ~25s timeout. Returns `{ url, title, text, result, error }`.

```bash
curl -sS -X POST "$BASE/api/browsers/$ID/playwright" -H 'content-type: application/json' \
  -d '{"code":"await page.click('\''button[type=submit'\''); return await page.title();"}'
```

Do not import modules. Do not dump cookies or passwords.

## computer_action

```bash
curl -sS -X POST "$BASE/api/browsers/$ID/computer" -H 'content-type: application/json' \
  -d '{"action":"screenshot"}'

curl -sS -X POST "$BASE/api/browsers/$ID/computer" -H 'content-type: application/json' \
  -d '{"action":"click","x":640,"y":360}'

curl -sS -X POST "$BASE/api/browsers/$ID/computer" -H 'content-type: application/json' \
  -d '{"action":"type","text":"hello"}'

curl -sS -X POST "$BASE/api/browsers/$ID/computer" -H 'content-type: application/json' \
  -d '{"action":"scroll","dy":800}'
```

Screenshot JSON returns a **path** (and `/api/browsers/:id/screenshot`). Do not paste huge base64 into chat.

## Live view + CAPTCHA / OTP / 3DS

Preserve the browser. Do not delete the session.

```bash
curl -sS -X POST "$BASE/api/browsers/$ID/computer" -H 'content-type: application/json' \
  -d '{"action":"takeover"}'
```

Return `{ "status": "takeover", "message": "...", "liveView": "/api/browsers/$ID/live" }`. The human finishes in live view. After they say they are done, resume and re-read the page (Playwright `page.title()` / `innerText`, not a new session).

Live page: `GET /api/browsers/:id/live` (polls screenshots). Add `?takeover=1` for the banner.

## Vault fill

If vault exists, fill through it — do not type secrets from chat:

```bash
curl -sS -X POST "$BASE/api/vault/fill" -H 'content-type: application/json' \
  -d '{"browserSessionId":"'"$ID"'","kind":"login"}'
```

If that 404s, skip. After a successful fill: **never screenshot filled fields**, never inspect `value` of password/card inputs. Continue with DOM actions (submit click) only.

## Budget

Stop after ~6 calls or ~90s, or after two tactics fail. Report:

```json
{ "status": "blocked", "message": "why", "liveView": "/api/browsers/<id>/live" }
```
