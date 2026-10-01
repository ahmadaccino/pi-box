/**
 * Environment handed to model-run shell commands.
 * Pi's bash tool copies process.env (getShellEnv). spawnHook strips secrets
 * before the child is spawned. executeBashTool is that same path for tests.
 */
import { spawn } from "node:child_process";

export const SECRET_ENV_NAMES = Object.freeze([
  "VAULT_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "BROWSER_CDP_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "GATEWAY_TOKEN",
  "CLERK_SECRET_KEY",
  "PI_BOX_PASSWORD",
  "PI_BOX_DEVICE_SECRET",
  "PI_BOX_INTERNAL_TOKEN",
  "INTERNAL_API_SECRET",
]);

const SECRET_SET = new Set(SECRET_ENV_NAMES);

export function stripSecretEnv(env) {
  const next = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value == null) continue;
    if (SECRET_SET.has(key)) continue;
    next[key] = String(value);
  }
  return next;
}

/** Pi BashSpawnHook. Returns command, cwd, and an env without sidecar secrets. */
export function bashSpawnHook(ctx) {
  return {
    command: ctx?.command ?? "",
    cwd: ctx?.cwd || process.cwd(),
    env: stripSecretEnv(ctx?.env || {}),
  };
}

function shellBin() {
  return process.platform === "win32" ? "bash" : "/bin/bash";
}

/**
 * Run a command the way the bash tool does: copy the parent env, apply
 * bashSpawnHook, then spawn bash -c. `env` inside the command must not
 * show SECRET_ENV_NAMES.
 */
export function executeBashTool(command, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const base = { ...(opts.env || process.env) };
  const ctx = bashSpawnHook({ command: String(command ?? ""), cwd, env: base });
  return new Promise((resolve, reject) => {
    const child = spawn(opts.shell || shellBin(), ["-c", ctx.command], {
      cwd: ctx.cwd,
      env: ctx.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, env: ctx.env });
    });
  });
}
