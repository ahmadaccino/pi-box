import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { verifyToken } from "@clerk/backend";
import {
  clearAuthCookie,
  mintAuthCookie,
  sanitizeSession,
  timingSafeEqual,
  verifyAuthCookie,
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
import { isDeviceTokenPath, isMeshDevicePath } from "./mesh-http";
import { parseMeshId } from "./mesh-state";

export { Mesh };

function isMeshChatPath(pathname: string): boolean {
  return (
    pathname === "/api/chat" ||
    pathname === "/api/boxes" ||
    pathname === "/api/skills"
  );
}

function browserBindingPresent(): boolean {
  return Boolean(env.BROWSER);
}

export class PiBox extends Container {
  defaultPort = 8788;
  sleepAfter = "2h";
  restored = false;
  envVars = {
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
  };

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

async function requireUser(request: Request, workerEnv: Env) {
  if (workerEnv.PI_BOX_PASSWORD) {
    const ok = await verifyAuthCookie(request, workerEnv.PI_BOX_PASSWORD);
    return ok ? { userId: "password" } : null;
  }
  if (!workerEnv.CLERK_SECRET_KEY) return { userId: "dev", skip: true };
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: workerEnv.CLERK_SECRET_KEY,
    });
    return { userId: String(payload.sub || "") };
  } catch {
    return null;
  }
}

function stableBoxId(user: { userId: string; skip?: boolean } | null): string {
  if (!user || user.skip || user.userId === "dev" || user.userId === "password") {
    return "default";
  }
  return sanitizeSession(user.userId);
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

function gatewayOk(request: Request, url: URL, workerEnv: Env): boolean {
  const token = workerEnv.GATEWAY_TOKEN;
  if (!token) return true;
  const given =
    url.searchParams.get("token") || request.headers.get("x-pi-box-token");
  return given === token;
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

    if (isMeshDevicePath(url.pathname) || isMeshChatPath(url.pathname)) {
      if (isDeviceTokenPath(url.pathname)) {
        const deviceId = request.headers.get("x-pi-box-device") || "";
        const meshId = parseMeshId(deviceId);
        if (!meshId) return new Response("Unauthorized", { status: 401 });
        const headers = new Headers(request.headers);
        headers.set("x-pi-box-actor", "device");
        headers.set("x-pi-box-mesh", meshId);
        return meshOf(workerEnv, meshId).fetch(new Request(request, { headers }));
      }
      const user = await requireUser(request, workerEnv);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (!gatewayOk(request, url, workerEnv)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const meshId = stableBoxId(user);
      const headers = new Headers(request.headers);
      headers.set("x-pi-box-actor", "user");
      headers.set("x-pi-box-mesh", meshId);
      return meshOf(workerEnv, meshId).fetch(new Request(request, { headers }));
    }

    if (url.pathname.startsWith("/api/")) {
      const user = await requireUser(request, workerEnv);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (!gatewayOk(request, url, workerEnv)) {
        return new Response("Unauthorized", { status: 401 });
      }
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

    if (url.pathname === "/vault") {
      return workerEnv.ASSETS.fetch(
        new Request(new URL("/vault.html" + url.search, request.url), request),
      );
    }

    if (url.pathname === "/plugins") {
      return workerEnv.ASSETS.fetch(
        new Request(new URL("/plugins.html" + url.search, request.url), request),
      );
    }

    return workerEnv.ASSETS.fetch(request);
  },
};
