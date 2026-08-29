# Browser execution

Real browser sessions live in `container/browser.mjs`. The chat sidecar (`container/server.mjs`) mounts the HTTP handler. The browser skill teaches Pi the recipe; this doc is for operators.

Coordinator (`web_search` / `web_fetch`) first. Browser only for a **known URL** that needs interaction. Search engines are rejected on `startUrl` / `goto`.

## Local Playwright

From the repo:

```bash
cd container
npm install
npm install playwright
npx playwright install chromium
```

`playwright` (and `playwright-core`) are `optionalDependencies` of `container/package.json`. Docker `npm install --ignore-scripts` skips the browser download. **Do not apt-get Chrome. Do not add Chrome to the Dockerfile.**

Env:

- `PI_BROWSER_PROFILE` — persistent Chromium profile directory
- `PI_CODING_AGENT_DIR` — if set and profile unset, profile is `PI_CODING_AGENT_DIR/../browser-profile`
- `PI_BROWSER_HEADLESS` — set to `0` for headed
- `PI_BROWSER_API` — skill curl base (default `http://127.0.0.1:$PORT`)
- `PORT` — sidecar port (default `8788`)
- `BROWSER_CDP_URL` — Playwright `connectOverCDP` target (Cloudflare Browser Rendering)
- `BROWSER_CDP_TOKEN` — Bearer token for that CDP websocket (`CLOUDFLARE_API_TOKEN` on the Worker)
- `CLOUDFLARE_BROWSER=1` — set by the Worker **only** when the `BROWSER` binding exists. This flag alone does **not** make the browser available.

`detectBrowserRuntime()` is fail-closed: no `BROWSER_CDP_URL` → `available: false` even if `CLOUDFLARE_BROWSER=1`. Locally it then tries `import("playwright")` / `playwright-core` and a system Chromium binary.

## Cloudflare Browser Rendering

`wrangler.jsonc` binds Browser Rendering:

```jsonc
{
  "browser": { "binding": "BROWSER" }
}
```

The Worker mints (never logs the token):

```
BROWSER_CDP_URL=wss://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID || 096fdb50629de275e5a7e57b33b811ad}/browser-rendering/devtools/browser?keep_alive=600000
BROWSER_CDP_TOKEN=${CLOUDFLARE_API_TOKEN}
CLOUDFLARE_BROWSER=1   # only when env.BROWSER is bound
```

Set the API token as a wrangler secret (empty placeholder only in `.dev.vars.example`):

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
# optional override of the default account id:
# npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

`browser.mjs` connects with Playwright:

```js
chromium.connectOverCDP(process.env.BROWSER_CDP_URL, {
  headers: { Authorization: `Bearer ${process.env.BROWSER_CDP_TOKEN}` },
});
```

Playwright / playwright-core must be importable in the container to speak CDP. The image does not install Chrome.

## Live view

`GET /api/browsers/:id/live` — HTML page that polls `GET /api/browsers/:id/screenshot`.

`public/computer.js` (`PiBoxComputer.renderComputerPane`) iframes that URL, or polls the screenshot as an `<img>`.

## Takeover (CAPTCHA / OTP / 3DS)

1. Keep the session (do not DELETE).
2. `POST /api/browsers/:id/computer` `{ "action": "takeover" }`.
3. Hand the human `/api/browsers/:id/live` (or `?takeover=1`).
4. Human finishes the challenge.
5. Resume: Playwright re-read (`title` / `innerText`) on the **same** session id.

## Vault fill

If `container/vault.mjs` is present it `import { fillNative } from "./browser.mjs"` and POST `/api/vault/fill`. After fill, agent screenshots are skipped (`secretsFilled`). Live view for the human still works. Never return claim values.

## HTTP API

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/browsers` | | `{ available, kind, detail, sessions }` |
| POST | `/api/browsers` | `{ startUrl? }` | session (`201` if live page, `503` if runtime missing) |
| GET | `/api/browsers/:id` | | public session |
| DELETE | `/api/browsers/:id` | | `{ ok, id }` |
| GET | `/api/browsers/:id/live` | | HTML live view |
| GET | `/api/browsers/:id/screenshot` | | `image/png` |
| POST | `/api/browsers/:id/playwright` | `{ code }` | `{ url, title, text, result, error }` |
| POST | `/api/browsers/:id/computer` | `{ action, ... }` | compact snapshot (`screenshot`, `click`, `type`, `scroll`, `key`, `hover`, `goto`, `wait`, `takeover`) |

CORS is set by `server.mjs`. Handlers only write JSON / HTML / PNG.

## `container/host.mjs`

Browser capability is `detectBrowserRuntime().available` (Playwright locally, or `BROWSER_CDP_URL` in the cloud). `CLOUDFLARE_BROWSER=1` without a CDP URL does not claim a browser.
