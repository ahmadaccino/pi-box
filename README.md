# pi-box

Open-source personal agent. Grok Bot-shaped *information architecture* (roster of boxes, one thread, tool cards). **Pi** is the harness. Skills are a first-class primitive.

Not a Grok Bot clone. Not an OpenClaw fork. Not a Rakazo fork.

One product: Cloudflare Worker + Durable Objects + optional local devices. Mesh DO is always the scheduler. Devices never become master.

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
- **routines** — saved prompts on a cron or webhook. The agent can create them from chat. Panel: `/routines`. Details: [docs/routines.md](docs/routines.md).

Open `/plugins` to Authenticate. Google OAuth redirect URIs:

- `https://pi-box.ahmad-096.workers.dev/api/oauth/google/callback`
- `http://127.0.0.1:8787/api/oauth/google/callback`

## Vault and browser

Open `/vault` to enter passwords and cards; the model only sees opaque handles. Details: [docs/vault.md](docs/vault.md).

Real browser sessions (Playwright locally, Cloudflare Browser Rendering in the cloud) expose a live computer pane when the box has `browser`. Details: [docs/browser.md](docs/browser.md).

## Talk to your boxes

Web UI: left roster of chats, machines pane in the aside, thread on the right. The composer takes paste, drag-drop, and a file picker. The transcript renders markdown, tables, math, and inline cards (approval, ready-to-send, question, file). Clerk if `CLERK_SECRET_KEY` is set; local mock skips auth. Mesh placement is documented in [docs/mesh.md](docs/mesh.md). Attachments, cards, search, and notifications: [docs/transcript.md](docs/transcript.md).

While a turn is running the composer stays enabled. A new message is delivered with Pi `steer` (the button reads Steer) instead of starting another turn. Stop calls Pi `abort` on that session.

## Safe actions

Shell commands the model runs cannot see sidecar secrets. Pi's bash tool copies `process.env`; a `spawnHook` strips `VAULT_ENCRYPTION_KEY`, provider keys, `GOOGLE_CLIENT_SECRET`, `BROWSER_CDP_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GATEWAY_TOKEN`, and `PI_BOX_INTERNAL_TOKEN` before the child starts. The sidecar also reads the vault key once at startup and deletes it from `process.env`. Details: [docs/vault.md](docs/vault.md).

Plugin calls that mutate outside data (delete, publish/deploy, calendar writes, payments) block on an approval card: **Allow once**, **Always allow** (saved per tool and target in the agent dir), or **Deny**. If nobody is connected to the chat stream, the request expires after 10 minutes and counts as Deny.

Gmail and Telegram outgoing messages are drafts. The chat shows a **Ready to send** card (recipients, subject, body). Send runs only when the user clicks Send. Discard drops it. The model cannot send by calling the Gmail send API or `sendMessage` itself.

## Join a machine

Login (existing password page and/or Clerk) is the pairing. Then a device token.

| Machine | How |
| --- | --- |
| Raspberry Pi / servers (Linux x64 or arm64) | Headless `pi-box node` only. No Electron GUI. |
| Mac Mini / MacBook (macOS arm64 or x64) | Electron app, or `pi-box node` |
| Ryzen desktop / Steam Deck (Linux x64) | Electron app, or `pi-box node` |

```bash
cd container && npm install --ignore-scripts && cd ..
node bin/pi-box.mjs node --origin http://127.0.0.1:8787 --name ryzen-box --password "$PI_BOX_PASSWORD"
node bin/pi-box.mjs node --origin https://pi-box.ahmad-096.workers.dev --name pi-drawer --password "$PI_BOX_PASSWORD"
```

Identity (device id + secret) is stored in `~/.pi-box/` (0600). Electron additionally copies the secret into the OS keychain (`keytar`). Details: [docs/mesh.md](docs/mesh.md).

Electron (loads the hosted `public/` UI, keeps the sidecar alive while signed in):

```bash
cd desktop && npm install
PI_BOX_ORIGIN=https://pi-box.ahmad-096.workers.dev npm start
# or local:
PI_BOX_ORIGIN=http://127.0.0.1:8787 npm start
```

## Local

```bash
cd container && npm install --ignore-scripts && cd ..
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

http://127.0.0.1:8787

No provider key → mock mode, still lists skills. Default real loop is OpenRouter `z-ai/glm-5.3-flash` pinned to the Z.ai provider (`OPENROUTER_API_KEY`). Anthropic / OpenAI / xAI keys still work.

`wrangler dev` is the full mesh (DO + optional local R2). `npm run dev` is the static UI + sidecar; device register/heartbeat/poll work there too.

## Clerk

```bash
# .dev.vars / wrangler secrets
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
npx wrangler secret put CLERK_SECRET_KEY
```

Also set `CLERK_PUBLISHABLE_KEY` in `wrangler.jsonc` `vars` (it is public).

## Google OAuth (Gmail + Calendar)

When `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, Authenticate on `/plugins` starts Google OAuth (`openid email gmail.readonly gmail.compose gmail.send calendar.events`, `access_type=offline`, `prompt=consent`). `gmail.compose` files drafts; `gmail.send` is used only after the user clicks Send. One grant upserts **both** gmail and google-calendar into the vault. If those env vars are unset, Authenticate falls back to a vault setup URL (paste token).

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Redirects:

- `https://pi-box.ahmad-096.workers.dev/api/oauth/google/callback`
- `http://127.0.0.1:8787/api/oauth/google/callback`

## Cloudflare deploy

Workers Paid + Docker. First request 1–2 minutes cold start. One container per authenticated user (`password` / local-dev → `default`, otherwise Clerk `sub`) is runtime **`cloud`**. The **Mesh** Durable Object (id = that same box id) is the always-on scheduler: device roster, job leases, R2 snapshot pointers. Chat identity stays on `x-pi-box-session` / `?session`. Vault + agent session files dual-write to R2 (`pi-box-state`) and remain in container DO storage as a cloud fallback (`sleepAfter` 2h).

Keep these Worker secrets (do not commit values):

- `PI_BOX_PASSWORD`
- `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`)
- `VAULT_ENCRYPTION_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `CLOUDFLARE_API_TOKEN` (passed into the container as `BROWSER_CDP_TOKEN`)
- `BRAVE_API_KEY`, `TAVILY_API_KEY`, or `EXA_API_KEY` (optional web search; a vault token works too)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (optional Web Push)

The routines skill calls back from the container to `/api/routines`. That call carries `PI_BOX_INTERNAL_TOKEN`, a per-box HMAC minted by the Worker. Set `INTERNAL_API_SECRET` only if you want a dedicated key; otherwise the Worker derives it from `VAULT_ENCRYPTION_KEY`, then `PI_BOX_PASSWORD`, then `CLERK_SECRET_KEY`. Do not set `GATEWAY_TOKEN` to unblock routines. A password cookie or Clerk session is accepted without that header, so the web UI keeps working if `GATEWAY_TOKEN` is set later. `GATEWAY_TOKEN` is still the OAuth state fallback when `GOOGLE_CLIENT_SECRET` is unset.

```bash
npx wrangler r2 bucket create pi-box-state
npx wrangler secret put PI_BOX_PASSWORD
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put VAULT_ENCRYPTION_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put CLOUDFLARE_API_TOKEN
# optional: npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
# optional: npx wrangler secret put CLERK_SECRET_KEY
# optional search: npx wrangler secret put BRAVE_API_KEY
# optional push: npx wrangler secret put VAPID_PUBLIC_KEY
# optional push: npx wrangler secret put VAPID_PRIVATE_KEY
# optional push: npx wrangler secret put VAPID_SUBJECT
npx wrangler deploy
```

`npx wrangler deploy` **rebuilds the container image**. After sidecar/Dockerfile/plugin changes do **not** use `--containers-rollout=none` (Worker-only). Routines scheduling, webhooks, and the `/routines` page ship in the Worker. The routines skill, the localhost tool proxy, and the recurring-task system note ship in the container image, so a routines deploy needs the image rebuild. Attachments, `web_search` / `web_fetch`, question cards, and artifact downloads also live in the sidecar, so this slice needs the same image rebuild. Set `PI_BOX_PUBLIC_URL` to the Worker origin so the cloud computer can call Mesh. `CLOUDFLARE_API_TOKEN` is never committed. Optional: `CLOUDFLARE_ACCOUNT_ID` (Browser Rendering search fallback; defaults to the pi-box account used in docs).

## License

MIT
