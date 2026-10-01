/**
 * Worker request gate. Browser sessions (password cookie or Clerk) satisfy
 * GATEWAY_TOKEN so the web UI keeps working if that secret is set later.
 * The container internal token is accepted only on skill-proxy routes.
 */
import { verifyToken } from "@clerk/backend";
import { isDeviceTokenPath, isMeshDevicePath } from "./mesh-http.ts";
import { parseMeshId } from "./mesh-state.ts";
import {
  isInternalProxyPath,
  safeEqual,
  sidecarCredentialOk,
  type InternalAuthEnv,
} from "./internal-auth.ts";
import { sanitizeSession, verifyAuthCookie } from "./password.ts";
import { isRoutinesApiPath, routineWebhookMeshId } from "./routines.ts";

export type AccessEnv = InternalAuthEnv & {
  CLERK_SECRET_KEY?: string;
  PI_BOX_PASSWORD?: string;
  GATEWAY_TOKEN?: string;
};

export type AuthedUser = {
  userId: string;
  skip?: boolean;
  session?: "password" | "clerk";
};

export type AccessDecision =
  | { ok: false }
  | {
      ok: true;
      kind: "webhook" | "device" | "sidecar" | "user";
      meshId: string;
      user: AuthedUser | null;
    };

type ClerkVerifier = (
  token: string,
  opts: { secretKey: string },
) => Promise<{ sub?: string }>;

async function defaultVerifyClerk(token: string, opts: { secretKey: string }) {
  const payload = await verifyToken(token, opts);
  return { sub: payload.sub ? String(payload.sub) : "" };
}

export function isMeshChatPath(pathname: string): boolean {
  return (
    pathname === "/api/chat" ||
    pathname === "/api/boxes" ||
    pathname === "/api/skills" ||
    /^\/api\/sessions\/[^/]+\/snapshot$/.test(pathname)
  );
}

export function stableBoxId(user: { userId: string; skip?: boolean } | null): string {
  if (!user || user.skip || user.userId === "dev" || user.userId === "password") {
    return "default";
  }
  return sanitizeSession(user.userId);
}

export async function requireUser(
  request: Request,
  env: AccessEnv,
  verifyClerk: ClerkVerifier = defaultVerifyClerk,
): Promise<AuthedUser | null> {
  if (env.PI_BOX_PASSWORD) {
    const ok = await verifyAuthCookie(request, env.PI_BOX_PASSWORD);
    return ok ? { userId: "password", session: "password" } : null;
  }
  if (!env.CLERK_SECRET_KEY) return { userId: "dev", skip: true };
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const payload = await verifyClerk(token, { secretKey: env.CLERK_SECRET_KEY });
    const userId = String(payload.sub || "");
    if (!userId) return null;
    return { userId, session: "clerk" };
  } catch {
    return null;
  }
}

/**
 * GATEWAY_TOKEN is an extra gate for callers that have not already presented
 * a password cookie or a Clerk session. A logged-in browser does not send
 * the token; requiring it there locks the whole UI.
 */
export function gatewayOk(
  request: Request,
  url: URL,
  env: AccessEnv,
  user?: AuthedUser | null,
): boolean {
  const token = String(env.GATEWAY_TOKEN || "");
  if (!token) return true;
  if (user?.session === "password" || user?.session === "clerk") return true;
  const given = url.searchParams.get("token") || request.headers.get("x-pi-box-token") || "";
  return safeEqual(given, token);
}

function userDecision(user: AuthedUser): AccessDecision {
  return { ok: true, kind: "user", meshId: stableBoxId(user), user };
}

export async function decideAccess(request: Request, env: AccessEnv): Promise<AccessDecision> {
  const url = new URL(request.url);
  const path = url.pathname;

  // The internal token is a sidecar credential, not a browser session.
  if (request.headers.get("x-pi-box-sidecar") === "1") {
    if (!isInternalProxyPath(path)) return { ok: false };
    const meshId = sanitizeSession(request.headers.get("x-pi-box-mesh"));
    if (!sidecarCredentialOk(request, env, meshId)) return { ok: false };
    return { ok: true, kind: "sidecar", meshId, user: null };
  }

  if (isRoutinesApiPath(path)) {
    const webhookMesh = request.method === "POST" ? routineWebhookMeshId(path) : null;
    if (webhookMesh) return { ok: true, kind: "webhook", meshId: webhookMesh, user: null };

    const deviceId = request.headers.get("x-pi-box-device") || "";
    if (deviceId) {
      const meshId = parseMeshId(deviceId);
      if (!meshId) return { ok: false };
      return { ok: true, kind: "device", meshId, user: null };
    }

    const user = await requireUser(request, env);
    if (!user) return { ok: false };
    if (!gatewayOk(request, url, env, user)) return { ok: false };
    return userDecision(user);
  }

  if (isMeshDevicePath(path) || isMeshChatPath(path)) {
    const deviceHeader = request.headers.get("x-pi-box-device") || "";
    if (isDeviceTokenPath(path) || (deviceHeader && path.includes("/snapshot"))) {
      const deviceId = request.headers.get("x-pi-box-device") || "";
      const meshId = parseMeshId(deviceId);
      if (!meshId) return { ok: false };
      return { ok: true, kind: "device", meshId, user: null };
    }
    const user = await requireUser(request, env);
    if (!user) return { ok: false };
    if (!gatewayOk(request, url, env, user)) return { ok: false };
    return userDecision(user);
  }

  if (path.startsWith("/api/")) {
    const user = await requireUser(request, env);
    if (!user) return { ok: false };
    if (!gatewayOk(request, url, env, user)) return { ok: false };
    return userDecision(user);
  }

  return { ok: false };
}

export function meshActor(decision: { kind: string }): string {
  if (decision.kind === "webhook") return "webhook";
  if (decision.kind === "device") return "device";
  return "user";
}
