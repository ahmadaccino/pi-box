# pi-box

Open-source personal agent. Grok Bot-shaped *information architecture* (roster of boxes, one thread, tool cards). **Pi** is the harness. Skills are a first-class primitive.

Not a Grok Bot clone. Not an OpenClaw fork. Not a Rakazo fork.

## Skills primitive

Every pi-box **indexes** `SKILL.md` files, **lists** them on the box, and **injects live ones into Pi**. A skill that needs a browser / Android / iOS simulator stays in the catalog but is marked unavailable until that host can actually do it.

| Endpoint | What |
| --- | --- |
| `GET /api/skills` | Catalog for this box (`available`, `requires`, `missing`) |
| `GET /api/boxes` | Boxes you can message, each with skills + capabilities |
| `POST /api/chat` | Talk to a box (`session` / `boxId`) |

Pi only receives skills where `available: true` (progressive disclosure, [Agent Skills](https://agentskills.io/specification)).

Drop a folder with `SKILL.md` in `container/skills/` or ship an [Agent Plugin](https://agent-plugins.org/specification) under `plugins/<name>/` (`plugin.json` + `skills/`).

Shipped packs:

- **browser** — Playwright/Chromium on a machine box, or Cloudflare Browser Rendering on a cloud box
- **vault** — encrypted logins, cards, addresses, contacts. Secrets stay on the box.
- **android-device** — adb / Argent. Not a Cloudflare container.
- **ios-simulator** — Mac + Xcode (or Argent). Linux and Cloudflare will never boot a simulator.

## Vault and browser

Open `/vault` to enter passwords and cards; the model only sees opaque handles. Details: [docs/vault.md](docs/vault.md).

Real browser sessions (Playwright locally, Cloudflare Browser Rendering in the cloud) expose a live computer pane when the box has `browser`. Details: [docs/browser.md](docs/browser.md).

## Talk to your boxes

Web UI: left roster of pi-boxes, thread on the right. Clerk if `CLERK_SECRET_KEY` is set; local mock skips auth.

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

## Cloudflare

Workers Paid + Docker. First request 1–2 minutes cold start.

```bash
npx wrangler secret put OPENROUTER_API_KEY
# or: npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

## License

MIT
