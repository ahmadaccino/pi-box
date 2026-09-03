export const DEFAULT_ORIGIN = "https://pi-box.ahmad-096.workers.dev";
export const KEYCHAIN_SERVICE = "pi-box";

export function builderTargets() {
  return {
    mac: ["arm64", "x64"],
    linux: ["x64"],
    linuxExcluded: ["arm64"],
  };
}

export function keychainAccount(origin, deviceId) {
  return `${origin}::${deviceId}`;
}

export function sidecarArgs({ origin, name, cookie, token, home } = {}) {
  const args = ["node"];
  if (origin) args.push("--origin", origin);
  if (name) args.push("--name", name);
  if (cookie) args.push("--cookie", cookie);
  if (token) args.push("--token", token);
  if (home) args.push("--home", home);
  return args;
}

export function resolveOrigin(env = process.env) {
  return env.PI_BOX_ORIGIN || DEFAULT_ORIGIN;
}
