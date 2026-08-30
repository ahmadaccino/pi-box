import { jobFallback } from "./caps.ts";
import { MeshStore } from "./mesh-state.ts";
import { place, type Job, type PlaceResult } from "./place.ts";

export type ChatTurnInput = {
  sessionId: string;
  message?: string;
  require?: string[];
  prefer?: string[];
  affinity?: string | null;
  now: number;
  browser?: boolean;
  jobId?: string;
  payload?: unknown;
};

export function planChatTurn(
  store: MeshStore,
  input: ChatTurnInput,
): { job: Job; decision: PlaceResult } {
  const require = [...(input.require || [])];
  const job = store.enqueue({
    id: input.jobId || `job_${input.now}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    require,
    prefer: input.prefer || [],
    affinity: input.affinity,
    fallback: jobFallback(require),
    payload: input.payload ?? { message: input.message || "" },
    now: input.now,
  });
  const cloud = store.cloudDevice(input.now, input.browser !== false);
  const decision = place(job, store.listDevices(), cloud, input.now);
  if (decision.deviceId) {
    store.tryLease({ jobId: job.id, deviceId: decision.deviceId, now: input.now });
  }
  return { job: store.getJob(job.id) || job, decision };
}

export function waitingCopy(require: string[]): string {
  if (require.includes("ios") || require.includes("ios-simulator")) {
    return "Waiting for a Mac with iOS simulator.";
  }
  if (require.includes("android")) {
    return "Waiting for a device with Android.";
  }
  if (require.includes("cuda") || require.includes("gpu=nvidia")) {
    return "Waiting for a machine with an NVIDIA GPU.";
  }
  return "Waiting for a matching machine.";
}

export function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function waitingSseBody(job: Job): string {
  return (
    sseChunk("status", {
      state: "waiting",
      missing: job.require,
      message: waitingCopy(job.require),
      runtime: null,
    }) + sseChunk("done", { waiting: true })
  );
}

export function failSseBody(message: string): string {
  return sseChunk("error", { message }) + sseChunk("done", { error: true });
}
