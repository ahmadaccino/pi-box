import {
  MeshStore,
  hashSecret,
  parseMeshId,
} from "./mesh-state.ts";
import { publicDevice } from "./caps.ts";
import type { Caps } from "./caps.ts";
import type { Job } from "./place.ts";
import { snapshotKey } from "./snapshot-r2.ts";

export type MeshHttpOpts = {
  store: MeshStore;
  request: Request;
  meshId: string;
  now: number;
  browser?: boolean;
  mintUuid?: () => string;
  mintSecret?: () => string;
  acceptWebSocket?: (deviceId: string) => Response | Promise<Response>;
  onDeviceEvent?: (jobId: string, event: string, data: unknown) => Promise<void> | void;
  onDeviceAck?: (jobId: string, deviceId: string) => Promise<void> | void;
  replaceJob?: (job: Job) => Promise<void> | void;
  jobEnv?: () => Record<string, string>;
};

export function isMeshDevicePath(pathname: string): boolean {
  return pathname === "/api/devices" || pathname.startsWith("/api/devices/");
}

export function isDeviceTokenPath(pathname: string): boolean {
  return (
    pathname === "/api/devices/heartbeat" ||
    pathname === "/api/devices/connect" ||
    pathname === "/api/devices/poll" ||
    pathname === "/api/devices/ack" ||
    pathname === "/api/devices/nack" ||
    pathname === "/api/devices/event"
  );
}

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function actorOf(request: Request): string {
  return (request.headers.get("x-pi-box-actor") || "user").toLowerCase();
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  const url = new URL(request.url);
  return url.searchParams.get("token") || "";
}

function deviceIdOf(request: Request): string {
  return (
    request.headers.get("x-pi-box-device") ||
    new URL(request.url).searchParams.get("device") ||
    ""
  );
}

function publicJob(job: Job, meshId: string, env?: Record<string, string>) {
  return {
    id: job.id,
    sessionId: job.sessionId,
    require: job.require,
    prefer: job.prefer,
    payload: job.payload,
    snapshotKey: snapshotKey(meshId, job.sessionId),
    ...(env ? { env } : {}),
  };
}

async function requireDevice(
  opts: MeshHttpOpts,
): Promise<{ deviceId: string } | Response> {
  const deviceId = deviceIdOf(opts.request);
  const secret = bearer(opts.request);
  if (!deviceId || !secret || parseMeshId(deviceId) !== opts.meshId) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const tokenHash = await hashSecret(secret);
  const result = opts.store.heartbeat({
    deviceId,
    tokenHash,
    now: opts.now,
  });
  if (!result.ok) return json({ error: "unauthorized" }, { status: 401 });
  return { deviceId };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export function mintDeviceSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleMeshRequest(opts: MeshHttpOpts): Promise<Response> {
  const url = new URL(opts.request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = opts.request.method.toUpperCase();
  const store = opts.store;
  const actor = actorOf(opts.request);

  if (method === "GET" && path === "/api/devices") {
    if (actor !== "user") {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    store.sweep(opts.now);
    const cloud = store.cloudDevice(opts.now, opts.browser !== false);
    const devices = [
      publicDevice(cloud, opts.now),
      ...store.listDevices().map((d) => publicDevice(d, opts.now)),
    ];
    return json({ devices });
  }

  if (method === "POST" && path === "/api/devices/register") {
    if (actor !== "user") {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson(opts.request);
    const secret = (opts.mintSecret || mintDeviceSecret)();
    const uuid = (opts.mintUuid || crypto.randomUUID.bind(crypto))();
    const tokenHash = await hashSecret(secret);
    const registered = store.register({
      meshId: opts.meshId,
      name: String(body.name || "device"),
      caps: (body.caps || {}) as Caps,
      tokenHash,
      now: opts.now,
      uuid,
    });
    return json({ deviceId: registered.deviceId, deviceSecret: secret });
  }

  if (method === "POST" && path === "/api/devices/heartbeat") {
    const deviceId = deviceIdOf(opts.request);
    const secret = bearer(opts.request);
    if (!deviceId || !secret || parseMeshId(deviceId) !== opts.meshId) {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson(opts.request);
    const tokenHash = await hashSecret(secret);
    const result = store.heartbeat({
      deviceId,
      tokenHash,
      caps: (body.caps as Caps) || undefined,
      now: opts.now,
    });
    if (!result.ok) return json({ error: "unauthorized" }, { status: 401 });
    return json({ ok: true, deviceId });
  }

  if (path === "/api/devices/connect") {
    const deviceId = deviceIdOf(opts.request);
    const secret = bearer(opts.request);
    if (!deviceId || !secret || parseMeshId(deviceId) !== opts.meshId) {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    const tokenHash = await hashSecret(secret);
    const result = store.heartbeat({
      deviceId,
      tokenHash,
      now: opts.now,
    });
    if (!result.ok) return json({ error: "unauthorized" }, { status: 401 });
    if (opts.acceptWebSocket) return opts.acceptWebSocket(deviceId);
    return json({ ok: true, connected: true });
  }

  if (method === "POST" && path === "/api/devices/poll") {
    const auth = await requireDevice(opts);
    if (auth instanceof Response) return auth;
    const job = store.inbox(auth.deviceId)[0] || null;
    const env = opts.jobEnv ? opts.jobEnv() : undefined;
    return json({ job: job ? publicJob(job, opts.meshId, env) : null });
  }

  if (method === "POST" && path === "/api/devices/event") {
    const auth = await requireDevice(opts);
    if (auth instanceof Response) return auth;
    const body = await readJson(opts.request);
    const jobId = String(body.jobId || "");
    const job = store.getJob(jobId);
    if (!job || job.leasedTo !== auth.deviceId) {
      return json({ error: "not found" }, { status: 404 });
    }
    if (opts.onDeviceEvent) {
      await opts.onDeviceEvent(jobId, String(body.event || "message"), body.data);
    }
    return json({ ok: true });
  }

  if (method === "POST" && path === "/api/devices/ack") {
    const auth = await requireDevice(opts);
    if (auth instanceof Response) return auth;
    const body = await readJson(opts.request);
    const jobId = String(body.jobId || "");
    const result = store.ack({ jobId, deviceId: auth.deviceId, now: opts.now });
    if (!result.ok) return json({ error: "not found" }, { status: 404 });
    if (opts.onDeviceAck) await opts.onDeviceAck(jobId, auth.deviceId);
    return json({ ok: true });
  }

  if (method === "POST" && path === "/api/devices/nack") {
    const auth = await requireDevice(opts);
    if (auth instanceof Response) return auth;
    const body = await readJson(opts.request);
    const jobId = String(body.jobId || "");
    const job = store.getJob(jobId);
    if (!job || (job.leasedTo && job.leasedTo !== auth.deviceId)) {
      return json({ error: "not found" }, { status: 404 });
    }
    const unsatisfied = Array.isArray(body.unsatisfied)
      ? body.unsatisfied.map(String)
      : [];
    const next = store.nack({ jobId, unsatisfied, now: opts.now });
    if (!next) return json({ error: "not found" }, { status: 404 });
    if (opts.replaceJob) await opts.replaceJob(next);
    return json({ ok: true, require: next.require });
  }

  const drainMatch = path.match(/^\/api\/devices\/([^/]+)\/drain$/);
  if (method === "POST" && drainMatch) {
    if (actor !== "user") return json({ error: "unauthorized" }, { status: 401 });
    const id = decodeURIComponent(drainMatch[1]);
    if (id === "cloud") return json({ error: "cannot drain cloud" }, { status: 400 });
    if (!store.drain(id)) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, drain: true, id });
  }

  const deleteMatch = path.match(/^\/api\/devices\/([^/]+)$/);
  if (method === "DELETE" && deleteMatch) {
    if (actor !== "user") return json({ error: "unauthorized" }, { status: 401 });
    const id = decodeURIComponent(deleteMatch[1]);
    if (id === "cloud") return json({ error: "cannot delete cloud" }, { status: 400 });
    const result = store.delete(id);
    if (!result.ok) {
      return json({ error: result.error }, { status: result.error === "not found" ? 404 : 409 });
    }
    return json({ ok: true, deleted: id });
  }

  return json({ error: "not found" }, { status: 404 });
}
