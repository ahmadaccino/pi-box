# Routines

Saved prompts with a trigger. They run while you are away. The Mesh Durable Object stores them in its SQLite database (`ctx.storage.sql`, table `routine_records`) and fires due cron from the same alarm that heartbeats devices.

## Model

Each routine has a name, prompt, enabled flag, trigger, timezone, created time, last run, and a short run history (status `running`, `succeeded`, `failed`, or `waiting`, plus the result text).

Triggers:

- **Cron.** Five fields (`min hour day month dow`) or `@every Nm` / `@every Nmin`. The smallest gap is 5 minutes. The next fire is computed in the routine's IANA timezone. Day-of-month and day-of-week both restricted means either may match.
- **Webhook.** `POST /api/routines/:id/webhook` with `Authorization: Bearer <key>`. The key is shown once at create time and stored as a SHA-256 hash. `200` means the run started. The JSON body is appended to the prompt inside `<untrusted-webhook>` and is not instructions.

A run is a fresh agent turn in its own session (`rtn…`). Mesh places it like chat: an online device that satisfies `require`, otherwise the cloud container. Device-only requires (for example `ios`) wait instead of running on cloud.

When the run finishes, the result is stored on the routine and a notice is appended for the user's main chat session. The web UI polls `GET /api/routines/feed`.

## HTTP

User cookie or Clerk session, except the webhook (bearer key only) and the in-box agent proxy. A logged-in browser session is enough even when `GATEWAY_TOKEN` is set; the web UI does not send that token.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/routines` | List routines and the timezone |
| `POST` | `/api/routines` | Create (`trigger` `cron` or `webhook`) |
| `PATCH` | `/api/routines/:id` | Update name, prompt, schedule, timezone |
| `POST` | `/api/routines/:id/pause` | Skip cron and webhook |
| `POST` | `/api/routines/:id/resume` | Enable and recompute the next cron fire |
| `POST` | `/api/routines/:id/run` | Run now, including while paused |
| `DELETE` | `/api/routines/:id` | Delete |
| `PUT` | `/api/routines/settings` | `{ "timezone": "America/New_York" }` |
| `GET` | `/api/routines/feed?session=` | Result notices for the main chat |
| `POST` | `/api/routines/:id/webhook` | External trigger. Bearer key. |

The panel is `/routines` (Pause, Resume, Run now, Delete, next fire, last status, history).

## Agent

The `routines` skill tells the model to propose a routine for recurring asks. Tools are HTTP on this machine:

- Cloud sidecar: `http://127.0.0.1:8788/api/routines`, proxied to Mesh with a per-box internal token (the model does not see the token). The Worker mints it from `INTERNAL_API_SECRET` if that is set, otherwise from `VAULT_ENCRYPTION_KEY`, `PI_BOX_PASSWORD`, or `CLERK_SECRET_KEY`. It is accepted only on these skill-proxy routes.
- A joined device: `PI_BOX_ROUTINES_URL` (loopback). The node attaches the device secret.

Set `PI_BOX_PUBLIC_URL` on the Worker so the cloud computer can reach Mesh. Chat requests also stamp that origin onto the sidecar.

A short note is appended to the agent directory `AGENTS.md` the first time a session is seeded.

## Alarm

`Mesh.alarm` sweeps dead devices, expires routine runs still `running` after 15 minutes, claims cron routines whose `nextRunAt` is due, and dispatches them. The next alarm is the sooner of the device heartbeat (15s) and the next cron fire. Missed slots collapse to a single run; the following fire is the next future slot.

## Tests

```bash
npm run test:routines
```

Covers cron parsing and next-fire in `America/New_York` (including DST), `@every` alignment, the 5-minute floor, webhook bearer auth (401 / 200 / paused 409), and alarm dispatch (matching device, else cloud, wait when the require cannot run on cloud).
