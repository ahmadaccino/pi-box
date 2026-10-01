#!/usr/bin/env node
/**
 * Bash tool env isolation: `env` inside the bash spawn path must not show
 * sidecar secrets. The same spawnHook is what Pi's bash tool receives.
 */
import assert from "node:assert/strict";
import { piBashCustomTool } from "../container/agent.mjs";
import { executeBashTool, bashSpawnHook, SECRET_ENV_NAMES } from "../container/shell-env.mjs";
import {
  loadEncryptionKey,
  resetVaultKeyForTests,
  sealVaultKeyFromEnv,
} from "../container/vault.mjs";

const saved = {};
for (const key of [...SECRET_ENV_NAMES, "PI_BOX_VISIBLE"]) {
  saved[key] = process.env[key];
}

function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

const secrets = {
  VAULT_ENCRYPTION_KEY: "vault-secret-value-d4f1",
  OPENROUTER_API_KEY: "sk-or-secret-d4f1",
  ANTHROPIC_API_KEY: "sk-ant-secret-d4f1",
  OPENAI_API_KEY: "sk-openai-secret-d4f1",
  XAI_API_KEY: "xai-secret-d4f1",
  GOOGLE_CLIENT_SECRET: "google-secret-d4f1",
  BROWSER_CDP_TOKEN: "cdp-token-d4f1",
  CLOUDFLARE_API_TOKEN: "cf-token-d4f1",
  GATEWAY_TOKEN: "gateway-token-d4f1",
  CLERK_SECRET_KEY: "clerk-secret-d4f1",
  PI_BOX_PASSWORD: "password-secret-d4f1",
  PI_BOX_DEVICE_SECRET: "device-secret-d4f1",
  PI_BOX_INTERNAL_TOKEN: "internal-token-d4f1",
  INTERNAL_API_SECRET: "internal-secret-d4f1",
};

try {
  resetVaultKeyForTests();
  for (const [key, value] of Object.entries(secrets)) process.env[key] = value;
  process.env.PI_BOX_VISIBLE = "kept-visible-d4f1";

  const hooked = piBashCustomTool(
    {
      createBashToolDefinition(_cwd, options) {
        return options;
      },
    },
    "/tmp",
  );
  assert.equal(hooked.spawnHook, bashSpawnHook);
  const stripped = hooked.spawnHook({
    command: "env",
    cwd: "/tmp",
    env: { ...process.env },
  });
  for (const name of SECRET_ENV_NAMES) {
    assert.equal(stripped.env[name], undefined, `${name} must be stripped by the bash spawnHook`);
  }
  assert.equal(stripped.env.PI_BOX_VISIBLE, "kept-visible-d4f1");

  const ran = await executeBashTool("env");
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /PI_BOX_VISIBLE=kept-visible-d4f1/);
  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(ran.env[name], undefined);
    assert.ok(!ran.stdout.includes(name), `env listed ${name}`);
    assert.ok(!ran.stdout.includes(value), `env showed the value of ${name}`);
  }
  const echoed = await executeBashTool('printf %s "$VAULT_ENCRYPTION_KEY"');
  assert.equal(echoed.stdout, "");

  const key = Buffer.alloc(32, 9).toString("base64");
  process.env.VAULT_ENCRYPTION_KEY = key;
  sealVaultKeyFromEnv();
  assert.equal(process.env.VAULT_ENCRYPTION_KEY, undefined);
  const loaded = loadEncryptionKey();
  assert.equal(loaded.localDev, false);
  assert.equal(loaded.key.toString("base64"), key);
  const afterSeal = await executeBashTool("env");
  assert.ok(!afterSeal.stdout.includes(key));
  assert.ok(!afterSeal.stdout.includes("VAULT_ENCRYPTION_KEY"));

  console.log("ok test-shell-env");
} finally {
  restoreEnv();
  resetVaultKeyForTests();
}
