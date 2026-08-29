/**
 * Deploy a folder with wrangler using the vault Cloudflare token only.
 * Never prints or returns the token.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { getOAuthToken } from "./vault.mjs";

const CWD = process.env.PI_CWD || "/workspace";

function tokenFrom(secrets) {
  return (
    secrets?.api_token ||
    secrets?.token ||
    secrets?.access_token ||
    secrets?.CLOUDFLARE_API_TOKEN ||
    ""
  );
}

function sanitizeLog(text, token) {
  let out = String(text || "");
  if (token && token.length >= 8) {
    out = out.split(token).join("[redacted]");
  }
  return out.slice(0, 8000);
}

export async function publishSite({ dir, name } = {}) {
  const row = await getOAuthToken("cloudflare");
  const token = tokenFrom(row?.secrets || {});
  if (!token) {
    return { status: 401, body: { error: "authenticate", plugin: "cloudflare" } };
  }
  const rel = String(dir || "").trim() || ".";
  if (rel.includes("\0") || rel.split(path.sep).includes("..")) {
    return { status: 400, body: { error: "invalid dir" } };
  }
  const target = path.resolve(CWD, rel);
  if (!target.startsWith(path.resolve(CWD))) {
    return { status: 400, body: { error: "dir must be inside the workspace" } };
  }
  try {
    await access(target);
  } catch {
    return { status: 404, body: { error: "dir not found" } };
  }

  const args = ["wrangler", "deploy"];
  if (name) args.push("--name", String(name).slice(0, 64));

  const result = await new Promise((resolve) => {
    const child = spawn("npx", args, {
      cwd: target,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      resolve({
        code: 1,
        stdout: "",
        stderr: err?.message || "spawn failed",
      });
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  return {
    status: result.code === 0 ? 200 : 502,
    body: {
      ok: result.code === 0,
      dir: rel,
      log: sanitizeLog(`${result.stdout}\n${result.stderr}`, token),
    },
  };
}
