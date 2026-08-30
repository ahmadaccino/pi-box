#!/usr/bin/env node
import assert from "node:assert/strict";
import { MeshStore } from "../src/mesh-state.ts";
import { planChatTurn } from "../src/mesh-chat.ts";
import { annotateSkills, unionSkills } from "../src/caps.ts";

const NOW = 4_000_000;
const skills = [
  { name: "browser", requires: ["browser"] },
  { name: "ios-simulator", requires: ["ios"] },
];

{
  const store = new MeshStore();
  const { decision, job } = planChatTurn(store, {
    sessionId: "chat-1",
    message: "hi",
    now: NOW,
  });
  assert.equal(decision.deviceId, "cloud");
  assert.equal(job.state, "leased");
  assert.equal(job.leasedTo, "cloud");
}

{
  const store = new MeshStore();
  const { decision } = planChatTurn(store, {
    sessionId: "chat-1",
    message: "sim",
    require: ["ios"],
    now: NOW,
  });
  assert.equal(decision.wait, true);
  assert.notEqual(decision.deviceId, "cloud");
}

{
  const store = new MeshStore();
  store.register({
    meshId: "default",
    name: "ryzen-box",
    caps: {
      os: "linux",
      ramGb: 128,
      ios: false,
      browser: true,
      gpu: "nvidia",
    },
    tokenHash: "ab",
    now: NOW,
    uuid: "11111111-1111-4111-8111-111111111111",
  });
  const ios = planChatTurn(store, {
    sessionId: "chat-1",
    require: ["ios"],
    now: NOW,
  });
  assert.equal(ios.decision.wait, true);

  const portable = planChatTurn(store, {
    sessionId: "chat-2",
    now: NOW,
  });
  assert.equal(portable.decision.deviceId, "d_default_11111111-1111-4111-8111-111111111111");
}

{
  const linuxCaps = { ios: false, android: false, browser: true, cloud: false };
  const cloudCaps = { ios: false, android: false, browser: true, cloud: true };
  const annotated = annotateSkills(skills, linuxCaps);
  assert.equal(annotated.find((s) => s.name === "ios-simulator").available, false);
  assert.equal(annotated.find((s) => s.name === "browser").available, true);
  const union = unionSkills(skills, [linuxCaps, cloudCaps]);
  assert.equal(union.find((s) => s.name === "ios-simulator").available, false);
}

console.log("ok mesh-chat-check");
