import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  const cloud = process.env.CLOUDFLARE_BROWSER === "1";
  const browser =
    cloud ||
    (await hasBin("chromium")) ||
    (await hasBin("chromium-browser")) ||
    (await hasBin("google-chrome")) ||
    (await hasBin("playwright"));
  const argent = await hasBin("argent");
  const android = argent || (await hasBin("adb"));
  const ios =
    process.platform === "darwin" &&
    (argent || (await hasBin("xcrun")) || (await hasBin("simctl")));
  return {
    bash: true,
    files: true,
    browser,
    android,
    ios,
    platform: process.platform,
    cloud: Boolean(process.env.CF_PAGES || process.env.CLOUDFLARE || cloud),
  };
}
