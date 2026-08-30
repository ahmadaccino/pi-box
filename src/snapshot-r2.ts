import type { MeshStore, SnapshotPointer } from "./mesh-state.ts";

export function snapshotKey(meshId: string, sessionId: string): string {
  return `sessions/${meshId}/${sessionId}/snapshot.json`;
}

export async function putSnapshotBlob(
  bucket: R2Bucket | undefined,
  store: MeshStore,
  meshId: string,
  sessionId: string,
  body: ArrayBuffer | string,
  now = Date.now(),
): Promise<SnapshotPointer | null> {
  if (!bucket) return null;
  const r2Key = snapshotKey(meshId, sessionId);
  const put = await bucket.put(r2Key, body);
  const pointer: SnapshotPointer = {
    sessionId,
    r2Key,
    etag: put?.etag || "",
    updatedAt: now,
  };
  store.putPointer(pointer);
  return pointer;
}

export async function getSnapshotBlob(
  bucket: R2Bucket | undefined,
  store: MeshStore,
  sessionId: string,
): Promise<{ ok: true; body: ArrayBuffer; pointer: SnapshotPointer } | { ok: false; reason: string }> {
  const pointer = store.getPointer(sessionId);
  if (!pointer) return { ok: false, reason: "no_pointer" };
  if (!bucket) return { ok: false, reason: "r2_unavailable" };
  const obj = await bucket.get(pointer.r2Key);
  if (!obj) return { ok: false, reason: "missing_object" };
  return { ok: true, body: await obj.arrayBuffer(), pointer };
}
