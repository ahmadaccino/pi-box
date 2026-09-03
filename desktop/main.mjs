/**
 * Electron main process. Window loads the hosted (or configured) UI.
 * After login, the device secret lives in the OS keychain and the sidecar stays up.
 */
import { app, BrowserWindow, ipcMain, session } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  KEYCHAIN_SERVICE,
  keychainAccount,
  resolveOrigin,
  sidecarArgs,
} from "./logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ORIGIN = resolveOrigin(process.env);

let mainWindow = null;
let sidecar = null;
let sidecarStopping = false;

async function keytar() {
  try {
    return await import("keytar");
  } catch {
    return null;
  }
}

async function saveSecret(deviceId, secret) {
  const kt = await keytar();
  if (!kt?.default) return;
  await kt.default.setPassword(
    KEYCHAIN_SERVICE,
    keychainAccount(ORIGIN, deviceId),
    secret,
  );
}

async function loadSecret(deviceId) {
  const kt = await keytar();
  if (!kt?.default) return "";
  return (
    (await kt.default.getPassword(
      KEYCHAIN_SERVICE,
      keychainAccount(ORIGIN, deviceId),
    )) || ""
  );
}

function sidecarEntry() {
  const packed = process.resourcesPath
    ? path.join(process.resourcesPath, "bin", "pi-box.mjs")
    : path.join(ROOT, "bin", "pi-box.mjs");
  return packed;
}

function homeDir() {
  return process.env.PI_BOX_HOME || path.join(os.homedir(), ".pi-box");
}

async function sessionCookie() {
  const cookies = await session.defaultSession.cookies.get({ url: ORIGIN });
  const auth = cookies.find((c) => c.name === "pi_box_auth");
  return auth ? `${auth.name}=${auth.value}` : "";
}

function startSidecar({ cookie, token, name }) {
  if (sidecar && !sidecar.killed) return;
  const args = sidecarArgs({
    origin: ORIGIN,
    name: name || os.hostname().split(".")[0] || "desktop",
    cookie,
    token,
    home: homeDir(),
  });
  sidecarStopping = false;
  sidecar = spawn(process.execPath, [sidecarEntry(), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PI_BOX_ORIGIN: ORIGIN,
      PI_BOX_HOME: homeDir(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecar.stdout.on("data", (buf) => {
    const text = String(buf);
    process.stdout.write(text);
    const m = text.match(/joined as (d_\S+)/);
    if (m) {
      /* identity file also written by the node; keychain copy is best-effort */
      void readIdentityIntoKeychain(m[1]);
    }
  });
  sidecar.stderr.on("data", (buf) => process.stderr.write(buf));
  sidecar.on("exit", (code) => {
    sidecar = null;
    if (!sidecarStopping && mainWindow) {
      setTimeout(() => {
        void bootSidecarIfSignedIn();
      }, 2000);
    }
    if (code) console.warn("[pi-box] sidecar exited", code);
  });
}

function stopSidecar() {
  sidecarStopping = true;
  if (sidecar && !sidecar.killed) sidecar.kill();
  sidecar = null;
}

async function readIdentityIntoKeychain(deviceId) {
  try {
    const { readIdentity } = await import("../container/node.mjs");
    const ident = await readIdentity(homeDir());
    if (ident?.deviceSecret) await saveSecret(deviceId || ident.deviceId, ident.deviceSecret);
  } catch {
    /* file store is enough for headless; keychain is a plus */
  }
}

async function signedIn() {
  const cookie = await sessionCookie();
  if (cookie) return { cookie, token: "" };
  return null;
}

async function bootSidecarIfSignedIn() {
  const auth = await signedIn();
  if (!auth) {
    stopSidecar();
    return;
  }
  startSidecar(auth);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "pi-box",
    webPreferences: {
      preload: path.join(HERE, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(ORIGIN);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("pi-box:origin", () => ORIGIN);

app.whenReady().then(() => {
  createWindow();
  const ses = session.defaultSession;
  ses.cookies.on("changed", () => {
    void bootSidecarIfSignedIn();
  });
  void bootSidecarIfSignedIn();
  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopSidecar());
