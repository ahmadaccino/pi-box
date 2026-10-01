import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import {
  clearAuthCookie,
  mintAuthCookie,
  sanitizeSession,
  timingSafeEqual,
} from "./password";
import {
  clearNonceCookie,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleConfigured,
  mintCdpUrl,
  mintOAuthState,
  nonceCookie,
  oauthSecret,
  readCookie,
  redirectUri,
  verifyOAuthState,
  GOOGLE_PLUGINS,
} from "./oauth";
import { Mesh } from "./mesh";
import { isMeshDevicePath } from "./mesh-http";
import {
  decideAccess,
  isMeshChatPath,
  meshActor,
  requireUser,
  stableBoxId,
} from "./access";
import { containerInternalEnv } from "./internal-auth";
import { isRoutinesApiPath } from "./routines";
import { fetchPrettyAsset } from "./pretty-asset";

export { Mesh };

function browserBindingPresent(): boolean {
  return Boolean(env.BROWSER);
}

function boxName(id: { name?: string } | undefined): string {
  const name = id?.name || "";
  if (!name || name === "cf-singleton-container") return "default";
  return name;
}

/** Shared container env. Per-box internal token is applied in the constructor. */
function containerProcessEnv(boxId: string): Record<string, string> {
  const internal = containerInternalEnv(env, boxId);
  return {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    XAI_API_KEY: env.XAI_API_KEY ?? "",
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? "",
    PI_PROVIDER: env.PI_PROVIDER ?? "openrouter",
    PI_MODEL: env.PI_MODEL ?? "openrouter/z-ai/glm-5.3-flash",
    CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY ?? "",
    CLOUDFLARE_BROWSER: browserBindingPresent() ? "1" : "",
    BROWSER_CDP_URL: mintCdpUrl(env),
    BROWSER_CDP_TOKEN: env.CLOUDFLARE_API_TOKEN ?? "",
    GATEWAY_TOKEN: env.GATEWAY_TOKEN ?? "",
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? "",
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? "",
    PI_BOX_PUBLIC_URL: env.PI_BOX_PUBLIC_URL ?? "",
    PI_BOX_ID: "cloud",
    PI_BOX_NAME: "cloudflare",
    VAULT_ENCRYPTION_KEY: env.VAULT_ENCRYPTION_KEY ?? "",
    PI_BOX_MESH_ID: internal.PI_BOX_MESH_ID,
    PI_BOX_INTERNAL_TOKEN: internal.PI_BOX_INTERNAL_TOKEN,
  };
}

export class PiBox extends Container {
  defaultPort = 8788;
  sleepAfter = "2h";
  restored = false;

  // Sidecar needs these in its own process. Pi bash strips secrets
  // (container/shell-env.mjs). server startup deletes VAULT_ENCRYPTION_KEY
  // from process.env after reading it. PI_BOX_INTERNAL_TOKEN is the per-box
  // HMAC for skill proxies; it is stripped from bash the same way.
  constructor(ctx: { id: { name?: string } }, envArg: unknown) {
    super(ctx as never, envArg as never);
    const boxId = boxName(ctx?.id);
    Object.defineProperty(this, "envVars", {
      configurable: true,
      enumerable: true,
      get: () => containerProcessEnv(boxId),
    });
  }

  override onStart() {
    this.restored = false;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureRestored();
    const res = await super.fetch(request);
    if (shouldPersist(request)) {
      await this.persistSnapshot();
    }
    return res;
  }

  private internalHeaders(): HeadersInit {
    const token = env.GATEWAY_TOKEN || "";
    return token ? { "x-pi-box-internal": token } : {};
  }

  private async ensureRestored() {
    if (this.restored) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.restored) return;
      this.restored = true;
      const raw = await this.ctx.storage.get<string>("snapshot");
      if (!raw) return;
      try {
        await super.fetch(
          new Request("http://sidecar/internal/snapshot", {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              ...this.internalHeaders(),
            },
            body: raw,
          }),
        );
      } catch {
        this.restored = false;
      }
    });
  }

  private async persistSnapshot() {
    try {
      const res = await super.fetch(
        new Request("http://sidecar/internal/snapshot", {
          headers: this.internalHeaders(),
        }),
      );
      if (!res.ok) return;
      const body = await res.text();
      await this.ctx.storage.put("snapshot", body);
    } catch {
      /* next request can retry */
    }
  }
}

type Env = {
  PI_BOX: DurableObjectNamespace;
  MESH: DurableObjectNamespace;
  STATE?: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  PI_PROVIDER?: string;
  PI_MODEL?: string;
  GATEWAY_TOKEN?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  PI_BOX_PASSWORD?: string;
  VAULT_ENCRYPTION_KEY?: string;
  INTERNAL_API_SECRET?: string;
  BROWSER?: unknown;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PI_BOX_PUBLIC_URL?: string;
};

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function shouldPersist(request: Request): boolean {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return false;
  return (
    url.pathname.startsWith("/api/vault") ||
    url.pathname === "/api/chat" ||
    url.pathname.startsWith("/api/plugins")
  );
}

function sessionOf(request: Request, url: URL) {
  return sanitizeSession(
    url.searchParams.get("session") ||
      request.headers.get("x-pi-box-session"),
  );
}

function boxOf(workerEnv: Env, user: { userId: string; skip?: boolean } | null) {
  return getContainer(workerEnv.PI_BOX, stableBoxId(user));
}

function meshOf(workerEnv: Env, meshId: string) {
  return workerEnv.MESH.get(workerEnv.MESH.idFromName(meshId));
}

function forwardToMesh(request: Request, workerEnv: Env, access: { kind: string; meshId: string }) {
  const headers = new Headers(request.headers);
  headers.set("x-pi-box-actor", meshActor(access));
  headers.set("x-pi-box-mesh", access.meshId);
  return meshOf(workerEnv, access.meshId).fetch(new Request(request, { headers }));
}

async function upsertGoogleTokens(
  workerEnv: Env,
  userId: string,
  tokens: { access_token: string; refresh_token: string; expires_at: number },
) {
  const container = getContainer(workerEnv.PI_BOX, sanitizeSession(userId) || "default");
  const body = JSON.stringify({
    plugins: [...GOOGLE_PLUGINS],
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: tokens.expires_at,
    account: { provider: "google" },
  });
  const headers: HeadersInit = {
    "content-type": "application/json",
    "x-pi-box-session": "oauth",
  };
  if (workerEnv.GATEWAY_TOKEN) {
    headers["x-pi-box-token"] = workerEnv.GATEWAY_TOKEN;
  }
  return container.fetch(
    new Request("http://sidecar/api/vault/oauth-token", {
      method: "POST",
      headers,
      body,
    }),
  );
}

export default {
  async fetch(request: Request, workerEnv: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      return json({
        clerkPublishableKey: workerEnv.CLERK_PUBLISHABLE_KEY || "",
        authRequired: Boolean(workerEnv.CLERK_SECRET_KEY),
        passwordRequired: Boolean(workerEnv.PI_BOX_PASSWORD),
        googleOAuth: googleConfigured(workerEnv),
      });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!workerEnv.PI_BOX_PASSWORD) {
        return json({ ok: true, skipped: true });
      }
      let body: { password?: string } = {};
      try {
        body = (await request.json()) as { password?: string };
      } catch {
        return json({ error: "invalid json" }, { status: 400 });
      }
      if (!timingSafeEqual(String(body.password || ""), workerEnv.PI_BOX_PASSWORD)) {
        return json({ error: "invalid password" }, { status: 401 });
      }
      return json(
        { ok: true },
        {
          headers: {
            "set-cookie": await mintAuthCookie(workerEnv.PI_BOX_PASSWORD, request),
          },
        },
      );
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json(
        { ok: true },
        { headers: { "set-cookie": clearAuthCookie(request) } },
      );
    }

    if (url.pathname === "/api/oauth/google/start" && request.method === "GET") {
      const user = await requireUser(request, workerEnv);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (!googleConfigured(workerEnv)) {
        return json({ error: "google oauth unset" }, { status: 503 });
      }
      const plugin = url.searchParams.get("plugin") || "gmail";
      if (!GOOGLE_PLUGINS.includes(plugin as (typeof GOOGLE_PLUGINS)[number])) {
        return json({ error: "plugin must be gmail or google-calendar" }, { status: 400 });
      }
      const minted = await mintOAuthState({
        plugin,
        userId: stableBoxId(user),
        secret: oauthSecret(workerEnv),
      });
      const loc = googleAuthorizeUrl({
        clientId: workerEnv.GOOGLE_CLIENT_ID || "",
        redirect: redirectUri(request.url),
        state: minted.state,
      });
      return new Response(null, {
        status: 302,
        headers: {
          location: loc,
          "set-cookie": nonceCookie(request, minted.nonce),
        },
      });
    }

    if (url.pathname === "/api/oauth/google/callback" && request.method === "GET") {
      if (!googleConfigured(workerEnv)) {
        return json({ error: "google oauth unset" }, { status: 503 });
      }
      const nonce = readCookie(request, "pi_box_oauth_nonce");
      const checked = await verifyOAuthState({
        state: url.searchParams.get("state"),
        nonce,
        secret: oauthSecret(workerEnv),
      });
      if (!checked) {
        return json(
          { error: "invalid oauth state" },
          { status: 400, headers: { "set-cookie": clearNonceCookie(request) } },
        );
      }
      const code = url.searchParams.get("code");
      if (!code) return json({ error: "missing code" }, { status: 400 });
      try {
        const tokens = await exchangeGoogleCode({
          code,
          redirect: redirectUri(request.url),
          clientId: workerEnv.GOOGLE_CLIENT_ID || "",
          clientSecret: workerEnv.GOOGLE_CLIENT_SECRET || "",
        });
        const up = await upsertGoogleTokens(
          workerEnv,
          checked.userId === "default" ? "default" : checked.userId,
          tokens,
        );
        if (!up.ok) {
          return json({ error: "vault upsert failed" }, { status: 502 });
        }
        return new Response(null, {
          status: 302,
          headers: {
            location: "/plugins?google=connected",
            "set-cookie": clearNonceCookie(request),
          },
        });
      } catch {
        return json({ error: "token exchange failed" }, { status: 502 });
      }
    }

    if (url.pathname === "/healthz") {
      try {
        const user = await requireUser(request, workerEnv);
        const container = boxOf(workerEnv, user);
        return container.fetch(request);
      } catch {
        return json({ ok: true, product: "pi-box", box: "starting" });
      }
    }

    if (
      isRoutinesApiPath(url.pathname) ||
      isMeshDevicePath(url.pathname) ||
      isMeshChatPath(url.pathname)
    ) {
      const access = await decideAccess(request, workerEnv);
      if (!access.ok) return new Response("Unauthorized", { status: 401 });
      return forwardToMesh(request, workerEnv, access);
    }

    if (url.pathname.startsWith("/api/")) {
      const access = await decideAccess(request, workerEnv);
      if (!access.ok || access.kind !== "user" || !access.user) {
        return new Response("Unauthorized", { status: 401 });
      }
      const user = access.user;
      const authPlugin = url.pathname.match(
        /^\/api\/plugins\/([^/]+)\/authenticate$/,
      );
      if (
        authPlugin &&
        request.method === "POST" &&
        googleConfigured(workerEnv) &&
        GOOGLE_PLUGINS.includes(authPlugin[1] as (typeof GOOGLE_PLUGINS)[number])
      ) {
        const minted = await mintOAuthState({
          plugin: authPlugin[1],
          userId: stableBoxId(user),
          secret: oauthSecret(workerEnv),
        });
        return json(
          {
            url: googleAuthorizeUrl({
              clientId: workerEnv.GOOGLE_CLIENT_ID || "",
              redirect: redirectUri(request.url),
              state: minted.state,
            }),
          },
          { headers: { "set-cookie": nonceCookie(request, minted.nonce) } },
        );
      }
      sessionOf(request, url);
      const container = boxOf(workerEnv, user);
      return container.fetch(request);
    }

    const prettyPage = await fetchPrettyAsset(workerEnv.ASSETS, request);
    if (prettyPage) return prettyPage;

    return workerEnv.ASSETS.fetch(request);
  },
};
