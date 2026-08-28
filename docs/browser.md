# Browser execution

Real browser sessions live in `container/browser.mjs`. The chat sidecar (`container/server.mjs`) must mount the HTTP handler. The browser skill teaches Pi the recipe; this doc is for operators.

Coordinator (`web_search` / `web_fetch`) first. Browser only for a **known URL** that needs interaction. Search engines are rejected on `startUrl` / `goto`.

## Local Playwright

From the repo:

```bash
cd container
npm install
npm install playwright
npx playwright install chromium
```

`playwright` (and `playwright-core`) are `optionalDependencies` of `container/package.json`. Docker `npm install --ignore-scripts` skips the browser download.

Env:

- `PI_BROWSER_PROFILE` — persistent Chromium profile directory
- `PI_CODING_AGENT_DIR` — if set and profile unset, profile is `PI_CODING_AGENT_DIR/../browser-profile`
- `PI_BROWSER_HEADLESS` — set to `0` for headed
- `PI_BROWSER_API` — skill curl base (default `http://127.0.0.1:$PORT`)
- `PORT` — sidecar port (default `8788`)
- `BROWSER_CDP_URL` — Playwright `connectOverCDP` target (Cloudflare Browser Rendering)
- `CLOUDFLARE_BROWSER=1` — mark browser capability available (needs CDP to actually drive pages)

`detectBrowserRuntime()` tries `import("playwright")` then `playwright-core`, then a system `chromium` / `google-chrome` binary, then the Playwright-bundled browser.

Dockerfile already copies `container/*.mjs`, so `browser.mjs` is in the image. It does **not** install Chromium. For a machine box, install Playwright + Chromium on the host (or extend the image yourself).

## Cloudflare Browser Rendering

Do **not** edit `wrangler.jsonc` in this change. Add a binding like this when you are ready:

```jsonc
{
  "browser": { "binding": "BROWSER" }
}
```

`src/worker.ts` already sets `CLOUDFLARE_BROWSER` from `env.BROWSER`. The container treats `CLOUDFLARE_BROWSER=1` as available (`kind: "cloudflare"`).

To actually drive pages from the container, pass a CDP websocket:

```bash
BROWSER_CDP_URL=wss://...
```

Then `browser.mjs` runs `chromium.connectOverCDP(process.env.BROWSER_CDP_URL)`.

### Leftover CF wiring

- `wrangler.jsonc` has **no** `browser` binding yet (add the snippet above).
- The Worker does not yet mint `BROWSER_CDP_URL` for the container. Until it does, `CLOUDFLARE_BROWSER=1` reports available but `POST /api/browsers` returns 503 with `missing BROWSER_CDP_URL`.
- Playwright / playwright-core must still be importable in the container to speak CDP.
- Do not apt-get install Chrome in the Cloudflare container image.

## Live view

`GET /api/browsers/:id/live` — HTML page that polls `GET /api/browsers/:id/screenshot`.

`public/computer.js` (`PiBoxComputer.renderComputerPane`) iframes that URL, or polls the screenshot as an `<img>`. Do not edit `index.html` / `app.js` until the parent includes the script.

## Takeover (CAPTCHA / OTP / 3DS)

1. Keep the session (do not DELETE).
2. `POST /api/browsers/:id/computer` `{ "action": "takeover" }`.
3. Hand the human `/api/browsers/:id/live` (or `?takeover=1`).
4. Human finishes the challenge.
5. Resume: Playwright re-read (`title` / `innerText`) on the **same** session id.

## Vault fill

If `container/vault.mjs` is present it should `import { fillNative } from "./browser.mjs"` and POST `/api/vault/fill`. After fill, agent screenshots are skipped (`secretsFilled`). Live view for the human still works. Never return claim values.

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

## Mount snippet for `container/server.mjs`

Do not apply this here (file is locked). Parent should add:

```js
import { handleBrowserHttp, browserPublicStatus } from "./browser.mjs";
```

Inside `http.createServer`, after OPTIONS, **before** the 404:

```js
  if (await handleBrowserHttp(req, res, url)) return;
```

Optional: include `browser: browserPublicStatus()` on `/healthz` / `/api/boxes`.

## `container/host.mjs`

Already wired in this change. Browser capability is `detectBrowserRuntime().available` (Playwright module, Playwright/chromium binary, `CLOUDFLARE_BROWSER`, or `BROWSER_CDP_URL`). Android / iOS / bash / files detection is unchanged.
