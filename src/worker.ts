import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { verifyToken } from "@clerk/backend";

export class PiBox extends Container {
  defaultPort = 8788;
  sleepAfter = "10m";
  envVars = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    XAI_API_KEY: env.XAI_API_KEY ?? "",
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
  GATEWAY_TOKEN?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  VAULT_ENCRYPTION_KEY?: string;
  BROWSER?: unknown;
};

async function requireUser(request: Request, workerEnv: Env) {
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

export default {
  async fetch(request: Request, workerEnv: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      return Response.json({
        clerkPublishableKey: workerEnv.CLERK_PUBLISHABLE_KEY || "",
        authRequired: Boolean(workerEnv.CLERK_SECRET_KEY),
      });
    }

    if (url.pathname === "/healthz") {
      const session = url.searchParams.get("session") || "cloud";
      try {
        const container = getContainer(workerEnv.PI_BOX, session);
        return container.fetch(request);
      } catch {
        return Response.json({ ok: true, product: "pi-box", box: "starting" });
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
      const session =
        url.searchParams.get("session") ||
        request.headers.get("x-pi-box-session") ||
        "cloud";
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
