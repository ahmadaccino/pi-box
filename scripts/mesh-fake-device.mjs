#!/usr/bin/env node
/**
 * Join the mesh as a fake sidecar. Usage:
 *   node scripts/mesh-fake-device.mjs --origin http://127.0.0.1:8787 --name ryzen-box
 *   node scripts/mesh-fake-device.mjs --ios-nack
 */
import {
  ackJob,
  connectJobs,
  deviceCaps,
  jobEvent,
  nackJob,
  registerDevice,
  startHeartbeat,
} from "../container/device.mjs";

const args = process.argv.slice(2);
function flag(name, fallback = "") {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "1";
}

const origin = flag("origin", process.env.PI_BOX_ORIGIN || "http://127.0.0.1:8787");
const name = flag("name", "fake-device");
const iosNack = args.includes("--ios-nack");
const cookie = process.env.PI_BOX_COOKIE || "";

const caps = await deviceCaps();
if (args.includes("--linux")) {
  caps.os = "linux";
  caps.platform = "linux";
  caps.ios = false;
  caps.gpu = "nvidia";
  caps.ramGb = 128;
}
if (args.includes("--darwin")) {
  caps.os = "darwin";
  caps.platform = "darwin";
  caps.ios = true;
}

const registered = await registerDevice(origin, {
  name,
  caps,
  headers: cookie ? { cookie } : {},
});
console.log(`[fake-device] ${registered.deviceId}`);

startHeartbeat(origin, {
  deviceId: registered.deviceId,
  deviceSecret: registered.deviceSecret,
  caps,
});

connectJobs(origin, {
  deviceId: registered.deviceId,
  deviceSecret: registered.deviceSecret,
  onJob(job, ws) {
    const needIos = (job.require || []).includes("ios") || (job.require || []).includes("ios-simulator");
    if (iosNack || (needIos && !caps.ios)) {
      nackJob(ws, job.id, ["ios"]);
      console.log(`[fake-device] nack ios ${job.id}`);
      return;
    }
    jobEvent(ws, job.id, "text", { delta: `ran on ${name}\n` });
    ackJob(ws, job.id);
    console.log(`[fake-device] ack ${job.id}`);
  },
});
