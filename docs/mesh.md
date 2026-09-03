# Cloud + device mesh

The Mesh Durable Object is the scheduler. Machines are workers you add or drop. Cloudflare Container (`cloud`) is the fallback runtime. Spec: [superpowers/specs/2026-08-29-cloud-device-mesh-design.md](superpowers/specs/2026-08-29-cloud-device-mesh-design.md).

A sleeping Mac Mini does not take the control plane down. iOS-simulator work never silently runs on Linux or Cloudflare; the UI says "Waiting for a Mac with iOS simulator."

## Join a machine

Login is the pairing. Password cookie and/or Clerk `sub` (same as the web UI). Then a device token (shown once).

### Headless `pi-box node` (Linux x64, Linux arm64 / Raspberry Pi, servers)

No GUI. Do not install the Electron app on a 4GB Pi.

```bash
cd container && npm install --ignore-scripts && cd ..
# against wrangler dev (http://127.0.0.1:8787) or the hosted origin
node bin/pi-box.mjs node --origin http://127.0.0.1:8787 --name ryzen-box --password "$PI_BOX_PASSWORD"
# Raspberry Pi / Deck / Mini-as-Linux, hosted:
node bin/pi-box.mjs node --origin https://pi-box.ahmad-096.workers.dev --name pi-drawer --password "$PI_BOX_PASSWORD"
# Clerk session JWT instead of password:
node bin/pi-box.mjs node --origin https://pi-box.ahmad-096.workers.dev --token "$CLERK_SESSION_JWT" --name macbook
```

The node:

1. Detects caps (`container/host.mjs`). Linux never claims `ios`.
2. `POST /api/devices/register` (cookie or Clerk bearer) and stores `{deviceId}` plus the secret in `~/.pi-box/` (mode 0600).
3. Heartbeats every 15s. Dead after 45s; Mesh requeues in-flight jobs.
4. Accepts leases over WebSocket `GET /api/devices/connect` (preferred) or HTTP `POST /api/devices/poll` (Pi images that cannot hold a WS).
5. Restores the session snapshot, runs `createAgentSession` (one process home per named bot — never host `~/.pi/agent`), dual-writes the snapshot back, ACK. Missing caps → NACK `{ unsatisfied }`.

GPU/vLLM on the box is advertised as `inference` (`PI_BOX_INFERENCE_URL` or `nvidia-smi`). Devices with that cap prefer `http://127.0.0.1:8000/v1`. It is not a separate scheduler.

Identity reuse: the same `~/.pi-box` heartbeats on restart. If the secret was rotated (401), register again from a logged-in session.

### Electron (macOS arm64/x64, Linux x64)

Targets: Mac Mini, MacBook, Ryzen desktop, Steam Deck. **Not** Raspberry Pi.

```bash
cd desktop && npm install
PI_BOX_ORIGIN=http://127.0.0.1:8787 npm start          # local wrangler / npm run dev UI
PI_BOX_ORIGIN=https://pi-box.ahmad-096.workers.dev npm start
```

The window loads that origin (existing `public/` UI — password page or Clerk). After login the app stores the device secret in the OS keychain (`keytar`, service `pi-box`) and keeps `pi-box node` alive while signed in.

Pack installers (not required to review the node):

```bash
cd container && npm install --ignore-scripts && cd ../desktop
npx electron-builder --mac   # arm64 + x64
npx electron-builder --linux --x64
```

`scripts/mesh-fake-device.mjs` is a test sidecar only. Do not use it as the join path.

## Placement

`POST /api/chat` goes to Mesh. Empty `require` (v1 does not parse the prompt) lands on a live worker, preferring sticky affinity (last device that ACKed that session) then RAM. No personal machines → `cloud`. Device-only requires (`ios`, `ios-simulator`, `android`, `cuda`) wait or fail closed. Drain or a missed heartbeat drops the machine from the live pool; the next portable turn failovers Mini-off → Linux → cloud.

Chat header shows `x-pi-box-runtime`. The aside **machines** pane is `GET /api/devices` (Drain / Remove). Cloud cannot be drained.

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
