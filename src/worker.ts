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

export class PiBox extends Container {
  defaultPort = 8788;
  sleepAfter = "10m";
  envVars = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    XAI_API_KEY: env.XAI_API_KEY ?? "",
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? "",
    PI_PROVIDER: env.PI_PROVIDER ?? "openrouter",
    PI_MODEL: env.PI_MODEL ?? "openrouter/z-ai/glm-5.3-flash",
    CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY ?? "",
    CLOUDFLARE_BROWSER: env.BROWSER ? "1" : "",
    PI_BOX_ID: "cloud",
    PI_BOX_NAME: "cloudflare",
    VAULT_ENCRYPTION_KEY: env.VAULT_ENCRYPTION_KEY ?? "",
  };
}

type Env = {
  PI_BOX: DurableObjectNamespace;
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
};

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
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

function sessionOf(request: Request, url: URL) {
  return sanitizeSession(
    url.searchParams.get("session") ||
      request.headers.get("x-pi-box-session"),
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

    if (url.pathname === "/healthz") {
      const session = sessionOf(request, url);
      try {
        const container = getContainer(workerEnv.PI_BOX, session);
        return container.fetch(request);
      } catch {
        return json({ ok: true, product: "pi-box", box: "starting" });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      const user = await requireUser(request, workerEnv);
      if (!user) return new Response("Unauthorized", { status: 401 });
      const token = workerEnv.GATEWAY_TOKEN;
      const given =
        url.searchParams.get("token") || request.headers.get("x-pi-box-token");
      if (token && given !== token) {
        return new Response("Unauthorized", { status: 401 });
      }
      const session = sessionOf(request, url);
      const container = getContainer(workerEnv.PI_BOX, session);
      return container.fetch(request);
    }

    if (url.pathname === "/vault") {
      return workerEnv.ASSETS.fetch(
        new Request(new URL("/vault.html" + url.search, request.url), request),
      );
    }

    return workerEnv.ASSETS.fetch(request);
  },
};
