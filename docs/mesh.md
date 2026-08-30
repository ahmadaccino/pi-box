# Cloud + device mesh

The Mesh Durable Object is the scheduler. Machines are workers you add or drop. Cloudflare Container (`cloud`) is the fallback runtime. Spec: [superpowers/specs/2026-08-29-cloud-device-mesh-design.md](superpowers/specs/2026-08-29-cloud-device-mesh-design.md).

A sleeping Mac Mini does not take the control plane down. iOS-simulator work never silently runs on Linux or Cloudflare; the UI says "Waiting for a Mac with iOS simulator."

## Join a machine

1. Sign in to the existing account (password cookie and/or Clerk).
2. `POST /api/devices/register` with `{ name, caps }` returns `{ deviceId, deviceSecret }` once. Store the secret in the OS keychain. Only a hash is kept in the Mesh DO.
3. Heartbeat every 15s: `POST /api/devices/heartbeat` with `Authorization: Bearer <deviceSecret>` and `x-pi-box-device: <deviceId>`. Dead after 45s.
4. Optional job socket: `GET /api/devices/connect` (WebSocket, same auth; query `device` + `token` also accepted).

`scripts/mesh-fake-device.mjs` is a test sidecar. Headless `pi-box node` and the Electron desktop app are the next slice (not in this Worker drop). Raspberry Pi should run the headless node, not Electron.

## Placement

`POST /api/chat` goes to Mesh. Empty `require` (v1 does not parse the prompt) lands on a live worker, preferring sticky affinity then RAM. No personal machines → `cloud`. Device-only requires (`ios`, `ios-simulator`, `android`, `cuda`) wait or fail closed.

Chat header shows `x-pi-box-runtime`. The aside **machines** pane is `GET /api/devices` (not the chat roster).

## Snapshots

Session trees dual-write to R2 bucket `pi-box-state` (`STATE`) at `sessions/{meshId}/{sessionId}/snapshot.json` (32MB / 500 files). The PiBox container still keeps the smaller in-DO snapshot as a cloud fallback. Restore failure does not run the turn.

Create the bucket once:

```bash
npx wrangler r2 bucket create pi-box-state
```

## Tests

```bash
npm test
```
