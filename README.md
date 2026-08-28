# pi-box

Open-source personal agent with a Grok Bot-shaped desktop/mobile UI, a completely different agent, and your own containers.

**Not a Grok Bot clone. Not an OpenClaw fork. Not a Rakazo fork.**

- **Harness:** [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`, MIT)
- **Runtime:** any container you choose. Default host is Cloudflare Containers / Sandbox.
- **Plugins:** [Agent Skills](https://agentskills.io/specification) first (`SKILL.md`). MCP is optional and not in the prompt.
- **Clients:** web first, then Expo mobile + a thin desktop shell talking to the same API.

## Architecture

```
Desktop / mobile / web
        │  HTTPS + WebSocket
        ▼
Worker  (UI, auth, routing; secrets stay here)
        │
        ▼
Durable Object  (sticky session, chat metadata)
        │  container / sandbox
        ▼
Pi container  (createAgentSession, tools, skills, workspace)
        │
        ├─ R2: sessions, skills, workspace
        └─ D1: agents, plugin installs
```

Pi does not run in a Worker isolate. The Worker is the door. The container is the agent.

Closest prior art for the *deploy* shape: [Moltworker](https://github.com/cloudflare/moltworker) (Worker + Sandbox + R2). Closest *product IA* to study, not fork: [Rakazo](https://github.com/elie222/rakazo).

## First slice

1. Dockerfile that runs Pi (`read` / `write` / `edit` / `bash`)
2. Worker gateway that streams Pi events (text + tool cards)
3. Bare web chat
4. One example `SKILL.md` in the image

No Telegram, no OpenClaw, no desktop/mobile apps, no MCP, no marketplace.

## Status

Repo is new. Implementation is not in yet.

## License

MIT (to be added with the first real commit).
