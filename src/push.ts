/**
 * Web Push subscription storage and the notices a finished turn or waiting card sends.
 */

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  meshId?: string;
  createdAt: number;
};

export type PushNote = {
  title: string;
  body: string;
  tag: string;
};

const MAX_SUBS = 20;

export function upsertSubscription(
  list: PushSubscriptionRecord[] | null | undefined,
  input: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    expirationTime?: number | null;
    meshId?: string;
  },
  now = Date.now(),
): { ok: true; list: PushSubscriptionRecord[] } | { ok: false; error: string } {
  const endpoint = String(input?.endpoint || "");
  const p256dh = String(input?.keys?.p256dh || "");
  const auth = String(input?.keys?.auth || "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    return { ok: false, error: "invalid subscription" };
  }
  const current = Array.isArray(list) ? list : [];
  const next = current.filter((item) => item.endpoint !== endpoint);
  next.push({
    endpoint,
    keys: { p256dh, auth },
    expirationTime: input.expirationTime ?? null,
    meshId: input.meshId ? String(input.meshId) : "",
    createdAt: now,
  });
  return { ok: true, list: next.slice(-MAX_SUBS) };
}

export function listSubscriptions(
  list: PushSubscriptionRecord[] | null | undefined,
  meshId?: string,
): PushSubscriptionRecord[] {
  const current = Array.isArray(list) ? list : [];
  if (!meshId) return current.slice();
  return current.filter((item) => item.meshId === meshId);
}

export function removeSubscription(
  list: PushSubscriptionRecord[] | null | undefined,
  endpoint: string,
): PushSubscriptionRecord[] {
  return (Array.isArray(list) ? list : []).filter((item) => item.endpoint !== endpoint);
}

export function noticeFromAgentEvent(event: string, data: unknown): PushNote | null {
  const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (event === "done") {
    if (payload.waiting || payload.error) return null;
    return {
      title: "pi-box",
      body: payload.mock ? "Mock turn finished" : "Turn finished",
      tag: "turn-done",
    };
  }
  if (event !== "card") return null;
  const kind = String(payload.kind || payload.type || "");
  const id = String(payload.id || "");
  if (kind === "approval") {
    return {
      title: "Approval needed",
      body: String(payload.summary || "Waiting for you").slice(0, 180),
      tag: `approval-${id}`,
    };
  }
  if (kind === "draft") {
    return {
      title: "Ready to send",
      body: String(payload.subject || payload.body || "A draft is waiting").slice(0, 180),
      tag: `draft-${id}`,
    };
  }
  if (kind === "question") {
    return {
      title: "Question",
      body: String(payload.prompt || "A question is waiting").slice(0, 180),
      tag: `question-${id}`,
    };
  }
  return null;
}

export function noticesFromSseBlock(block: string): PushNote[] {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return [];
  try {
    const note = noticeFromAgentEvent(event, JSON.parse(data));
    return note ? [note] : [];
  } catch {
    return [];
  }
}
