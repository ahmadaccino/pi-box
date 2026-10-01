import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { DEAD_AFTER_MS, HEARTBEAT_MS, annotateSkills, isLive, unionSkills, type SkillRow } from "./caps.ts";
import { failSseBody, planChatTurn, sseChunk, waitingSseBody } from "./mesh-chat.ts";
import {
  RoutineBook,
  appendRoutineTranscript,
  assistantTextFromSse,
  claimDueRoutines,
  expireStaleRuns,
  finishRoutineRun,
  handleRoutinesRequest,
  isRoutinesApiPath,
  readRoutineBook,
  soonestNextRun,
  writeRoutineBook,
  type ClaimedRun,
} from "./routines.ts";
import { handleMeshRequest, mintDeviceSecret } from "./mesh-http.ts";
import { MeshStore, type MeshRecords } from "./mesh-state.ts";
import { sanitizeSession } from "./password.ts";
import type { Job } from "./place.ts";
import { getSnapshotBlob, putSnapshotBlob, snapshotKey } from "./snapshot-r2.ts";

export type MeshEnv = {
  MESH: DurableObjectNamespace;
  PI_BOX: DurableObjectNamespace;
  STATE?: R2Bucket;
  BROWSER?: unknown;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  GATEWAY_TOKEN?: string;
};

type Pending = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
  deviceId: string;
};

type RoutineSql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
};

export class Mesh extends DurableObject<MeshEnv> {
  pending = new Map<string, Pending>();
  routineBook = new RoutineBook();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (isRoutinesApiPath(path)) {
      return this.handleRoutines(request);
    }
    if (path === "/api/chat" && request.method === "POST") {
      return this.handleChat(request);
    }
    if (request.method === "GET" && (path === "/api/boxes" || path === "/api/skills")) {
      return this.handleRoster(request, path);
    }
    if (/^\/api\/sessions\/[^/]+\/snapshot$/.test(path)) {
      return this.handleSessionSnapshot(request, path);
    }
    const meshId = request.headers.get("x-pi-box-mesh") || "default";
    const cloudRoutines: ClaimedRun[] = [];
    const response = await this.withStore((store) =>
      handleMeshRequest({
        store,
        request,
        meshId,
        now: Date.now(),
        browser: Boolean(this.env.BROWSER),
        mintSecret: mintDeviceSecret,
        acceptWebSocket: (deviceId) => this.acceptDeviceSocket(deviceId),
        onDeviceEvent: (jobId, event, data) => {
          if (event === "text" && data && typeof data === "object") {
            const delta = String((data as { delta?: unknown }).delta || "");
            if (delta) appendRoutineTranscript(this.routineBook, jobId, delta);
          }
          return this.writePending(jobId, event, data);
        },
        onDeviceAck: async (jobId, deviceId) => {
          finishRoutineRun(this.routineBook, store, jobId, {
            status: "succeeded",
            now: Date.now(),
          });
          await this.writePending(jobId, "status", { state: "pi", runtime: deviceId });
          await this.writePending(jobId, "done", { mock: false, runtime: deviceId });
          await this.closePending(jobId);
        },
        replaceJob: async (job) => {
          const next = planChatTurn(store, {
            sessionId: job.sessionId,
            require: job.require,
            prefer: job.prefer,
            affinity: null,
            payload: job.payload,
            jobId: job.id,
            now: Date.now(),
          });
          if (next.decision.wait) {
            await this.writeRaw(job.id, waitingSseBody(next.job));
            await this.closePending(job.id);
            return;
          }
          if (next.decision.deviceId === "cloud") {
            await this.closePending(job.id);
            const link = this.routineBook.jobs.get(job.id);
            const routine = link ? this.routineBook.get(link.routineId) : undefined;
            if (link && routine) {
              const payload = (next.job.payload || {}) as { message?: string };
              cloudRoutines.push({
                routineId: link.routineId,
                runId: link.runId,
                sessionId: next.job.sessionId,
                prompt: String(payload.message || routine.prompt),
                jobId: job.id,
                decision: next.decision,
                job: next.job,
              });
            }
            return;
          }
          if (next.decision.deviceId) {
            this.sendJob(next.decision.deviceId, next.job);
          }
        },
        jobEnv: () => ({
          OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY || "",
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY || "",
          OPENAI_API_KEY: this.env.OPENAI_API_KEY || "",
          XAI_API_KEY: this.env.XAI_API_KEY || "",
        }),
      }),
    );
    for (const run of cloudRoutines) this.defer(this.dispatchClaimed(run, meshId));
    return response;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const claimed = await this.withStore((store) => {
      store.sweep(now);
      expireStaleRuns(this.routineBook, store, now);
      return claimDueRoutines(this.routineBook, store, now);
    });
    const meshId = this.routineBook.settings.meshId || "default";
    for (const run of claimed) this.defer(this.dispatchClaimed(run, meshId));
    const nextAt = await this.withStore(() => soonestNextRun(this.routineBook, Date.now()));
    const delay =
      nextAt == null ? HEARTBEAT_MS : Math.min(HEARTBEAT_MS, Math.max(1_000, nextAt - Date.now()));
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const deviceId = this.socketDeviceId(ws);
    if (!deviceId) return;
    let parsed: {
      type?: string;
      jobId?: string;
      event?: string;
      data?: unknown;
      unsatisfied?: string[];
    } = {};
    try {
      parsed = JSON.parse(String(message)) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.type === "heartbeat") {
      await this.withStore((store) => {
        const device = store.get(deviceId);
        if (device) device.lastSeen = Date.now();
      });
      return;
    }
    if (parsed.type === "event" && parsed.jobId) {
      const jobId = parsed.jobId;
      if (parsed.event === "text") {
        const delta =
          parsed.data && typeof parsed.data === "object"
            ? String((parsed.data as { delta?: unknown }).delta || "")
            : "";
        if (delta) {
          await this.withStore(() => appendRoutineTranscript(this.routineBook, jobId, delta));
        }
      }
      await this.writePending(jobId, parsed.event || "message", parsed.data);
      return;
    }
    if (parsed.type === "ack" && parsed.jobId) {
      await this.withStore((store) => {
        store.ack({ jobId: parsed.jobId as string, deviceId, now: Date.now() });
        finishRoutineRun(this.routineBook, store, parsed.jobId as string, {
          status: "succeeded",
          now: Date.now(),
        });
      });
      await this.writePending(parsed.jobId, "status", { state: "pi", runtime: deviceId });
      await this.writePending(parsed.jobId, "done", { mock: false, runtime: deviceId });
      await this.closePending(parsed.jobId);
      return;
    }
    if (parsed.type === "nack" && parsed.jobId) {
      const unsatisfied = parsed.unsatisfied || [];
      const next = await this.withStore((store) => {
        const job = store.nack({
          jobId: parsed.jobId as string,
          unsatisfied,
          now: Date.now(),
        });
        if (!job) return null;
        return planChatTurn(store, {
          sessionId: job.sessionId,
          require: job.require,
          prefer: job.prefer,
          affinity: null,
          payload: job.payload,
          jobId: job.id,
          now: Date.now(),
        });
      });
      if (!next) return;
      if (next.decision.wait) {
        await this.writeRaw(parsed.jobId, waitingSseBody(next.job));
        await this.closePending(parsed.jobId);
        return;
      }
      if (next.decision.deviceId === "cloud") {
        await this.closePending(parsed.jobId);
        return;
      }
      this.sendJob(next.decision.deviceId as string, next.job);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const deviceId = this.socketDeviceId(ws);
    if (!deviceId) return;
    await this.withStore((store) => {
      const device = store.get(deviceId);
      if (device && !device.drain) {
        device.lastSeen = Date.now() - DEAD_AFTER_MS - 1;
      }
      store.sweep(Date.now());
    });
  }

  private async handleChat(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const raw = await request.text();
    let body: { message?: string; session?: string; require?: string[] } = {};
    try {
      body = JSON.parse(raw || "{}") as typeof body;
    } catch {
      return json({ error: "invalid json" }, { status: 400 });
    }
    const sessionId = sanitizeSession(
      url.searchParams.get("session") ||
        request.headers.get("x-pi-box-session") ||
        body.session,
    );
    const meshId = request.headers.get("x-pi-box-mesh") || "default";
    const planned = await this.withStore((store) => {
      this.routineBook.rememberSession(sessionId);
      return planChatTurn(store, {
        sessionId,
        message: body.message,
        require: body.require,
        now: Date.now(),
        browser: Boolean(this.env.BROWSER),
        payload: { message: body.message, raw, sessionId },
      });
    });
    const { job, decision } = planned;
    if (decision.wait) {
      return sseResponse(waitingSseBody(job), { runtime: "waiting" });
    }
    if (decision.fail || !decision.deviceId) {
      await this.withStore((store) => store.fail(job.id));
      return sseResponse(failSseBody("no_capacity"), { runtime: "none" });
    }
    if (decision.deviceId === "cloud") {
      const restored = await this.restoreRuntime(meshId, sessionId, "cloud");
      if (!restored.ok) {
        await this.withStore((store) => store.fail(job.id));
        return sseResponse(failSseBody("snapshot restore failed"), { runtime: "cloud" });
      }
      const container = getContainer(this.env.PI_BOX, meshId);
      const headers = new Headers(request.headers);
      headers.set("x-pi-box-mesh", meshId);
      headers.set("x-pi-box-origin", new URL(request.url).origin);
      const forwarded = new Request(request.url, {
        method: "POST",
        headers,
        body: raw,
      });
      const res = await container.fetch(forwarded);
      return this.tapCloud(res, job.id, meshId, sessionId);
    }
    const restored = await this.restoreRuntime(meshId, sessionId, decision.deviceId);
    if (!restored.ok) {
      await this.withStore((store) => store.fail(job.id));
      return sseResponse(failSseBody("snapshot restore failed"), {
        runtime: decision.deviceId,
      });
    }
    return this.dispatchDevice(job, decision.deviceId, meshId);
  }

  private async handleRoster(request: Request, path: string): Promise<Response> {
    const meshId = request.headers.get("x-pi-box-mesh") || "default";
    const catalog = await this.loadCatalog(meshId);
    return this.withStore((store) => {
      const now = Date.now();
      store.sweep(now);
      const cloud = store.cloudDevice(now, Boolean(this.env.BROWSER));
      const live = [
        cloud,
        ...store.listDevices().filter((d) => isLive(d, now)),
      ];
      const capsList = live.map((d) => d.caps);
      const skills = unionSkills(catalog, capsList);
      if (path === "/api/skills") return json({ skills });
      const ios = capsList.some((c) => c.ios);
      const android = capsList.some((c) => c.android);
      const browser = capsList.some((c) => c.browser);
      return json({
        boxes: [
          {
            id: "cloud",
            name: "pi-box",
            kind: "mesh",
            platform: "mesh",
            capabilities: {
              ...cloud.caps,
              ios,
              android,
              browser,
            },
            skills: annotateSkills(catalog, {
              ...cloud.caps,
              ios,
              android,
              browser,
            }),
          },
        ],
      });
    });
  }

  private async loadCatalog(meshId: string): Promise<SkillRow[]> {
    try {
      const container = getContainer(this.env.PI_BOX, meshId);
      const res = await container.fetch("http://sidecar/api/skills");
      if (!res.ok) return [];
      const data = (await res.json()) as { skills?: SkillRow[] };
      return data.skills || [];
    } catch {
      return [];
    }
  }

  private tapCloud(res: Response, jobId: string, meshId: string, sessionId: string): Response {
    if (!res.body) {
      void this.withStore((store) => store.ack({ jobId, deviceId: "cloud", now: Date.now() }));
      void this.captureFromCloud(meshId, sessionId);
      const headers = new Headers(res.headers);
      headers.set("x-pi-box-runtime", "cloud");
      return new Response(res.body, { status: res.status, headers });
    }
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = res.body.getReader();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await this.withStore((store) =>
          store.ack({ jobId, deviceId: "cloud", now: Date.now() }),
        );
        await this.captureFromCloud(meshId, sessionId);
      } catch {
        await this.withStore((store) => store.fail(jobId, "cloud"));
      } finally {
        try {
          await writer.close();
        } catch {
          /* already closed */
        }
      }
    })();
    const headers = new Headers(res.headers);
    headers.set("x-pi-box-runtime", "cloud");
    return new Response(readable, { status: res.status, headers });
  }

  private dispatchDevice(job: Job, deviceId: string, meshId: string): Response {
    const sockets = this.ctx.getWebSockets(deviceId);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();
    this.pending.set(job.id, { writer, encoder, deviceId });
    const runtimeName = deviceId;
    const intro = sseChunk("status", { state: "pi", runtime: runtimeName });
    void writer.write(encoder.encode(intro));
    if (sockets.length) this.sendJob(deviceId, job, meshId);
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-pi-box-runtime": runtimeName,
        "x-pi-box-session": job.sessionId,
      },
    });
  }

  private sendJob(deviceId: string, job: Job, meshId = "default") {
    const sockets = this.ctx.getWebSockets(deviceId);
    const wire = {
      type: "job",
      job: {
        id: job.id,
        sessionId: job.sessionId,
        require: job.require,
        payload: job.payload,
        snapshotKey: snapshotKey(meshId, job.sessionId),
        env: {
          OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY || "",
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY || "",
          OPENAI_API_KEY: this.env.OPENAI_API_KEY || "",
          XAI_API_KEY: this.env.XAI_API_KEY || "",
        },
      },
    };
    const text = JSON.stringify(wire);
    for (const ws of sockets) ws.send(text);
  }

  private async restoreRuntime(
    meshId: string,
    sessionId: string,
    runtime: string,
  ): Promise<{ ok: boolean }> {
    const result = await this.withStore((store) =>
      getSnapshotBlob(this.env.STATE, store, sessionId),
    );
    if (!result.ok) {
      if (result.reason === "no_pointer") return { ok: true };
      if (result.reason === "r2_unavailable" && runtime === "cloud") return { ok: true };
      return { ok: false };
    }
    if (runtime !== "cloud") return { ok: true };
    try {
      const container = getContainer(this.env.PI_BOX, meshId);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-pi-box-snapshot": "r2",
      };
      if (this.env.GATEWAY_TOKEN) headers["x-pi-box-internal"] = this.env.GATEWAY_TOKEN;
      const res = await container.fetch(
        new Request("http://sidecar/internal/snapshot?wide=1", {
          method: "PUT",
          headers,
          body: result.body,
        }),
      );
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  private async captureFromCloud(meshId: string, sessionId: string) {
    if (!this.env.STATE) return;
    try {
      const container = getContainer(this.env.PI_BOX, meshId);
      const headers: Record<string, string> = { "x-pi-box-snapshot": "r2" };
      if (this.env.GATEWAY_TOKEN) headers["x-pi-box-internal"] = this.env.GATEWAY_TOKEN;
      const res = await container.fetch(
        new Request("http://sidecar/internal/snapshot?wide=1", { headers }),
      );
      if (!res.ok) return;
      const body = await res.arrayBuffer();
      await this.withStore((store) =>
        putSnapshotBlob(this.env.STATE, store, meshId, sessionId, body),
      );
    } catch {
      /* keep in-DO snapshot */
    }
  }

  private async handleSessionSnapshot(request: Request, path: string): Promise<Response> {
    const sessionId = sanitizeSession(path.split("/")[3] || "");
    const meshId = request.headers.get("x-pi-box-mesh") || "default";
    const method = request.method.toUpperCase();
    if (method === "GET") {
      const got = await this.withStore((store) =>
        getSnapshotBlob(this.env.STATE, store, sessionId),
      );
      if (!got.ok) {
        return json({ error: got.reason }, { status: got.reason === "no_pointer" ? 404 : 503 });
      }
      return new Response(got.body, { headers: { "content-type": "application/json" } });
    }
    if (method === "PUT") {
      const body = await request.arrayBuffer();
      const pointer = await this.withStore((store) =>
        putSnapshotBlob(this.env.STATE, store, meshId, sessionId, body),
      );
      if (!pointer) return json({ error: "r2_unavailable" }, { status: 503 });
      return json({ ok: true, pointer });
    }
    return json({ error: "method not allowed" }, { status: 405 });
  }

  private async writePending(jobId: string, event: string, data: unknown) {
    const pending = this.pending.get(jobId);
    if (!pending) return;
    await pending.writer.write(pending.encoder.encode(sseChunk(event, data)));
  }

  private async writeRaw(jobId: string, body: string) {
    const pending = this.pending.get(jobId);
    if (!pending) return;
    await pending.writer.write(pending.encoder.encode(body));
  }

  private async closePending(jobId: string) {
    const pending = this.pending.get(jobId);
    this.pending.delete(jobId);
    if (!pending) return;
    try {
      await pending.writer.close();
    } catch {
      /* already closed */
    }
  }

  private acceptDeviceSocket(deviceId: string): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [deviceId]);
    pair[1].serializeAttachment({ deviceId });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private socketDeviceId(ws: WebSocket): string {
    const att = ws.deserializeAttachment() as { deviceId?: string } | null;
    if (att?.deviceId) return att.deviceId;
    const tags = this.ctx.getTags(ws);
    return tags[0] || "";
  }

  private async handleRoutines(request: Request): Promise<Response> {
    const meshId = request.headers.get("x-pi-box-mesh") || "default";
    const origin = new URL(request.url).origin;
    const claimed: ClaimedRun[] = [];
    const response = await this.withStore((store) => {
      if (this.routineBook.settings.meshId !== meshId) {
        this.routineBook.settings.meshId = meshId;
        this.routineBook.dirty = true;
      }
      return handleRoutinesRequest({
        book: this.routineBook,
        store,
        request,
        meshId,
        now: Date.now(),
        origin,
        onClaim: (run) => claimed.push(run),
      });
    });
    for (const run of claimed) this.defer(this.dispatchClaimed(run, meshId));
    return response || json({ error: "not found" }, { status: 404 });
  }

  private defer(task: Promise<unknown>) {
    const tracked = task.catch((err) => {
      console.error("[pi-box] routine dispatch failed", err);
    });
    const ctx = this.ctx as { waitUntil?: (promise: Promise<unknown>) => void };
    if (typeof ctx.waitUntil === "function") ctx.waitUntil(tracked);
    else void tracked;
  }

  private async dispatchClaimed(claimed: ClaimedRun, meshId: string) {
    const decision = claimed.decision;
    if (decision.wait || decision.fail || !decision.deviceId) {
      await this.withStore((store) => {
        store.fail(claimed.jobId);
        finishRoutineRun(this.routineBook, store, claimed.jobId, {
          status: decision.wait ? "waiting" : "failed",
          error: decision.wait ? "waiting for a matching machine" : "no_capacity",
          now: Date.now(),
        });
      });
      return;
    }
    if (decision.deviceId !== "cloud") {
      this.sendJob(decision.deviceId, claimed.job, meshId);
      return;
    }
    const restored = await this.restoreRuntime(meshId, claimed.sessionId, "cloud");
    if (!restored.ok) {
      await this.withStore((store) => {
        store.fail(claimed.jobId, "cloud");
        finishRoutineRun(this.routineBook, store, claimed.jobId, {
          status: "failed",
          error: "snapshot restore failed",
          now: Date.now(),
        });
      });
      return;
    }
    try {
      const container = getContainer(this.env.PI_BOX, meshId);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-pi-box-session": claimed.sessionId,
        "x-pi-box-mesh": meshId,
      };
      if (this.env.GATEWAY_TOKEN) headers["x-pi-box-internal"] = this.env.GATEWAY_TOKEN;
      const res = await container.fetch(
        new Request(
          `http://sidecar/api/chat?session=${encodeURIComponent(claimed.sessionId)}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ message: claimed.prompt, session: claimed.sessionId }),
          },
        ),
      );
      const text = await res.text();
      const assistant = assistantTextFromSse(text);
      const failed = !res.ok || /(^|\n)event:\s*error/.test(text);
      await this.withStore((store) => {
        if (failed) store.fail(claimed.jobId, "cloud");
        else store.ack({ jobId: claimed.jobId, deviceId: "cloud", now: Date.now() });
        finishRoutineRun(this.routineBook, store, claimed.jobId, {
          status: failed ? "failed" : "succeeded",
          result: assistant,
          error: failed ? "run failed" : "",
          now: Date.now(),
        });
      });
      if (!failed) await this.captureFromCloud(meshId, claimed.sessionId);
    } catch (err) {
      await this.withStore((store) => {
        store.fail(claimed.jobId, "cloud");
        finishRoutineRun(this.routineBook, store, claimed.jobId, {
          status: "failed",
          error: err instanceof Error ? err.message : "cloud run failed",
          now: Date.now(),
        });
      });
    }
  }

  private storageSql(): RoutineSql | null {
    const storage = this.ctx.storage as { sql?: RoutineSql };
    return storage.sql || null;
  }

  private loadRoutineBook() {
    const sql = this.storageSql();
    if (!sql) return;
    this.routineBook = readRoutineBook(sql);
  }

  private saveRoutineBook() {
    const sql = this.storageSql();
    if (!sql || !this.routineBook.dirty) return;
    writeRoutineBook(sql, this.routineBook);
  }

  private async withStore<T>(fn: (store: MeshStore) => Promise<T> | T): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const raw = await this.ctx.storage.get<MeshRecords>("mesh");
      const store = new MeshStore(raw || null);
      this.loadRoutineBook();
      const result = await fn(store);
      await this.ctx.storage.put("mesh", store.snapshot());
      this.saveRoutineBook();
      if (!(await this.ctx.storage.getAlarm())) {
        await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      }
      return result;
    });
  }
}

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function sseResponse(
  body: string,
  opts: { runtime?: string; stream?: ReadableStream<Uint8Array> } = {},
): Response {
  const headers = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-pi-box-runtime": opts.runtime || "",
  };
  if (opts.stream) return new Response(opts.stream, { headers });
  return new Response(body, { headers });
}
