# pi-box cloud + device mesh

Status: approved 2026-08-29 (Ahmad). One project, two runtimes. No Hogbot repo.

This spec is the next slice of [ahmadaccino/pi-box](https://github.com/ahmadaccino/pi-box). It extends main at `10d362a` (one box per user, Browser Rendering, Google plugin gold path). It does not replace Pi, the Grok Bot-shaped UI, or Cloudflare as a runtime.

## Goal

A signed-in person can add and drop machines at any time. Whatever is online runs work. Whatever is missing does not block work that does not need it.

- Download a desktop app (or a headless node) on a Mac Mini, MacBook, Linux desktop, Steam Deck, or Raspberry Pi, log in, and that machine joins the account's roster.
- The Linux box can keep a thread going after the Mac Mini sleeps.
- An iOS-simulator step stays queued (or fails closed) until a Darwin worker with Xcode/simctl is online. It never silently runs on Linux or Cloudflare.
- If no personal machines are online, the same thread runs as a **cloud agent** on the existing Cloudflare Container.
- Session files, vault ciphertext, and placement state survive across machines via Durable Objects + R2.

## Non-goals

- Not a new product name or repo. Not an OpenClaw or Hermes fork.
- Not electing a laptop as the scheduler. A sleeping Mini must not take the control plane down.
- Not Grok Bot's pooled-credential model. Per-device browser profiles and agent homes stay isolated unless the user opts into a shared `handoffs/` volume.
- Not multi-user teams, billing, Windows (v1), Auto-review, or a 20-connector catalog.
- Not shipping a local GPU scheduler as a separate service. A 3090/vLLM is a **capability on a device**, used by agents that land there.
- Not multiplexing many Pi sessions in one Node process (`AgentSessionRuntime` currently `chdir`s). One sidecar process (or container) per named agent on the claiming device.

## Current system (what we keep)

Worker gateway + `PiBox` Container Durable Object (one per authenticated user, `sleepAfter` 2h). Sidecar embeds Pi via `createAgentSession`. Vault + session JSONL snapshot into DO storage (`container/snapshot.mjs`, 80 files / 2MB cap). Skills already declare `requires`; `GET /api/skills` marks them `available` / `missing`. `container/host.mjs` already detects `platform`, `browser`, `android`, `ios`, `vault`, `cloud`. `GET /api/boxes` is the roster. Chat identity is `x-pi-box-session`. Auth is password cookie and/or Clerk `sub`. Default model stays OpenRouter `z-ai/glm-5.3-flash`.

The mesh adds a **live device plane** in front of that. The cloud container becomes one runtime among N, with id `cloud`.

## Decisions (locked)

| Question | Choice |
| --- | --- |
| Repo | Stay in pi-box. Modes: cloud agent vs local agent. |
| Scheduler | Always a Cloudflare Durable Object. Devices never become master. |
| Cloud fallback | Default for jobs with no device-only requirements. |
| Device-only work | `ios-simulator`, host Xcode, physical USB, local GPU pin. No CF, no Linux. |
| Join | Login to the existing account. Password (today) or Clerk `sub`. Then a device token in the OS keychain. |
| Headless | Raspberry Pi / servers run `pi-box node` (same sidecar, no GUI). Electron wraps that sidecar + the web UI. |
| Isolation | One agent home per named bot on the device that claimed it. Do not mount host `~/.pi/agent` or docker.sock. |
| Inference | Agents are HTTP clients. vLLM/Ollama on the Linux box is advertised as `inference=openai-compat`. Not scheduled as its own job in v1. |
| Sticky | Prefer the last device that successfully ran that session, if it is still online and still matches. |

## Architecture

```
UI (web or Electron) ──HTTP/WS──► Worker
                                │
                                ├── Mesh DO  (roster, queue, leases, pointers)
                                │     R2: snapshots, large session trees
                                │
                                ├── PiBox Container DO  = runtime "cloud"
                                │
                                └── device workers (outbound WS)
                                      Mac Mini / Linux / Deck / Pi
                                      each runs sidecar + createAgentSession
```

The Mesh DO is a **new** class, binding `MESH`, id = existing `stableBoxId` (`default` for password/dev, else Clerk `sub`). It must not live on `PiBox` (the Container DO sleeps with the container; the roster has to stay awake when every laptop is shut).

Cloudflare R2 binding `STATE` holds snapshot blobs. The Mesh DO stores only pointers (`r2Key`, `etag`, `updatedAt`) plus the roster and the job queue. Today's in-DO snapshot remains a fallback until R2 cutover, then DO storage is pointers-only.

## Components

### 1. Mesh Durable Object

One per account. Owns:

- Device records (id, name, caps, lastSeen, busy, drain)
- Job queue (chat turns, later cron)
- Session placement map (`sessionId -> lastDeviceId | cloud`)
- Snapshot pointers

Uses DO alarms for lease expiry. Hibernated WebSockets to devices (Cloudflare DO WebSocket hibernation). If a device cannot hold a WS (some Pi images), HTTP heartbeat + long-poll is accepted; WS is preferred.

### 2. Worker routes (additive)

Existing `/api/chat`, `/api/skills`, `/api/boxes`, vault, plugins stay. New:

| Route | Who | What |
| --- | --- | --- |
| `POST /api/devices/register` | logged-in user | Mint device id + secret, first caps |
| `POST /api/devices/heartbeat` | device token | Refresh caps, `lastSeen` |
| `GET /api/devices` | user | Roster for the machines pane |
| `POST /api/devices/:id/drain` | user | Stop new jobs; finish in-flight; then offline |
| `DELETE /api/devices/:id` | user | Drop from roster |
| `WS /api/devices/connect` | device token | Receive jobs, send NACK/ACK/events |

`GET /api/boxes` grows to include online devices and `cloud`, each with `capabilities` and skill availability already computed from those caps (reuse `detectCapabilities` shape).

### 3. Device sidecar

Reuse `container/server.mjs` (Pi loop, vault, skills, snapshot). On start:

1. `detectCapabilities()` plus extras (`arch`, `ramGb`, `gpu`, `features[]`).
2. Register / heartbeat.
3. Open WS.
4. On job: restore snapshot for that session from the Worker, run `createAgentSession` (not `AgentSessionRuntime`), stream events, persist snapshot, ACK.

Reject a job with `NACK { unsatisfied: ["ios"] }` if a tool/skill needed this turn is missing. Do not attempt a fake fallback.

### 4. Desktop app (Electron)

Targets for v1: macOS (arm64/x64), Linux x64 (the Ryzen box, Steam Deck), Linux arm64 (Raspberry Pi, some Minis-as-Linux). Window loads the hosted UI (`https://pi-box.ahmad-096.workers.dev` or a configured origin). Side process is the sidecar. Login is the existing password page or Clerk. After login the app stores the device secret in the platform keychain and keeps the sidecar alive while signed in.

`pi-box node` is the same sidecar without a window, for a Pi that sits in a drawer.

### 5. Cloud runtime

Unchanged `PiBox` container, device id `cloud`, caps from today's `host.mjs` (`cloud: true`, `ios: false`, `android: false`, browser via Browser Rendering when the binding is set). Always "online" unless the container class is misconfigured. It is the fallback worker, not a special-case code path in the chat UI.

## Data model

### Device

```
{
  id: "dev_...",
  name: "ryzen-box",
  tokenHash: "...",          // only hash stored in DO
  caps: {
    os: "linux" | "darwin",
    arch: "x64" | "arm64",
    ramGb: 128,
    gpu: "nvidia" | "apple" | "none",
    features: ["browser", "docker", "ios-simulator", "android", "cuda", "inference"],
    platform: "linux",       // Node process.platform, matches host.mjs
    ios: false,
    android: false,
    browser: true,
    cloud: false
  },
  lastSeen: 0,
  drain: false,
  inflight: 0
}
```

`cloud` is a synthetic row, `id: "cloud"`, never has a device token.

Heartbeat interval: 15s. Dead: 45s without heartbeat or WS close without drain. On death: in-flight jobs requeue.

### Job (v1 = one chat turn)

```
{
  id: "job_...",
  sessionId: "...",
  agentId: "...",            // named bot; v1 may equal session
  require: ["ios"],          // empty = portable
  prefer: ["gpu=nvidia"],
  affinity: "dev_..." | "cloud" | null,
  fallback: "cloud" | "wait",
  payload: { /* chat body */ },
  state: "queued" | "leased" | "done" | "failed"
}
```

`fallback` is `wait` if `require` contains a device-only feature (`ios`, `ios-simulator`, `android` when not cloud-emulable, `cuda` when the user pinned local GPU). Otherwise `cloud`.

v1 does not invent requirements from the prompt. Start with sticky affinity or empty require. The sidecar NACKs if it cannot satisfy a skill this turn; Mesh records `require` from the NACK and re-places.

### Snapshot pointer

```
{
  sessionId: "...",
  r2Key: "sessions/{userId}/{sessionId}/snapshot.json",
  etag: "...",
  updatedAt: 0
}
```

Snapshot body stays the existing `{ version: 1, files: { rel: text } }` schema. Raise the 2MB / 80-file cap on the R2 path (new caps: 32MB / 500 files). Vault ciphertext remains in the snapshot; the model still never sees it. Do not put `OPENROUTER_API_KEY` or vault plaintext in R2; keys stay Worker secrets / env on the runtime.

## Placement

Pure function, unit-tested, runs inside the Mesh DO.

```
place(job, devices, cloud):
  live = devices where lastSeen fresh AND not drain AND inflight below cap
  live += cloud unless job.fallback == "wait"
  matched = live where every job.require is satisfied by caps
  if job.affinity in matched: return affinity
  preferred = matched where prefer holds
  pool = preferred or matched
  if pool empty and job.fallback == "wait": return { wait: true }
  if pool empty: return { fail: "no_capacity" }
  return least inflight, then most RAM, then name
```

Capability match (v1):

- `ios` / `ios-simulator` → `caps.ios == true` (Darwin + xcrun/simctl/argent, already in `host.mjs`)
- `android` → `caps.android`
- `browser` → `caps.browser`
- `os=darwin` / `os=linux` → `caps.os`
- `gpu=nvidia` / `cuda` → `caps.gpu == "nvidia"`
- `arch=arm64` → `caps.arch`

Linux must not receive `ios`. Cloudflare must not receive `ios`. A portable chat with empty `require` may run on Linux after the Mini dies, even if the previous affinity was the Mini.

Lease: 60s, heartbeat-extendable while the turn streams. On timeout, requeue (at-most-once tool side effects are not guaranteed; chat ACK is idempotent by `job.id`).

Concurrency cap per device (v1): `max(1, floor(ramGb / 4))` with a hard max of 8, and 1 if `ramGb < 4` (Pi). Cloud uses existing container max.

## Failover and drain

User toggles a machine off, closes the lid, or hits Drain in the machines pane:

1. Device sets `drain: true` (or missed heartbeats).
2. Mesh stops assigning new jobs to it.
3. In-flight job either finishes and snapshots, or lease expires and requeues.
4. Next portable turn of that session lands on the next `place()` result (Linux, or `cloud`).
5. Device-only turns stay `queued` with UI copy: "Waiting for a Mac with iOS simulator." Never a silent Linux attempt.

Adding a machine is the inverse of drain: register → heartbeat → it appears in `GET /api/devices` and becomes eligible. No restart of the Worker. No restart of other devices.

## Auth and join

v1 keeps the current single-account Worker.

1. Human logs in (password cookie and/or Clerk Bearer), same as web.
2. `POST /api/devices/register` with `{ name, caps }` returns `{ deviceId, deviceSecret }` once. Secret is shown never again; only a hash is stored.
3. Sidecar uses `Authorization: Bearer <deviceSecret>` on heartbeat and WS.
4. Rotating: register again from the same logged-in session replaces the secret; old heartbeats 401 and the app must re-login.

Do not require Clerk to ship the mesh. Clerk, when set, namespaces Mesh id by `sub` (already `stableBoxId`). Password mode uses Mesh id `default`, same as today's container.

Device secret is not the vault key and not `OPENROUTER_API_KEY`. The sidecar receives model keys the same way the cloud container does: Worker injects them into job env or the device operator sets local `.env` for a private vLLM. v1: Worker may proxy OpenRouter by minting a short-lived job credential, or the device uses its own local `models.json` pointing at LAN vLLM. Pick: **cloud jobs and devices without `inference` use Worker-injected OpenRouter env; devices with `inference` prefer `http://127.0.0.1:8000/v1`.** Never log keys.

## UI

Same Grok Bot IA: left roster of **agents** (named bots / sessions), thread on the right.

Add a **Machines** view (not a second product): name, OS, caps, online/drain, inflight. "Add machine" copy is "Install pi-box on this computer and log in." No pairing codes in v1 (login is the pairing).

Chat header shows where the last turn ran (`ryzen-box` / `mac-mini` / `cloud`) and, if waiting, the missing cap.

Skill catalog already greys out `ios-simulator` when no Darwin worker is live. Keep that; drive it from Mesh roster instead of only the current sidecar.

## Error handling

| Case | Behavior |
| --- | --- |
| No devices, portable job | Run on `cloud` |
| No devices, `require: [ios]` | Queue + UI wait. Do not call CF |
| NACK unsatisfied | Re-place with those requires. If still nobody, wait or fail closed |
| Snapshot restore fails | Do not run; job failed; keep previous R2 object |
| Two devices claim one job | Lease compare-and-set in Mesh DO; loser drops |
| R2 unavailable | Refuse new turns that need restore; cloud-only snapshot-in-DO is last resort for `cloud` |
| Sidecar crash mid-turn | Lease timeout, requeue. Duplicate tool calls possible; do not hide that |
| User deletes device with inflight | Drain first, then delete |

## Testing

Add `scripts/mesh-place-check.mjs` (pure `place()` + cap match, no network), same style as `scripts/oauth-snapshot-check.mjs` / `plugin-catalog-check.mjs`. Cases:

- Linux live, Mini asleep, portable job → linux
- Linux live, Mini asleep, `require: ["ios"]` → wait
- Mini live + linux live, sticky Mini, portable → Mini
- No devices, portable → cloud
- No devices, ios → wait, not cloud
- Drain Mini mid-roster → next portable → linux
- Raspberry Pi ramGb 4 → inflight cap 1

Worker route checks with mocked DO storage for register/heartbeat/dead-after-45s.

Do not require a real Mac or 3090 in CI.

## Phased delivery

1. **Mesh DO + register/heartbeat + GET /api/devices.** Cloud remains the only runtime. UI machines pane (read-only).
2. **Placement on `/api/chat`.** Lease to `cloud` or a live sidecar. NACK/requeue. Skill availability from roster.
3. **R2 snapshots.** Restore on the claiming runtime. Raise size cap. Dual-write DO + R2 until cutover.
4. **`pi-box node` CLI** so a Linux box or Pi can join without Electron.
5. **Electron app** (login, keychain, sidecar lifecycle) for Mini / MacBook / Deck / Linux desktop.
6. **Drain + affinity polish.** GPU/inference as an advertised cap, still not a separate scheduler.

Each phase merges to main and can ship on the existing Worker. Phase 1 is useful alone.

## Implementation notes (for the later plan, not this spec)

- New files stay small: `src/mesh.ts` (DO + place), `src/caps.ts` (match), `container/device.mjs` (register/WS client). Do not grow `src/worker.ts` past route wiring.
- `wrangler.jsonc`: add Durable Object class `Mesh` (new sqlite migration tag `v2`), R2 bucket `STATE`.
- Reuse `detectCapabilities()`; extend it, do not replace it.
- Harness remains `@earendil-works/pi-coding-agent` `createAgentSession`.

## Spec self-review

- No placeholders. Clerk is optional; password is enough to join.
- Scheduler is Cloudflare, not a device. Matches the failover story.
- iOS never runs on Linux or CF. Portable work does.
- Snapshot path is explicit (R2 + pointer). Today's 2MB DO cap is called out as insufficient for mesh.
- One implementation plan can cover phases 1–3 (Worker). Electron is a follow-on plan so this spec is not two products.
