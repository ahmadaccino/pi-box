# pi-box

Open-source personal agent. Grok Bot-shaped UI later. **Pi** as the harness. Runs in **your** container. Default host is Cloudflare Containers.

Not a Grok Bot clone. Not an OpenClaw fork. Not a Rakazo fork.

## What this slice is

- Chat UI with streaming text and tool cards
- Pi sidecar (`createAgentSession`) over HTTP SSE
- Dockerfile so the same sidecar runs on Cloudflare Containers or any Docker host
- One example skill (`hello-workspace`)
- Mock mode if you have no model API key, so the UI is still demoable

What it is not yet: desktop/mobile apps, MCP, Telegram, a plugin marketplace, multi-user auth.

## Architecture

```
web UI  →  Worker (Cloudflare) or scripts/dev.mjs (local)
                →  Pi container :8788  (read / write / edit / bash)
```

Pi never runs in a Worker isolate. The Worker is the door.

## Local (no Cloudflare)

```bash
cd container && npm install --ignore-scripts && cd ..
npm install
cp .dev.vars.example .dev.vars   # optional keys
# export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Open http://127.0.0.1:8787

Without a provider key you get **mock mode**: a fake `ls` tool card and a short reply. With a key, Pi actually runs.

## Cloudflare deploy

Workers Paid is required (Containers). Docker must be running for `wrangler deploy`.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# optional:
# npx wrangler secret put OPENAI_API_KEY
# npx wrangler secret put XAI_API_KEY
# npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

First request can take 1–2 minutes while the container starts. The Worker passes provider secrets into the container as env vars.

Cold start / cost: `sleepAfter` is 10 minutes. Always-on `standard-1` is on the order of tens of dollars a month if you never let it sleep. See [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/).

## Skills

Pi loads [Agent Skills](https://agentskills.io/specification) (`SKILL.md`). Drop more under `container/skills/<name>/SKILL.md` (image) or `~/.pi/agent/skills/` (runtime).

MCP is intentionally not in Pi. A later plugin can add it. Portable install unit later: [Agent Plugins 1.0](https://agent-plugins.org/specification) (`plugin.json` + `skills/` + optional `mcp.json`).

## Stack

| Piece | Choice |
| --- | --- |
| Harness | [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) |
| Container API | [`@cloudflare/containers`](https://developers.cloudflare.com/containers/) |
| Edge | Cloudflare Worker + assets |
| Local | `scripts/dev.mjs` |

Prior art for the *deploy* shape: [Moltworker](https://github.com/cloudflare/moltworker). Closest *product IA* to study, not fork: [Rakazo](https://github.com/elie222/rakazo).

## License

MIT
