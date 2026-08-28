import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectBrowserRuntime } from "./browser.mjs";
import { isVaultAvailable } from "./vault.mjs";

const exec = promisify(execFile);

async function hasBin(bin) {
  try {
    await exec(process.platform === "win32" ? "where" : "which", [bin], {
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

export async function detectCapabilities() {
  const runtime = await detectBrowserRuntime();
  const cloudFlag = process.env.CLOUDFLARE_BROWSER === "1";
  const browser = runtime.available;
  const argent = await hasBin("argent");
  const android = argent || (await hasBin("adb"));
  const ios =
    process.platform === "darwin" &&
    (argent || (await hasBin("xcrun")) || (await hasBin("simctl")));
  return {
    bash: true,
    files: true,
    browser,
    vault: isVaultAvailable(),
    android,
    ios,
    platform: process.platform,
    cloud: Boolean(process.env.CF_PAGES || process.env.CLOUDFLARE || cloudFlag || runtime.kind === "cloudflare"),
  };
}
