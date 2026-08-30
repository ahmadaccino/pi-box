import {
  type Device,
  type Caps,
  inflightCap,
  isLive,
  satisfiesAll,
  satisfiesPrefer,
} from "./caps.ts";

export type Job = {
  id: string;
  sessionId: string;
  agentId?: string;
  require: string[];
  prefer: string[];
  affinity: string | null;
  fallback: "cloud" | "wait";
  payload?: unknown;
  state?: "queued" | "leased" | "done" | "failed";
  leaseUntil?: number;
  leasedTo?: string | null;
};

export type PlaceResult =
  | { deviceId: string; wait?: undefined; fail?: undefined }
  | { wait: true; deviceId?: undefined; fail?: undefined }
  | { fail: "no_capacity"; deviceId?: undefined; wait?: undefined };

function capOf(device: Device): number {
  return inflightCap(device.caps.ramGb, device.id === "cloud" || Boolean(device.caps.cloud));
}

function belowCap(device: Device): boolean {
  return device.inflight < capOf(device);
}

function rank(a: Device, b: Device): number {
  if (a.inflight !== b.inflight) return a.inflight - b.inflight;
  const ra = Number(a.caps.ramGb) || 0;
  const rb = Number(b.caps.ramGb) || 0;
  if (ra !== rb) return rb - ra;
  return String(a.name).localeCompare(String(b.name));
}

export function place(
  job: Job,
  devices: Device[],
  cloud: Device | null,
  now = Date.now(),
): PlaceResult {
  const live: Device[] = devices.filter(
    (d) => d.id !== "cloud" && isLive(d, now) && belowCap(d),
  );
  if (job.fallback !== "wait" && cloud && isLive(cloud, now) && belowCap(cloud)) {
    live.push(cloud);
  }
  const matched = live.filter((d) => satisfiesAll(d.caps as Caps, job.require || []));
  if (job.affinity) {
    const sticky = matched.find((d) => d.id === job.affinity);
    if (sticky) return { deviceId: sticky.id };
  }
  const preferred = matched.filter((d) =>
    satisfiesPrefer(d.caps as Caps, job.prefer || []),
  );
  const pool = preferred.length ? preferred : matched;
  if (!pool.length) {
    if (job.fallback === "wait") return { wait: true };
    return { fail: "no_capacity" };
  }
  const chosen = [...pool].sort(rank)[0];
  return { deviceId: chosen.id };
}
