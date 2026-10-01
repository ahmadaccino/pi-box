/**
 * Credential for container-to-Worker calls (routines skill proxy and any later
 * skill proxy that calls back into the Worker).
 *
 * The Worker mints a per-box HMAC and injects only that token into the sidecar.
 * It is not GATEWAY_TOKEN: setting GATEWAY_TOKEN would be required on every
 * /api request and would also change OAuth state signing when
 * GOOGLE_CLIENT_SECRET is unset.
 *
 * Key material, first match wins:
 *   INTERNAL_API_SECRET (optional dedicated secret)
 *   VAULT_ENCRYPTION_KEY (domain-separated)
 *   PI_BOX_PASSWORD (domain-separated)
 *   CLERK_SECRET_KEY (domain-separated)
 * No new secret is required when one of those is already set.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { sanitizeSession } from "./password.ts";

export const INTERNAL_TOKEN_ENV = "PI_BOX_INTERNAL_TOKEN";
const DOMAIN = "pi-box-internal-api-v1";

/** Paths the in-box agent may call on the Worker with the internal token. */
export const INTERNAL_PROXY_PREFIXES = ["/api/routines"] as const;

export type InternalAuthEnv = {
  INTERNAL_API_SECRET?: string;
  VAULT_ENCRYPTION_KEY?: string;
  PI_BOX_PASSWORD?: string;
  CLERK_SECRET_KEY?: string;
  GATEWAY_TOKEN?: string;
};

export function isInternalProxyPath(pathname: string): boolean {
  return INTERNAL_PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** HMAC key for internal tokens. Empty when the box has no secret to derive from. */
export function internalAuthSecret(env: InternalAuthEnv): string {
  const explicit = String(env.INTERNAL_API_SECRET || "").trim();
  if (explicit) return explicit;
  const vault = String(env.VAULT_ENCRYPTION_KEY || "").trim();
  if (vault) return hmacHex(vault, DOMAIN);
  const password = String(env.PI_BOX_PASSWORD || "").trim();
  if (password) return hmacHex(password, DOMAIN);
  const clerk = String(env.CLERK_SECRET_KEY || "").trim();
  if (clerk) return hmacHex(clerk, DOMAIN);
  return "";
}

export function mintInternalToken(secret: string, boxId: string): string {
  if (!secret) return "";
  return hmacHex(secret, `v1|${sanitizeSession(boxId)}`);
}

export function verifyInternalToken(secret: string, boxId: string, given: string): boolean {
  if (!secret || !given) return false;
  return safeEqual(mintInternalToken(secret, boxId), given);
}

/** Env entries injected into one container instance. The raw secret is not included. */
export function containerInternalEnv(
  env: InternalAuthEnv,
  boxId: string,
): { PI_BOX_MESH_ID: string; PI_BOX_INTERNAL_TOKEN: string } {
  const meshId = sanitizeSession(boxId);
  const secret = internalAuthSecret(env);
  return {
    PI_BOX_MESH_ID: meshId,
    PI_BOX_INTERNAL_TOKEN: secret ? mintInternalToken(secret, meshId) : "",
  };
}

/**
 * Sidecar presented x-pi-box-sidecar and x-pi-box-internal.
 * The internal token must match this mesh. A legacy GATEWAY_TOKEN match is
 * still accepted so an already-configured gateway keeps working on these routes.
 * Fully open local dev (no secret, no password, no Clerk) stays open.
 */
export function sidecarCredentialOk(
  request: Request,
  env: InternalAuthEnv,
  meshId: string,
): boolean {
  const given = request.headers.get("x-pi-box-internal") || "";
  const secret = internalAuthSecret(env);
  if (secret && verifyInternalToken(secret, meshId, given)) return true;
  const gateway = String(env.GATEWAY_TOKEN || "").trim();
  if (gateway && given && safeEqual(given, gateway)) return true;
  return !secret && !gateway && !String(env.PI_BOX_PASSWORD || "").trim() && !String(env.CLERK_SECRET_KEY || "").trim();
}
