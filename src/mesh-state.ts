import { timingSafeEqual } from "./password.ts";
import {
  type Caps,
  type Device,
  DEAD_AFTER_MS,
  LEASE_MS,
  cloudDevice,
  jobFallback,
} from "./caps.ts";
import type { Job } from "./place.ts";

export type SnapshotPointer = {
  sessionId: string;
  r2Key: string;
  etag: string;
  updatedAt: number;
};

export type MeshRecords = {
  devices: Record<string, Device>;
  jobs: Record<string, Job>;
  placement: Record<string, string>;
  pointers: Record<string, SnapshotPointer>;
};

export async function hashSecret(secret: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function mintDeviceId(meshId: string, uuid: string): string {
  return `d_${meshId}_${uuid}`;
}

export function parseMeshId(deviceId: string): string | null {
  const m =
    /^d_(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      deviceId,
    );
  return m ? m[1] : null;
}

function emptyRecords(): MeshRecords {
  return { devices: {}, jobs: {}, placement: {}, pointers: {} };
}

export class MeshStore {
  data: MeshRecords;

  constructor(data?: MeshRecords | null) {
    this.data = data ? structuredClone(data) : emptyRecords();
  }

  snapshot(): MeshRecords {
    return structuredClone(this.data);
  }

  get(deviceId: string): Device | undefined {
    return this.data.devices[deviceId];
  }

  getJob(jobId: string): Job | undefined {
    return this.data.jobs[jobId];
  }

  listDevices(): Device[] {
    return Object.values(this.data.devices).filter((d) => d.id !== "cloud");
  }

  cloudDevice(now: number, browser = true): Device {
    return cloudDevice(now, browser);
  }

  register(input: {
    meshId: string;
    name: string;
    caps: Caps;
    tokenHash: string;
    now: number;
    uuid: string;
  }): { deviceId: string; device: Device } {
    const deviceId = mintDeviceId(input.meshId, input.uuid);
    const device: Device = {
      id: deviceId,
      name: String(input.name || "device").slice(0, 64),
      tokenHash: input.tokenHash,
      caps: { ...input.caps },
      lastSeen: input.now,
      drain: false,
      inflight: this.data.devices[deviceId]?.inflight || 0,
    };
    this.data.devices[deviceId] = device;
    return { deviceId, device };
  }

  heartbeat(input: {
    deviceId: string;
    tokenHash: string;
    caps?: Caps;
    now: number;
  }): { ok: boolean } {
    const device = this.data.devices[input.deviceId];
    if (!device?.tokenHash) return { ok: false };
    if (!timingSafeEqual(device.tokenHash, input.tokenHash)) return { ok: false };
    if (input.caps) device.caps = { ...input.caps };
    device.lastSeen = input.now;
    return { ok: true };
  }

  drain(deviceId: string): boolean {
    const device = this.data.devices[deviceId];
    if (!device) return false;
    device.drain = true;
    return true;
  }

  delete(deviceId: string): { ok: boolean; error?: string } {
    const device = this.data.devices[deviceId];
    if (!device) return { ok: false, error: "not found" };
    if (device.inflight > 0 && !device.drain) {
      return { ok: false, error: "drain first" };
    }
    this.requeueFor(deviceId);
    delete this.data.devices[deviceId];
    return { ok: true };
  }

  enqueue(input: {
    id: string;
    sessionId: string;
    agentId?: string;
    require?: string[];
    prefer?: string[];
    affinity?: string | null;
    fallback?: "cloud" | "wait";
    payload?: unknown;
    now: number;
  }): Job {
    const require = [...(input.require || [])];
    const job: Job = {
      id: input.id,
      sessionId: input.sessionId,
      agentId: input.agentId || input.sessionId,
      require,
      prefer: [...(input.prefer || [])],
      affinity:
        input.affinity ?? this.data.placement[input.sessionId] ?? null,
      fallback: input.fallback || jobFallback(require),
      payload: input.payload,
      state: "queued",
      leasedTo: null,
      leaseUntil: 0,
    };
    this.data.jobs[job.id] = job;
    return job;
  }

  tryLease(input: {
    jobId: string;
    deviceId: string;
    now: number;
  }): { ok: boolean } {
    const job = this.data.jobs[input.jobId];
    if (!job) return { ok: false };
    if (
      job.state === "leased" &&
      job.leasedTo &&
      job.leasedTo !== input.deviceId &&
      (job.leaseUntil || 0) > input.now
    ) {
      return { ok: false };
    }
    if (job.state === "done" || job.state === "failed") return { ok: false };
    if (job.state === "leased" && job.leasedTo === input.deviceId) {
      job.leaseUntil = input.now + LEASE_MS;
      return { ok: true };
    }
    if (job.state === "leased" && job.leasedTo) {
      this.decInflight(job.leasedTo);
    }
    job.state = "leased";
    job.leasedTo = input.deviceId;
    job.leaseUntil = input.now + LEASE_MS;
    this.incInflight(input.deviceId);
    return { ok: true };
  }

  ack(input: { jobId: string; deviceId: string; now: number }): { ok: boolean } {
    const job = this.data.jobs[input.jobId];
    if (!job || job.leasedTo !== input.deviceId) return { ok: false };
    job.state = "done";
    job.leaseUntil = 0;
    this.decInflight(input.deviceId);
    this.data.placement[job.sessionId] = input.deviceId;
    job.leasedTo = input.deviceId;
    return { ok: true };
  }

  nack(input: {
    jobId: string;
    unsatisfied: string[];
    now: number;
  }): Job | undefined {
    const job = this.data.jobs[input.jobId];
    if (!job) return undefined;
    if (job.leasedTo) this.decInflight(job.leasedTo);
    const extra = input.unsatisfied.filter(Boolean);
    job.require = [...new Set([...job.require, ...extra])];
    job.fallback = jobFallback(job.require);
    job.state = "queued";
    job.leasedTo = null;
    job.leaseUntil = 0;
    return job;
  }

  fail(jobId: string, deviceId?: string): Job | undefined {
    const job = this.data.jobs[jobId];
    if (!job) return undefined;
    if (job.leasedTo) this.decInflight(job.leasedTo);
    job.state = "failed";
    job.leasedTo = deviceId || job.leasedTo || null;
    job.leaseUntil = 0;
    return job;
  }

  sweep(now: number): { dead: string[]; requeued: string[] } {
    const dead: string[] = [];
    for (const device of Object.values(this.data.devices)) {
      if (device.id === "cloud" || device.caps.cloud) continue;
      if (now - device.lastSeen >= DEAD_AFTER_MS) {
        dead.push(device.id);
        device.inflight = 0;
      }
    }
    const requeued: string[] = [];
    for (const job of Object.values(this.data.jobs)) {
      const expired =
        job.state === "leased" && (job.leaseUntil || 0) <= now;
      const ownerDead = Boolean(job.leasedTo && dead.includes(job.leasedTo));
      if (job.state === "leased" && (expired || ownerDead)) {
        job.state = "queued";
        job.leasedTo = null;
        job.leaseUntil = 0;
        requeued.push(job.id);
      }
    }
    return { dead, requeued };
  }

  putPointer(pointer: SnapshotPointer): void {
    this.data.pointers[pointer.sessionId] = pointer;
  }

  getPointer(sessionId: string): SnapshotPointer | undefined {
    return this.data.pointers[sessionId];
  }

  lastDevice(sessionId: string): string | undefined {
    return this.data.placement[sessionId];
  }

  inbox(deviceId: string): Job[] {
    return Object.values(this.data.jobs).filter(
      (job) => job.state === "leased" && job.leasedTo === deviceId,
    );
  }

  private incInflight(deviceId: string) {
    const device = this.data.devices[deviceId];
    if (device) device.inflight += 1;
  }

  private decInflight(deviceId: string) {
    const device = this.data.devices[deviceId];
    if (device && device.inflight > 0) device.inflight -= 1;
  }

  private requeueFor(deviceId: string) {
    for (const job of Object.values(this.data.jobs)) {
      if (job.state === "leased" && job.leasedTo === deviceId) {
        job.state = "queued";
        job.leasedTo = null;
        job.leaseUntil = 0;
      }
    }
  }
}
