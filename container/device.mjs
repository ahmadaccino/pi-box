/**
 * Device sidecar client: register, heartbeat, and optional job WebSocket.
 * Production `pi-box node` wraps this. Tests use scripts/mesh-fake-device.mjs.
 */
import { detectCapabilities } from "./host.mjs";

export async function deviceCaps() {
  return detectCapabilities();
}

export async function registerDevice(origin, { name, caps, headers = {} }) {
  const res = await fetch(new URL("/api/devices/register", origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name, caps }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `register ${res.status}`);
  return body;
}

export async function heartbeatDevice(origin, { deviceId, deviceSecret, caps }) {
  const res = await fetch(new URL("/api/devices/heartbeat", origin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${deviceSecret}`,
      "x-pi-box-device": deviceId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ caps }),
  });
  if (!res.ok) throw new Error(`heartbeat ${res.status}`);
  return res.json();
}

export function startHeartbeat(origin, opts, ms = 15_000) {
  const tick = () => heartbeatDevice(origin, opts).catch((err) => {
    console.warn("[pi-box] heartbeat", err.message || err);
  });
  tick();
  return setInterval(tick, ms);
}

export function connectJobs(origin, { deviceId, deviceSecret, onJob, onClose }) {
  const url = new URL("/api/devices/connect", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("device", deviceId);
  url.searchParams.set("token", deviceSecret);
  const ws = new WebSocket(url);
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg?.type === "job" && typeof onJob === "function") {
      Promise.resolve(onJob(msg.job, ws)).catch((err) => {
        ws.send(
          JSON.stringify({
            type: "nack",
            jobId: msg.job?.id,
            unsatisfied: ["error"],
            error: err?.message || String(err),
          }),
        );
      });
    }
  });
  if (onClose) ws.addEventListener("close", onClose);
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, 15_000);
  ws.addEventListener("close", () => clearInterval(ping));
  return ws;
}

export function nackJob(ws, jobId, unsatisfied) {
  ws.send(JSON.stringify({ type: "nack", jobId, unsatisfied }));
}

export function ackJob(ws, jobId) {
  ws.send(JSON.stringify({ type: "ack", jobId }));
}

export function jobEvent(ws, jobId, event, data) {
  ws.send(JSON.stringify({ type: "event", jobId, event, data }));
}
