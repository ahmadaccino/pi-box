#!/usr/bin/env node
/**
 * Container-to-Worker internal token:
 * - accepted on the routines API
 * - rejected on other APIs
 * - absent from bash `env`
 * - a password or Clerk web session still works when GATEWAY_TOKEN is set
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideAccess, gatewayOk, requireUser } from "../src/access.ts";
import {
  containerInternalEnv,
  mintInternalToken,
  internalAuthSecret,
} from "../src/internal-auth.ts";
import { oauthSecret } from "../src/oauth.ts";
import { mintAuthCookie } from "../src/password.ts";
import {
  rememberRoutinesRoute,
  routinesUpstreamHeaders,
  sealInternalTokenFromEnv,
} from "../container/routines-proxy.mjs";
import { executeBashTool, SECRET_ENV_NAMES } from "../container/shell-env.mjs";

const password = "box-password-d4f1";
const vault = "vault-key-material-d4f1";
const gateway = "gateway-secret-d4f1";
const live = {
  PI_BOX_PASSWORD: password,
  VAULT_ENCRYPTION_KEY: vault,
};

function routinesRequest(token, meshId = "default", path = "/api/routines") {
  return new Request(`https://box.example${path}`, {
    headers: {
      "x-pi-box-sidecar": "1",
      "x-pi-box-mesh": meshId,
      "x-pi-box-internal": token,
    },
  });
}

async function cookieHeader() {
  const setCookie = await mintAuthCookie(password, new Request("https://box.example/api/login"));
  return setCookie.split(";")[0];
}

const injected = containerInternalEnv(live, "default");
assert.ok(injected.PI_BOX_INTERNAL_TOKEN);
assert.notEqual(injected.PI_BOX_INTERNAL_TOKEN, vault);
assert.notEqual(injected.PI_BOX_INTERNAL_TOKEN, password);
assert.equal(injected.PI_BOX_MESH_ID, "default");

{
  const access = await decideAccess(routinesRequest(injected.PI_BOX_INTERNAL_TOKEN), live);
  assert.equal(access.ok, true);
  assert.equal(access.kind, "sidecar");
  assert.equal(access.meshId, "default");
}

{
  const missing = await decideAccess(
    new Request("https://box.example/api/routines", {
      headers: { "x-pi-box-sidecar": "1", "x-pi-box-mesh": "default" },
    }),
    live,
  );
  assert.equal(missing.ok, false);
}

{
  const otherBox = containerInternalEnv(live, "user_abc");
  const wrongMesh = await decideAccess(
    routinesRequest(otherBox.PI_BOX_INTERNAL_TOKEN, "default"),
    live,
  );
  assert.equal(wrongMesh.ok, false);
  const ownMesh = await decideAccess(
    routinesRequest(otherBox.PI_BOX_INTERNAL_TOKEN, "user_abc"),
    live,
  );
  assert.equal(ownMesh.ok, true);
  assert.equal(ownMesh.meshId, "user_abc");
}

for (const path of ["/api/chat", "/api/boxes", "/api/skills", "/api/vault", "/api/plugins"]) {
  const rejected = await decideAccess(
    routinesRequest(injected.PI_BOX_INTERNAL_TOKEN, "default", path),
    live,
  );
  assert.equal(rejected.ok, false, `${path} must reject the internal token`);
}

{
  const asGateway = await decideAccess(
    new Request("https://box.example/api/chat", {
      headers: { "x-pi-box-token": injected.PI_BOX_INTERNAL_TOKEN },
    }),
    live,
  );
  assert.equal(asGateway.ok, false);
}

{
  const passwordOnly = { PI_BOX_PASSWORD: password };
  const token = containerInternalEnv(passwordOnly, "default").PI_BOX_INTERNAL_TOKEN;
  const access = await decideAccess(routinesRequest(token), passwordOnly);
  assert.equal(access.ok, true);
  const vaultWins = await decideAccess(routinesRequest(token), live);
  assert.equal(vaultWins.ok, false, "vault-derived key must win over the password");
}

{
  const dedicated = { ...live, INTERNAL_API_SECRET: "dedicated-internal-d4f1" };
  const fromVault = injected.PI_BOX_INTERNAL_TOKEN;
  const fromSecret = containerInternalEnv(dedicated, "default").PI_BOX_INTERNAL_TOKEN;
  assert.notEqual(fromSecret, fromVault);
  assert.equal((await decideAccess(routinesRequest(fromSecret), dedicated)).ok, true);
  assert.equal((await decideAccess(routinesRequest(fromVault), dedicated)).ok, false);
  assert.equal(internalAuthSecret(dedicated), "dedicated-internal-d4f1");
}

{
  const headers = routinesUpstreamHeaders({
    PI_BOX_MESH_ID: "default",
    PI_BOX_INTERNAL_TOKEN: injected.PI_BOX_INTERNAL_TOKEN,
    GATEWAY_TOKEN: gateway,
  });
  assert.equal(headers.get("x-pi-box-sidecar"), "1");
  assert.equal(headers.get("x-pi-box-mesh"), "default");
  assert.equal(headers.get("x-pi-box-internal"), injected.PI_BOX_INTERNAL_TOKEN);
  const legacy = routinesUpstreamHeaders({ PI_BOX_MESH_ID: "default", GATEWAY_TOKEN: gateway });
  assert.equal(legacy.get("x-pi-box-internal"), gateway);
}

{
  const previous = process.env.PI_BOX_MESH_ID;
  process.env.PI_BOX_MESH_ID = "default";
  rememberRoutinesRoute({ headers: { "x-pi-box-mesh": "other-box" } });
  assert.equal(process.env.PI_BOX_MESH_ID, "default");
  if (previous == null) delete process.env.PI_BOX_MESH_ID;
  else process.env.PI_BOX_MESH_ID = previous;
}

{
  const gated = { ...live, GATEWAY_TOKEN: gateway };
  const cookie = await cookieHeader();
  for (const path of ["/api/routines", "/api/boxes", "/api/chat", "/api/vault"]) {
    const web = await decideAccess(
      new Request(`https://box.example${path}`, { headers: { cookie } }),
      gated,
    );
    assert.equal(web.ok, true, `${path} web session must work with GATEWAY_TOKEN set`);
    assert.equal(web.kind, "user");
  }
  const anonymous = await decideAccess(new Request("https://box.example/api/routines"), gated);
  assert.equal(anonymous.ok, false);
}

{
  const clerkEnv = { CLERK_SECRET_KEY: "sk_test", GATEWAY_TOKEN: gateway };
  const clerkRequest = new Request("https://box.example/api/boxes", {
    headers: { authorization: "Bearer clerk-session" },
  });
  const user = await requireUser(clerkRequest, clerkEnv, async () => ({ sub: "user_abc" }));
  assert.equal(user?.session, "clerk");
  assert.equal(user?.userId, "user_abc");
  assert.equal(gatewayOk(clerkRequest, new URL(clerkRequest.url), clerkEnv, user), true);
  assert.equal(
    gatewayOk(new Request("https://box.example/api/boxes"), new URL("https://box.example/api/boxes"), clerkEnv, {
      userId: "dev",
      skip: true,
    }),
    false,
  );
}

{
  const openGateway = { GATEWAY_TOKEN: gateway };
  const noSession = await decideAccess(new Request("https://box.example/api/boxes"), openGateway);
  assert.equal(noSession.ok, false);
  const withToken = await decideAccess(
    new Request("https://box.example/api/boxes", { headers: { "x-pi-box-token": gateway } }),
    openGateway,
  );
  assert.equal(withToken.ok, true);
}

{
  const hook = await decideAccess(
    new Request("https://box.example/api/routines/rt.default.abc123/webhook", { method: "POST" }),
    live,
  );
  assert.equal(hook.ok, true);
  assert.equal(hook.kind, "webhook");
  const device = await decideAccess(
    new Request("https://box.example/api/routines", {
      headers: { "x-pi-box-device": "d_default_11111111-1111-1111-1111-111111111111" },
    }),
    live,
  );
  assert.equal(device.ok, true);
  assert.equal(device.kind, "device");
}

{
  assert.equal(
    oauthSecret({ GATEWAY_TOKEN: gateway, PI_BOX_PASSWORD: password }),
    gateway,
  );
  assert.notEqual(mintInternalToken(internalAuthSecret(live), "default"), gateway);
}

{
  assert.ok(SECRET_ENV_NAMES.includes("PI_BOX_INTERNAL_TOKEN"));
  assert.ok(SECRET_ENV_NAMES.includes("INTERNAL_API_SECRET"));
  const ran = await executeBashTool("env", {
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      PI_BOX_VISIBLE: "kept-visible-d4f1",
      PI_BOX_INTERNAL_TOKEN: injected.PI_BOX_INTERNAL_TOKEN,
      INTERNAL_API_SECRET: "dedicated-internal-d4f1",
    },
  });
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /PI_BOX_VISIBLE=kept-visible-d4f1/);
  assert.equal(ran.env.PI_BOX_INTERNAL_TOKEN, undefined);
  assert.equal(ran.env.INTERNAL_API_SECRET, undefined);
  assert.ok(!ran.stdout.includes("PI_BOX_INTERNAL_TOKEN"));
  assert.ok(!ran.stdout.includes(injected.PI_BOX_INTERNAL_TOKEN));
  assert.ok(!ran.stdout.includes("INTERNAL_API_SECRET"));
  assert.ok(!ran.stdout.includes("dedicated-internal-d4f1"));
}

{
  const previousToken = process.env.PI_BOX_INTERNAL_TOKEN;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  process.env.PI_BOX_INTERNAL_TOKEN = injected.PI_BOX_INTERNAL_TOKEN;
  process.env.INTERNAL_API_SECRET = "dedicated-internal-d4f1";
  sealInternalTokenFromEnv();
  assert.equal(process.env.PI_BOX_INTERNAL_TOKEN, undefined);
  assert.equal(process.env.INTERNAL_API_SECRET, undefined);
  const sealed = routinesUpstreamHeaders(process.env);
  assert.equal(sealed.get("x-pi-box-internal"), injected.PI_BOX_INTERNAL_TOKEN);
  if (previousToken == null) delete process.env.PI_BOX_INTERNAL_TOKEN;
  else process.env.PI_BOX_INTERNAL_TOKEN = previousToken;
  if (previousSecret == null) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = previousSecret;
}

{
  const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /decideAccess\(request, workerEnv\)/);
  assert.match(worker, /PI_BOX_INTERNAL_TOKEN: internal\.PI_BOX_INTERNAL_TOKEN/);
  assert.doesNotMatch(worker, /function gatewayOk/);
}

console.log("ok test-internal-auth");
