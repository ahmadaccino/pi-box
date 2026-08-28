import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class PiBox extends Container {
  defaultPort = 8788;
  sleepAfter = "10m";
  envVars = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    XAI_API_KEY: env.XAI_API_KEY ?? "",
  };
}

type Env = {
  PI_BOX: DurableObjectNamespace;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  GATEWAY_TOKEN?: string;
};

export default {
  async fetch(request: Request, workerEnv: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, product: "pi-box" });
    }

    if (url.pathname.startsWith("/api/")) {
      const token = workerEnv.GATEWAY_TOKEN;
      const given =
        url.searchParams.get("token") || request.headers.get("x-pi-box-token");
      if (token && given !== token) {
        return new Response("Unauthorized", { status: 401 });
      }
      const session =
        url.searchParams.get("session") ||
        request.headers.get("x-pi-box-session") ||
        "default";
      const container = getContainer(workerEnv.PI_BOX, session);
      return container.fetch(request);
    }

    return workerEnv.ASSETS.fetch(request);
  },
};
