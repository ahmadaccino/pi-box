import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
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
  const osName =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ramGb = Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
  let gpu = "none";
  if (process.platform === "darwin") gpu = "apple";
  else if (await hasBin("nvidia-smi")) gpu = "nvidia";
  const features = [];
  if (browser) features.push("browser");
  if (ios) features.push("ios-simulator");
  if (android) features.push("android");
  if (gpu === "nvidia") features.push("cuda");
  const inferenceUrl = process.env.PI_BOX_INFERENCE_URL || "";
  if (gpu === "nvidia" || inferenceUrl) features.push("inference");
  return {
    bash: true,
    files: true,
    browser,
    vault: isVaultAvailable(),
    android,
    ios,
    platform: process.platform,
    os: osName,
    arch,
    ramGb,
    gpu,
    features,
    cloud: Boolean(process.env.CF_PAGES || process.env.CLOUDFLARE || cloudFlag || runtime.kind === "cloudflare"),
  };
}
