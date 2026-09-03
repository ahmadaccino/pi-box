/**
 * Headless device worker. Registers, heartbeats, accepts leases, runs Pi.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentRuntime } from "./agent.mjs";
import {
  ackJob,
  connectJobs,
  heartbeatDevice,
  jobEvent,
  nackJob,
  registerDevice,
  startHeartbeat,
} from "./device.mjs";
import { detectCapabilities } from "./host.mjs";
import {
  HEARTBEAT_MS,
  POLL_MS,
  agentHome,
  agentWorkspace,
  applyJobEnv,
  deviceAuthHeaders,
  identityPaths,
  parseNodeArgs,
  sanitizeCaps,
  snapshotUrls,
  unsatisfiedCaps,
  userAuthHeaders,
} from "./node-logic.mjs";
import { collectSnapshot, restoreSnapshot, SNAPSHOT_R2 } from "./snapshot.mjs";

export async function loginWithPassword(origin, password) {
  const res = await fetch(new URL("/api/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `login ${res.status}`);
  const setCookie = res.headers.getSetCookie?.()?.[0] || res.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  return { cookie, skipped: Boolean(body.skipped) };
}

export async function readIdentity(dir) {
  const paths = identityPaths(dir);
  try {
    const meta = JSON.parse(await readFile(paths.meta, "utf8"));
    const secret = (await readFile(paths.secret, "utf8")).trim();
    if (!meta.deviceId || !secret) return null;
    return { ...meta, deviceSecret: secret };
  } catch {
    return null;
  }
}

export async function writeIdentity(dir, ident) {
  const paths = identityPaths(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    paths.meta,
    JSON.stringify(
      {
        deviceId: ident.deviceId,
        name: ident.name,
        origin: ident.origin,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await writeFile(paths.secret, ident.deviceSecret, { mode: 0o600 });
}

export async function pullSnapshot(origin, { sessionId, deviceId, deviceSecret }) {
  const urls = snapshotUrls(origin, sessionId);
  const res = await fetch(urls.get, {
    headers: deviceAuthHeaders({ deviceId, deviceSecret }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`snapshot get ${res.status}`);
  return res.json();
}

export async function pushSnapshot(origin, { sessionId, deviceId, deviceSecret, payload }) {
  const urls = snapshotUrls(origin, sessionId);
  const res = await fetch(urls.put, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...deviceAuthHeaders({ deviceId, deviceSecret }),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`snapshot put ${res.status}`);
  return res.json();
}

async function pollJob(origin, { deviceId, deviceSecret }) {
  const res = await fetch(new URL("/api/devices/poll", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...deviceAuthHeaders({ deviceId, deviceSecret }),
    },
  });
  if (!res.ok) throw new Error(`poll ${res.status}`);
  const body = await res.json();
  return body.job || null;
}

async function postProtocol(origin, path, { deviceId, deviceSecret, body }) {
  const res = await fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...deviceAuthHeaders({ deviceId, deviceSecret }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function defaultHome(explicit) {
  return explicit || process.env.PI_BOX_HOME || path.join(os.homedir(), ".pi-box");
}

function defaultName(explicit, caps) {
  if (explicit) return explicit;
  if (process.env.PI_BOX_NAME) return process.env.PI_BOX_NAME;
  const host = os.hostname().split(".")[0] || "device";
  const arch = caps.arch || process.arch;
  return `${host}-${caps.os || process.platform}-${arch}`;
}

export async function handleDeviceJob(job, ctx) {
  const {
    origin,
    caps,
    deviceId,
    deviceSecret,
    home,
    sendEvent,
    ack,
    nack,
  } = ctx;
  const missing = unsatisfiedCaps(job, caps);
  if (missing.length) {
    await nack(job.id, missing);
    return { nacked: missing };
  }
  const agentId = job.agentId || job.sessionId || "default";
  const agentDir = agentHome(home, agentId);
  const cwd = agentWorkspace(home, agentId);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const jobEnv = applyJobEnv(job, caps, process.env);
  for (const [k, v] of Object.entries(jobEnv)) {
    if (v == null) continue;
    process.env[k] = String(v);
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CWD = cwd;
  try {
    const snap = await pullSnapshot(origin, { sessionId: job.sessionId, deviceId, deviceSecret });
    if (snap?.files) await restoreSnapshot(agentDir, snap, SNAPSHOT_R2);
  } catch (err) {
    await nack(job.id, ["snapshot"]);
    console.warn("[pi-box] snapshot restore failed", err?.message || err);
    return { failed: "snapshot" };
  }
  const runtime = createAgentRuntime({ cwd, agentDir, env: process.env });
  const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
  const message = String(payload.message || "").trim();
  if (!message) {
    await nack(job.id, ["message"]);
    return { nacked: ["message"] };
  }
  try {
    await runtime.runTurn({
      sessionId: job.sessionId,
      message,
      emit: (event, data) => sendEvent(job.id, event, data),
    });
    const collected = await collectSnapshot(agentDir, SNAPSHOT_R2);
    await pushSnapshot(origin, {
      sessionId: job.sessionId,
      deviceId,
      deviceSecret,
      payload: collected,
    });
    await ack(job.id);
    return { ok: true };
  } catch (err) {
    await nack(job.id, ["error"]);
    console.warn("[pi-box] job failed", err?.message || err);
    return { failed: err?.message || String(err) };
  }
}

export async function runNode(input = {}) {
  const opts = { ...parseNodeArgs([]), ...input };
  if (opts.help) {
    console.log(
      "usage: pi-box node [--origin URL] [--name NAME] [--password PASS] [--cookie COOKIE] [--token CLERK_JWT]",
    );
    return null;
  }
  const home = defaultHome(opts.home);
  const rawCaps = await detectCapabilities();
  const caps = sanitizeCaps(rawCaps);
  const name = defaultName(opts.name, caps);
  const origin = opts.origin.replace(/\/+$/, "");
  let cookie = opts.cookie;
  if (opts.password && !cookie) {
    const logged = await loginWithPassword(origin, opts.password);
    cookie = logged.cookie;
  }
  const userHeaders = userAuthHeaders({ cookie, token: opts.token });
  let identity = null;
  if (opts.deviceId && opts.deviceSecret) {
    identity = {
      deviceId: opts.deviceId,
      deviceSecret: opts.deviceSecret,
      name,
      origin,
    };
  } else {
    identity = await readIdentity(home);
  }
  if (identity?.deviceId) {
    try {
      await heartbeatDevice(origin, {
        deviceId: identity.deviceId,
        deviceSecret: identity.deviceSecret,
        caps,
      });
    } catch {
      identity = null;
    }
  }
  if (!identity) {
    const registered = await registerDevice(origin, {
      name,
      caps,
      headers: userHeaders,
    });
    identity = {
      deviceId: registered.deviceId,
      deviceSecret: registered.deviceSecret,
      name,
      origin,
    };
    await writeIdentity(home, identity);
    console.log(`[pi-box] joined as ${identity.deviceId}`);
  } else {
    console.log(`[pi-box] resumed ${identity.deviceId}`);
  }
  const deviceId = identity.deviceId;
  const deviceSecret = identity.deviceSecret;

  const transport = {
    ws: null,
    async sendEvent(jobId, event, data) {
      if (transport.ws?.readyState === 1) {
        jobEvent(transport.ws, jobId, event, data);
        return;
      }
      await postProtocol(origin, "/api/devices/event", {
        deviceId,
        deviceSecret,
        body: { jobId, event, data },
      });
    },
    async ack(jobId) {
      if (transport.ws?.readyState === 1) {
        ackJob(transport.ws, jobId);
        return;
      }
      await postProtocol(origin, "/api/devices/ack", {
        deviceId,
        deviceSecret,
        body: { jobId },
      });
    },
    async nack(jobId, unsatisfied) {
      if (transport.ws?.readyState === 1) {
        nackJob(transport.ws, jobId, unsatisfied);
        return;
      }
      await postProtocol(origin, "/api/devices/nack", {
        deviceId,
        deviceSecret,
        body: { jobId, unsatisfied },
      });
    },
  };

  const busy = new Set();
  async function onJob(job) {
    if (!job?.id || busy.has(job.id)) return;
    busy.add(job.id);
    try {
      await handleDeviceJob(job, {
        origin,
        caps,
        deviceId,
        deviceSecret,
        home,
        sendEvent: transport.sendEvent,
        ack: transport.ack,
        nack: transport.nack,
      });
    } finally {
      busy.delete(job.id);
    }
  }

  startHeartbeat(origin, { deviceId, deviceSecret, caps }, HEARTBEAT_MS);
  try {
    transport.ws = connectJobs(origin, {
      deviceId,
      deviceSecret,
      onJob,
      onClose() {
        transport.ws = null;
      },
    });
  } catch (err) {
    console.warn("[pi-box] websocket unavailable, using HTTP poll", err?.message || err);
  }

  const poll = setInterval(() => {
    pollJob(origin, { deviceId, deviceSecret })
      .then((job) => {
        if (job) return onJob(job);
      })
      .catch((err) => console.warn("[pi-box] poll", err.message || err));
  }, POLL_MS);

  console.log(
    `[pi-box] node online ${name} ${caps.os}/${caps.arch} ios=${caps.ios} inference=${Boolean(caps.features?.includes("inference"))}`,
  );
  return {
    deviceId,
    caps,
    stop() {
      clearInterval(poll);
      try {
        transport.ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
