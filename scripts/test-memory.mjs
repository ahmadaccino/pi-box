#!/usr/bin/env node
/**
 * Per-bot memory tools and user skills shared across bots.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkills } from "../container/skills.mjs";
import { collectSnapshot, restoreSnapshot } from "../container/snapshot.mjs";
import {
  MEMORY_SYSTEM_NOTE,
  SKILL_SYSTEM_NOTE,
  botLayout,
  composeAgentsMd,
  ensureBotLayout,
} from "../container/bot-files.mjs";
import {
  memoryForget,
  memorySearch,
  memoryWrite,
  promptWithProfile,
  readMemory,
} from "../container/memory.mjs";
import { saveUserSkill } from "../container/user-skills.mjs";

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-box-memory-"));
const root = path.join(tmp, "agent");
const previousSkills = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;

try {
  const layout = botLayout(root, { id: "default", name: "Assistant" });
  const other = botLayout(root, { id: "botpapers", name: "Papers" });
  assert.equal(layout.sessionsDir, path.join(root, "sessions"));
  assert.equal(layout.approvalsFile, path.join(root, "approvals.json"));
  assert.equal(other.sessionsDir, path.join(root, "agents", "botpapers", "sessions"));
  assert.equal(other.approvalsFile, path.join(root, "agents", "botpapers", "approvals.json"));
  assert.notEqual(layout.memoryFile, other.memoryFile);
  assert.notEqual(layout.workspace, other.workspace);

  const profile = memoryWrite(layout.memoryFile, {
    text: "User prefers short answers",
    kind: "profile",
  });
  assert.equal(profile.ok, true);
  assert.equal(profile.fact.kind, "profile");
  assert.match(profile.fact.id, /^mem_/);

  const prompt = promptWithProfile("What should we do?", readMemory(layout.memoryFile));
  assert.match(prompt, /User prefers short answers/);
  assert.match(prompt, /What should we do\?$/);

  const log = memoryWrite(layout.memoryFile, {
    text: "Shipped routines on Thursday",
    kind: "log",
    at: "2026-10-01",
  });
  assert.equal(log.ok, true);
  assert.equal(log.fact.kind, "log");
  assert.equal(log.fact.at, "2026-10-01");

  const found = memorySearch(layout.memoryFile, "routines");
  assert.equal(found.facts.length, 1);
  assert.equal(found.facts[0].id, log.fact.id);
  assert.equal(memorySearch(layout.memoryFile, "short answers").facts.length, 0);

  const agents = composeAgentsMd({
    id: "default",
    name: "Assistant",
    description: "General chat",
    instructions: "Be concise.",
  });
  assert.match(agents, /Be concise\./);
  assert.match(agents, new RegExp(MEMORY_SYSTEM_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(agents, new RegExp(SKILL_SYSTEM_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  ensureBotLayout(root, {
    id: "default",
    name: "Assistant",
    description: "General chat",
    instructions: "Be concise.",
  });
  const written = await readFile(layout.agentsFile, "utf8");
  assert.match(written, /Be concise\./);
  assert.match(written, /memory_write/);

  const forgotten = memoryForget(layout.memoryFile, log.fact.id);
  assert.equal(forgotten.ok, true);
  assert.equal(memorySearch(layout.memoryFile, "routines").facts.length, 0);
  const still = readMemory(layout.memoryFile);
  assert.equal(still.profile.length, 1);
  assert.equal(memoryForget(layout.memoryFile, "mem_missing").ok, false);

  const otherFact = memoryWrite(other.memoryFile, { text: "Only papers", kind: "profile" });
  assert.equal(otherFact.ok, true);
  assert.equal(readMemory(layout.memoryFile).profile[0].text, "User prefers short answers");
  assert.equal(readMemory(other.memoryFile).profile[0].text, "Only papers");

  const saved = saveUserSkill({
    agentDir: root,
    name: "weekly-review",
    description: "Review the week's notes and file a summary",
    body: "1. Read the log.\n2. Write a summary.",
  });
  assert.equal(saved.ok, true);
  const skillText = await readFile(saved.filePath, "utf8");
  assert.match(skillText, /^---\nname: weekly-review\n/);
  assert.match(skillText, /description: Review the week's notes and file a summary/);
  const catalog = await loadSkills();
  const skill = catalog.find((item) => item.name === "weekly-review");
  assert.ok(skill);
  assert.equal(skill.source, "user");
  assert.match(skill.body, /Write a summary/);
  assert.equal(saveUserSkill({ agentDir: root, name: "Bad Name", description: "x", body: "y" }).ok, false);

  await mkdir(path.join(root, "agents", "default"), { recursive: true });
  await writeFile(layout.memoryFile, JSON.stringify(readMemory(layout.memoryFile)), "utf8");
  const ws = path.join(tmp, "cwd", "bots");
  await mkdir(path.join(ws, "botpapers"), { recursive: true });
  await writeFile(path.join(ws, "botpapers", "note.txt"), "workspace file");
  const snap = await collectSnapshot(root, undefined, { workspacesDir: ws });
  assert.ok(snap.files["skills/weekly-review/SKILL.md"]);
  assert.ok(snap.files["agents/default/memory.json"] || snap.files[path.relative(root, layout.memoryFile).replace(/\\/g, "/")]);
  assert.equal(snap.files["workspaces/botpapers/note.txt"], "workspace file");

  const restoredRoot = path.join(tmp, "restored");
  const restoredWs = path.join(tmp, "restored-cwd", "bots");
  await restoreSnapshot(restoredRoot, snap, undefined, { workspacesDir: restoredWs });
  const restoredSkill = await readFile(path.join(restoredRoot, "skills", "weekly-review", "SKILL.md"), "utf8");
  assert.match(restoredSkill, /name: weekly-review/);
  const restoredNote = await readFile(path.join(restoredWs, "botpapers", "note.txt"), "utf8");
  assert.equal(restoredNote, "workspace file");
} finally {
  if (previousSkills == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousSkills;
  await rm(tmp, { recursive: true, force: true });
}

console.log("ok test-memory");
