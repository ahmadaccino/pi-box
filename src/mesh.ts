import { DurableObject } from "cloudflare:workers";
import { DEAD_AFTER_MS, HEARTBEAT_MS } from "./caps.ts";
import { handleMeshRequest, mintDeviceSecret } from "./mesh-http.ts";
import { MeshStore, type MeshRecords } from "./mesh-state.ts";

export type MeshEnv = {
  MESH: DurableObjectNamespace;
  PI_BOX: DurableObjectNamespace;
  STATE?: R2Bucket;
  BROWSER?: unknown;
  OPENROUTER_API_KEY?: string;
  GATEWAY_TOKEN?: string;
};

export class Mesh extends DurableObject<MeshEnv> {
  async fetch(request: Request): Promise<Response> {
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
    let parsed: { type?: string } = {};
    try {
      parsed = JSON.parse(String(message)) as { type?: string };
    } catch {
      return;
    }
    if (parsed.type === "heartbeat") {
      await this.withStore((store) => {
        const device = store.get(deviceId);
        if (device) device.lastSeen = Date.now();
        return Promise.resolve();
      });
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
      return Promise.resolve();
    });
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
