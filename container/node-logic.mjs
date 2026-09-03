/**
 * Testable headless-node helpers. No network, no Pi session.
 */
import path from "node:path";

export const INFERENCE_URL = "http://127.0.0.1:8000/v1";
export const DEFAULT_ORIGIN = "https://pi-box.ahmad-096.workers.dev";
export const HEARTBEAT_MS = 15_000;
export const POLL_MS = 2_000;

export function sanitizeCaps(caps = {}) {
  const out = { ...caps, features: [...(caps.features || [])] };
  const darwin = out.os === "darwin" || out.platform === "darwin";
  if (!darwin) {
    out.ios = false;
    out.features = out.features.filter(
      (f) => f !== "ios" && f !== "ios-simulator",
    );
  }
  return out;
}

function capSatisfied(caps, req) {
  if (req === "ios" || req === "ios-simulator") return caps.ios === true;
  if (req === "android") return caps.android === true;
  if (req === "browser") return caps.browser === true;
  if (req === "vault") return caps.vault === true;
  if (req === "os=darwin") return caps.os === "darwin" || caps.platform === "darwin";
  if (req === "os=linux") return caps.os === "linux" || caps.platform === "linux";
  if (req === "gpu=nvidia" || req === "cuda") return caps.gpu === "nvidia";
  if (req === "arch=arm64") return caps.arch === "arm64";
  if (req === "arch=x64") return caps.arch === "x64";
  if (req === "inference" || req === "inference=openai-compat") {
    return (
      caps.features?.includes("inference") ||
      caps.features?.includes("inference=openai-compat") ||
      caps.inference === true ||
      caps.gpu === "nvidia"
    );
  }
  if (caps.features?.includes(req)) return true;
  return Boolean(caps[req]);
}

export function unsatisfiedCaps(job, caps) {
  return (job?.require || []).filter((req) => !capSatisfied(caps, req));
}

export function hasInference(caps = {}) {
  return (
    caps.features?.includes("inference") ||
    caps.features?.includes("inference=openai-compat") ||
    caps.inference === true
  );
}

export function applyJobEnv(job, caps, processEnv = {}) {
  const injected = { ...(job?.env || {}) };
  const merged = { ...processEnv, ...injected };
  if (!hasInference(caps)) {
    if (!("OPENAI_BASE_URL" in merged) || merged.OPENAI_BASE_URL === "") {
      delete merged.OPENAI_BASE_URL;
    }
    return merged;
  }
  const url = processEnv.PI_BOX_INFERENCE_URL || INFERENCE_URL;
  return {
    ...merged,
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: processEnv.OPENAI_API_KEY || injected.OPENAI_API_KEY || "local",
    OPENROUTER_API_KEY: processEnv.OPENROUTER_API_KEY || "",
  };
}

export function parseNodeArgs(argv) {
  const raw = [...argv];
  const flags = {};
  const positionals = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (token === "--") continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "1";
      }
      continue;
    }
    positionals.push(token);
  }
  return {
    command: "node",
    origin: flags.origin || process.env.PI_BOX_ORIGIN || DEFAULT_ORIGIN,
    name: flags.name || process.env.PI_BOX_NAME || "",
    password: flags.password || process.env.PI_BOX_PASSWORD || "",
    cookie: flags.cookie || process.env.PI_BOX_COOKIE || "",
    token: flags.token || flags["clerk-token"] || process.env.PI_BOX_CLERK_TOKEN || "",
    home: flags.home || process.env.PI_BOX_HOME || "",
    deviceId: flags.device || process.env.PI_BOX_DEVICE_ID || "",
    deviceSecret: flags.secret || process.env.PI_BOX_DEVICE_SECRET || "",
    help: Boolean(flags.help),
    positionals,
  };
}

export function identityPaths(dir) {
  return {
    dir,
    secret: path.join(dir, "device.secret"),
    meta: path.join(dir, "device.json"),
  };
}

export function snapshotUrls(origin, sessionId) {
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`, origin);
  return { get: url.href, put: url.href };
}

export function userAuthHeaders({ cookie, token } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function deviceAuthHeaders({ deviceId, deviceSecret } = {}) {
  return {
    authorization: `Bearer ${deviceSecret}`,
    "x-pi-box-device": deviceId,
  };
}

export function agentHome(root, agentId) {
  return path.join(root, "agents", String(agentId || "default"));
}

export function agentWorkspace(root, agentId) {
  return path.join(root, "workspaces", String(agentId || "default"));
}
