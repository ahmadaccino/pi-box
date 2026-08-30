import {
  MeshStore,
  hashSecret,
  parseMeshId,
} from "./mesh-state.ts";
import { publicDevice } from "./caps.ts";
import type { Caps } from "./caps.ts";

export type MeshHttpOpts = {
  store: MeshStore;
  request: Request;
  meshId: string;
  now: number;
  browser?: boolean;
  mintUuid?: () => string;
  mintSecret?: () => string;
  acceptWebSocket?: (deviceId: string) => Response | Promise<Response>;
};

export function isMeshDevicePath(pathname: string): boolean {
  return pathname === "/api/devices" || pathname.startsWith("/api/devices/");
}

export function isDeviceTokenPath(pathname: string): boolean {
  return (
    pathname === "/api/devices/heartbeat" || pathname === "/api/devices/connect"
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
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function deviceIdOf(request: Request): string {
  return request.headers.get("x-pi-box-device") || "";
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
