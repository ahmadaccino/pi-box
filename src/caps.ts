export const HEARTBEAT_MS = 15_000;
export const DEAD_AFTER_MS = 45_000;
export const LEASE_MS = 60_000;

export const DEVICE_ONLY = [
  "ios",
  "ios-simulator",
  "android",
  "cuda",
  "gpu=nvidia",
] as const;

export type Caps = {
  os?: "linux" | "darwin" | string;
  arch?: "x64" | "arm64" | string;
  ramGb?: number;
  gpu?: "nvidia" | "apple" | "none" | string;
  features?: string[];
  platform?: string;
  ios?: boolean;
  android?: boolean;
  browser?: boolean;
  vault?: boolean;
  cloud?: boolean;
};

export type Device = {
  id: string;
  name: string;
  tokenHash?: string;
  caps: Caps;
  lastSeen: number;
  drain: boolean;
  inflight: number;
};

export function inflightCap(ramGb?: number, isCloud = false): number {
  if (isCloud) return 1;
  const ram = Number(ramGb);
  if (!Number.isFinite(ram) || ram < 4) return 1;
  return Math.min(8, Math.max(1, Math.floor(ram / 4)));
}

export function isLive(device: Device, now: number): boolean {
  if (device.drain) return false;
  if (device.id === "cloud" || device.caps.cloud) return true;
  return now - device.lastSeen < DEAD_AFTER_MS;
}

export function jobFallback(require: string[]): "cloud" | "wait" {
  return require.some((r) => (DEVICE_ONLY as readonly string[]).includes(r))
    ? "wait"
    : "cloud";
}

export function satisfiesRequire(caps: Caps, req: string): boolean {
  if (req === "ios" || req === "ios-simulator") return caps.ios === true;
  if (req === "android") return caps.android === true;
  if (req === "browser") return caps.browser === true;
  if (req === "vault") return caps.vault === true;
  if (req === "os=darwin") return caps.os === "darwin" || caps.platform === "darwin";
  if (req === "os=linux") return caps.os === "linux" || caps.platform === "linux";
  if (req === "gpu=nvidia" || req === "cuda") return caps.gpu === "nvidia";
  if (req === "arch=arm64") return caps.arch === "arm64";
  if (req === "arch=x64") return caps.arch === "x64";
  if (caps.features?.includes(req)) return true;
  return Boolean((caps as Record<string, unknown>)[req]);
}

export function satisfiesAll(caps: Caps, require: string[]): boolean {
  return require.every((r) => satisfiesRequire(caps, r));
}

export function satisfiesPrefer(caps: Caps, prefer: string[]): boolean {
  if (!prefer.length) return false;
  return prefer.every((r) => satisfiesRequire(caps, r));
}

export function cloudCaps(browser = true): Caps {
  return {
    os: "linux",
    arch: "x64",
    ramGb: 4,
    gpu: "none",
    features: browser ? ["browser"] : [],
    platform: "linux",
    ios: false,
    android: false,
    browser,
    vault: true,
    cloud: true,
  };
}

export function cloudDevice(now = 0, browser = true): Device {
  return {
    id: "cloud",
    name: "cloudflare",
    caps: cloudCaps(browser),
    lastSeen: now,
    drain: false,
    inflight: 0,
  };
}

export function publicDevice(device: Device, now: number) {
  const cap = inflightCap(device.caps.ramGb, device.id === "cloud" || device.caps.cloud);
  return {
    id: device.id,
    name: device.name,
    caps: device.caps,
    lastSeen: device.lastSeen,
    drain: device.drain,
    inflight: device.inflight,
    online: isLive({ ...device, drain: false }, now) && !device.drain,
    inflightCap: cap,
  };
}
