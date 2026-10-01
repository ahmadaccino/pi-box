/**
 * Per-bot files: instructions (AGENTS.md), memory, approvals, Pi sessions, workspace.
 * The default bot keeps the existing sessions/ and approvals.json locations.
 */
import fs from "node:fs";
import path from "node:path";

export const MEMORY_SYSTEM_NOTE =
  "Save a fact with memory_write when the user states a stable preference, identity detail, or a decision they will want later. Use kind profile for facts that should always be in the prompt, and kind log with a date for events. Search dated log facts with memory_search. Use memory_forget when the user asks you to forget a fact.";

export const SKILL_SYSTEM_NOTE =
  "When the user asks to save a reusable multi-step procedure, call save_skill with a hyphenated name, a one-line description, and the steps in markdown. User skills are shared across bots and appear in the skills list.";

export function safeBotId(raw) {
  const id = String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return id || "default";
}

export function composeAgentsMd(bot = {}) {
  const id = safeBotId(bot.id);
  const name = String(bot.name || "Assistant").trim() || "Assistant";
  const description = String(bot.description || "").trim();
  const instructions = String(bot.instructions || "").trim();
  const parts = [`# ${name}`];
  if (description) parts.push(description);
  if (instructions) parts.push(instructions);
  parts.push(
    `## Memory\n${MEMORY_SYSTEM_NOTE}\n\nProfile facts are prepended to each message. Dated log facts stay out of the prompt until memory_search.`,
  );
  parts.push(`## Skills\n${SKILL_SYSTEM_NOTE}`);
  parts.push(
    "## Routines\nWhen the user asks for something recurring — every day, each morning, on a schedule, or whenever an event arrives — propose a saved routine instead of only doing it once. Use the routines skill to create it (cron or webhook). " +
      `This bot's id is \`${id}\`. Include {"botId":"${id}"} so the routine belongs to this bot.`,
  );
  parts.push(
    "## Chat tools\nUse web_search and web_fetch for the public web. Use ask_user when you need a decision; the tool result is the user's reply. Use send_attachment to hand a workspace file or image back as a download card.",
  );
  return `${parts.join("\n\n")}\n`;
}

export function botLayout(root, bot = {}, env = process.env) {
  const id = safeBotId(bot?.id);
  const agentDir = path.join(root, "agents", id);
  const baseWork = env.PI_CWD || path.join(root, "workspaces");
  const workspace =
    id === "default"
      ? env.PI_CWD || path.join(root, "workspaces", "default")
      : env.PI_CWD
        ? path.join(env.PI_CWD, "bots", id)
        : path.join(root, "workspaces", id);
  return {
    id,
    agentDir,
    workspace,
    memoryFile: path.join(agentDir, "memory.json"),
    approvalsFile:
      id === "default" ? path.join(root, "approvals.json") : path.join(agentDir, "approvals.json"),
    agentsFile: path.join(agentDir, "AGENTS.md"),
    sessionsDir: id === "default" ? path.join(root, "sessions") : path.join(agentDir, "sessions"),
    skillsDir: path.join(root, "skills"),
    baseWork,
  };
}

export function ensureBotLayout(root, bot = {}, env = process.env) {
  const layout = botLayout(root, bot, env);
  fs.mkdirSync(layout.agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.sessionsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.skillsDir, { recursive: true, mode: 0o700 });
  const markdown = composeAgentsMd({ ...bot, id: layout.id });
  fs.writeFileSync(layout.agentsFile, markdown, { mode: 0o600 });
  if (!fs.existsSync(layout.memoryFile)) {
    fs.writeFileSync(
      layout.memoryFile,
      JSON.stringify({ profile: [], log: [] }, null, 2),
      { mode: 0o600 },
    );
  }
  return layout;
}
