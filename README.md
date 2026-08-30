# pi-box

Open-source personal agent. Grok Bot-shaped *information architecture* (roster of boxes, one thread, tool cards). **Pi** is the harness. Skills are a first-class primitive.

Not a Grok Bot clone. Not an OpenClaw fork. Not a Rakazo fork.

## Skills primitive

Every pi-box **indexes** `SKILL.md` files, **lists** them on the box, and **injects live ones into Pi**. A skill that needs a browser / Android / iOS simulator stays in the catalog but is marked unavailable until that host can actually do it.

| Endpoint | What |
| --- | --- |
| `GET /api/skills` | Catalog (`available` follows the **live mesh roster**) |
| `GET /api/boxes` | Chat target (one mesh box) with union capabilities |
| `GET /api/devices` | Machines pane: online / drain / caps / inflight |
| `POST /api/devices/register` | Join a worker; secret shown once |
| `POST /api/chat` | Mesh places the turn: live device, `cloud`, or wait |

Pi only receives skills where `available: true` (progressive disclosure, [Agent Skills](https://agentskills.io/specification)).

Drop a folder with `SKILL.md` in `container/skills/` or ship an [Agent Plugin](https://agent-plugins.org/specification) under `plugins/<name>/` (`plugin.json` + `skills/`).

Shipped packs:

- **browser** — Playwright/Chromium on a machine box, or Cloudflare Browser Rendering on a cloud box
- **vault** — encrypted logins, cards, addresses, contacts. Secrets stay on the box.
- **gmail** / **google-calendar** — one Google OAuth grant; tokens never enter the model
- **telegram** — Bot API via vault token
- **cloudflare** — `api.cloudflare.com` plus a publish-site skill (wrangler uses the vault token only)
- **android-device** — adb / Argent. Not a Cloudflare container.
- **ios-simulator** — Mac + Xcode (or Argent). Linux and Cloudflare will never boot a simulator.

Open `/plugins` to Authenticate. Google OAuth redirect URIs:

- `https://pi-box.ahmad-096.workers.dev/api/oauth/google/callback`
- `http://127.0.0.1:8787/api/oauth/google/callback`

## Vault and browser

Open `/vault` to enter passwords and cards; the model only sees opaque handles. Details: [docs/vault.md](docs/vault.md).

Real browser sessions (Playwright locally, Cloudflare Browser Rendering in the cloud) expose a live computer pane when the box has `browser`. Details: [docs/browser.md](docs/browser.md).

## Talk to your boxes

Web UI: left roster of chats, machines pane in the aside, thread on the right. Clerk if `CLERK_SECRET_KEY` is set; local mock skips auth. Mesh placement is documented in [docs/mesh.md](docs/mesh.md).

## Local

```bash
cd container && npm install --ignore-scripts && cd ..
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

http://127.0.0.1:8787

No provider key → mock mode, still lists skills. Default real loop is OpenRouter `z-ai/glm-5.3-flash` pinned to the Z.ai provider (`OPENROUTER_API_KEY`). Anthropic / OpenAI / xAI keys still work.

## Clerk

```bash
# .dev.vars / wrangler secrets
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
npx wrangler secret put CLERK_SECRET_KEY
```

Also set `CLERK_PUBLISHABLE_KEY` in `wrangler.jsonc` `vars` (it is public).

## Google OAuth (Gmail + Calendar)

When `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, Authenticate on `/plugins` starts Google OAuth (`openid email gmail.readonly gmail.send calendar.events`, `access_type=offline`, `prompt=consent`). One grant upserts **both** gmail and google-calendar into the vault. If those env vars are unset, Authenticate falls back to a vault setup URL (paste token).

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## Cloudflare

Workers Paid + Docker. First request 1–2 minutes cold start. One container per authenticated user (`password` / local-dev → `default`, otherwise Clerk `sub`) is runtime **`cloud`**. The **Mesh** Durable Object (id = that same box id) is the always-on scheduler: device roster, job leases, R2 snapshot pointers. Chat identity stays on `x-pi-box-session` / `?session`. Vault + agent session files dual-write to R2 (`pi-box-state`) and remain in container DO storage as a cloud fallback (`sleepAfter` 2h).

```bash
npx wrangler r2 bucket create pi-box-state
npx wrangler secret put OPENROUTER_API_KEY
# or: npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put VAULT_ENCRYPTION_KEY
npx wrangler deploy
```

`CLOUDFLARE_API_TOKEN` is passed into the container as `BROWSER_CDP_TOKEN` for Browser Rendering CDP. Never commit it. Optional: `CLOUDFLARE_ACCOUNT_ID` (defaults to the pi-box account used in docs).

Next slice (not this drop): headless `pi-box node` for a Pi/Linux box, then an Electron app that wraps the sidecar + hosted UI. Not a second repo.

## License

MIT
