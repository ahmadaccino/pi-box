import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { DEAD_AFTER_MS, HEARTBEAT_MS, annotateSkills, isLive, unionSkills, type SkillRow } from "./caps.ts";
import { failSseBody, planChatTurn, sseChunk, waitingSseBody } from "./mesh-chat.ts";
import { handleMeshRequest, mintDeviceSecret } from "./mesh-http.ts";
import { MeshStore, type MeshRecords } from "./mesh-state.ts";
import { sanitizeSession } from "./password.ts";
import type { Job } from "./place.ts";

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

export class Mesh extends DurableObject<MeshEnv> {
  pending = new Map<string, Pending>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/chat" && request.method === "POST") {
      return this.handleChat(request);
    }
    if (request.method === "GET" && (path === "/api/boxes" || path === "/api/skills")) {
      return this.handleRoster(request, path);
    }
    return this.withStore((store) =>
      handleMeshRequest({
        store,
        request,
        meshId: request.headers.get("x-pi-box-mesh") || "default",
        now: Date.now(),
        browser: Boolean(this.env.BROWSER),
        mintSecret: mintDeviceSecret,
        acceptWebSocket: (deviceId) => this.acceptDeviceSocket(deviceId),
      }),
    );
  }

  async alarm(): Promise<void> {
    await this.withStore(async (store) => {
      store.sweep(Date.now());
    });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
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
      await this.writePending(parsed.jobId, parsed.event || "message", parsed.data);
      return;
    }
    if (parsed.type === "ack" && parsed.jobId) {
      await this.withStore((store) => {
        store.ack({ jobId: parsed.jobId as string, deviceId, now: Date.now() });
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
    const planned = await this.withStore((store) =>
      planChatTurn(store, {
        sessionId,
        message: body.message,
        require: body.require,
        now: Date.now(),
        browser: Boolean(this.env.BROWSER),
        payload: { message: body.message, raw, sessionId },
      }),
    );
    const { job, decision } = planned;
    if (decision.wait) {
      return sseResponse(waitingSseBody(job), { runtime: "waiting" });
    }
    if (decision.fail || !decision.deviceId) {
      await this.withStore((store) => store.fail(job.id));
      return sseResponse(failSseBody("no_capacity"), { runtime: "none" });
    }
    if (decision.deviceId === "cloud") {
      const container = getContainer(this.env.PI_BOX, meshId);
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: raw,
      });
      const res = await container.fetch(forwarded);
      return this.tapCloud(res, job.id);
    }
    return this.dispatchDevice(job, decision.deviceId);
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

  private tapCloud(res: Response, jobId: string): Response {
    if (!res.body) {
      void this.withStore((store) => store.ack({ jobId, deviceId: "cloud", now: Date.now() }));
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

  private dispatchDevice(job: Job, deviceId: string): Response {
    const sockets = this.ctx.getWebSockets(deviceId);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();
    this.pending.set(job.id, { writer, encoder, deviceId });
    const runtimeName = deviceId;
    const intro =
      sseChunk("status", { state: "pi", runtime: runtimeName }) ;
    void writer.write(encoder.encode(intro));
    if (!sockets.length) {
      void (async () => {
        await this.withStore((store) => store.nack({ jobId: job.id, unsatisfied: [], now: Date.now() }));
        await writer.write(encoder.encode(failSseBody("device offline")));
        await writer.close();
        this.pending.delete(job.id);
      })();
      return sseResponse("", { runtime: runtimeName, stream: readable });
    }
    this.sendJob(deviceId, job);
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-pi-box-runtime": runtimeName,
        "x-pi-box-session": job.sessionId,
      },
    });
  }

  private sendJob(deviceId: string, job: Job) {
    const sockets = this.ctx.getWebSockets(deviceId);
    const wire = {
      type: "job",
      job: {
        id: job.id,
        sessionId: job.sessionId,
        require: job.require,
        payload: job.payload,
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

  private async withStore<T>(fn: (store: MeshStore) => Promise<T> | T): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const raw = await this.ctx.storage.get<MeshRecords>("mesh");
      const store = new MeshStore(raw || null);
      const result = await fn(store);
      await this.ctx.storage.put("mesh", store.snapshot());
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
