/**
 * Pi session runner. One createAgentSession per named bot / session id.
 * Do not use AgentSessionRuntime (it chdir's).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, annotateAvailability, toPiSkills } from "./skills.mjs";
import { detectCapabilities } from "./host.mjs";
import { bashSpawnHook } from "./shell-env.mjs";
import { attachToolGate, getApprovalGate } from "./approvals.mjs";
import { prepareAttachments } from "./attachments.mjs";
import { buildCustomTools } from "./pi-tools.mjs";
import { ensureBotLayout, safeBotId } from "./bot-files.mjs";
import { promptWithProfile, readMemory } from "./memory.mjs";
import { botCustomTools } from "./bot-tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function hasProviderKey(env = process.env) {
  return Boolean(
    env.OPENROUTER_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      env.OPENAI_API_KEY ||
      env.XAI_API_KEY,
  );
}

export function seedAgentDir(agentDir, env = process.env) {
  fs.mkdirSync(agentDir, { recursive: true });
  const src = path.join(HERE, "models.json");
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(agentDir, "models.json"));
  }
  const settingsPath = path.join(agentDir, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    settings = {};
  }
  const defaultModel = env.PI_MODEL || "openrouter/z-ai/glm-5.3-flash";
  settings.defaultProvider = env.PI_PROVIDER || "openrouter";
  settings.defaultModel = defaultModel.startsWith("openrouter/")
    ? defaultModel.slice("openrouter/".length)
    : defaultModel;
  if (env.OPENAI_BASE_URL) {
    settings.defaultProvider = env.PI_PROVIDER || settings.defaultProvider;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const notePath = path.join(agentDir, "AGENTS.md");
  const routinesNote =
    "\n\n## Routines\nWhen the user asks for something recurring — every day, each morning, on a schedule, or whenever an event arrives — propose a saved routine instead of only doing it once. Use the routines skill to create it (cron or webhook).\n";
  let existing = "";
  try {
    existing = fs.readFileSync(notePath, "utf8");
  } catch {
    existing = "";
  }
  const toolsNote =
    "\n\n## Chat tools\nUse web_search and web_fetch for the public web. Use ask_user when you need a decision; the tool result is the user's reply. Use send_attachment to hand a workspace file or image back as a download card.\n";
  if (!existing.includes("## Routines")) {
    const base = existing.trim() ? existing.replace(/\s*$/, "") : "# Agent";
    existing = base + routinesNote;
  }
  if (!existing.includes("## Chat tools")) {
    existing = existing.replace(/\s*$/, "") + toolsNote;
  }
  fs.writeFileSync(notePath, existing.endsWith("\n") ? existing : `${existing}\n`);
}

function normalizeBot(bot) {
  const id = safeBotId(bot?.id);
  return {
    id,
    name: bot?.name || (id === "default" ? "Assistant" : id),
    description: bot?.description || "",
    instructions: bot?.instructions || "",
    avatarColor: bot?.avatarColor || "",
    updatedAt: bot?.updatedAt || 0,
  };
}

async function diskSessionManager(mod, sessionId, cwd, sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
  if (typeof mod.SessionManager?.create !== "function") {
    return mod.SessionManager.inMemory(cwd);
  }
  try {
    if (typeof mod.SessionManager.list === "function") {
      const listed = await mod.SessionManager.list(cwd, sessionDir);
      const found = Array.isArray(listed)
        ? listed.find(
            (s) =>
              s?.id === sessionId ||
              (typeof s?.path === "string" && s.path.includes(sessionId)),
          )
        : null;
      if (found?.path && typeof mod.SessionManager.open === "function") {
        return mod.SessionManager.open(found.path, sessionDir);
      }
    }
    return mod.SessionManager.create(cwd, sessionDir, { id: sessionId });
  } catch {
    return mod.SessionManager.inMemory(cwd);
  }
}

export function piBashCustomTool(mod, cwd) {
  if (!mod || typeof mod.createBashToolDefinition !== "function") return null;
  return mod.createBashToolDefinition(cwd, { spawnHook: bashSpawnHook });
}

export function createAgentRuntime(opts = {}) {
  const sessions = new Map();
  let piMod = null;
  let piLoadError = null;
  let capabilities = null;
  let catalog = [];

  const envOf = () => opts.env || process.env;
  const cwdOf = () => opts.cwd || envOf().PI_CWD || "/workspace";
  const agentDirOf = () =>
    opts.agentDir || envOf().PI_CODING_AGENT_DIR || "/root/.pi/agent";
  const defaultModelOf = () =>
    envOf().PI_MODEL || "openrouter/z-ai/glm-5.3-flash";

  async function refreshCatalog() {
    capabilities = await detectCapabilities();
    const raw = await loadSkills();
    catalog = annotateAvailability(raw, capabilities);
    return catalog;
  }

  async function loadPi() {
    if (piMod || piLoadError) return piMod;
    try {
      piMod = await import("@earendil-works/pi-coding-agent");
      return piMod;
    } catch (err) {
      piLoadError = err;
      console.warn("[pi-box] Pi SDK not loaded, mock mode:", err?.message || err);
      return null;
    }
  }

  async function getSession(id, bot) {
    const profile = normalizeBot(bot);
    const root = agentDirOf();
    const stamp = `${profile.id}\0${profile.name}\0${profile.description}\0${profile.instructions}\0${profile.updatedAt}`;
    const cached = sessions.get(id);
    if (cached && cached.stamp === stamp) return cached;
    if (cached?.kind === "pi" && typeof cached.session?.dispose === "function") {
      try {
        await cached.session.dispose();
      } catch {
        /* replaced by a session with newer bot instructions */
      }
    }
    const mod = await loadPi();
    if (!mod || !hasProviderKey(envOf())) {
      const mock = { kind: "mock", id, stamp };
      sessions.set(id, mock);
      return mock;
    }
    await refreshCatalog();
    seedAgentDir(ensureBotLayout(root, profile).agentDir, envOf());
    const layout = ensureBotLayout(root, profile);
    const agentDir = layout.agentDir;
    const cwd = layout.workspace;
    const modelRuntime = await mod.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: true,
    });
    const defaultModel = defaultModelOf();
    const resolved = mod.resolveCliModel({
      cliModel:
        defaultModel.includes("/") && !defaultModel.startsWith("openrouter/")
          ? `openrouter/${defaultModel}`
          : defaultModel,
      modelRuntime,
    });
    if (resolved.error) {
      console.warn("[pi-box] model resolve:", resolved.error);
    } else {
      console.log(
        `[pi-box] model ${resolved.model?.provider || "openrouter"}/${resolved.model?.id || defaultModel}`,
      );
    }
    const loader = new mod.DefaultResourceLoader({
      cwd,
      agentDir,
      skillsOverride: (current) => ({
        skills: [...current.skills, ...toPiSkills(catalog)],
        diagnostics: current.diagnostics,
      }),
    });
    await loader.reload();
    const bashTool = piBashCustomTool(mod, cwd);
    const bridge = {
      cwd,
      env: envOf(),
      emit: () => {},
    };
    let extraTools = [];
    try {
      extraTools = await buildCustomTools(bridge);
      if (typeof mod.defineTool === "function") {
        extraTools = extraTools.map((tool) => mod.defineTool(tool));
      }
    } catch (err) {
      console.warn("[pi-box] custom tools skipped", err?.message || err);
      extraTools = [];
    }
    const botTools = await botCustomTools(mod, {
      memoryFile: layout.memoryFile,
      agentDir: root,
      onSkillSaved: () => refreshCatalog(),
    });
    const customTools = [bashTool, ...extraTools, ...botTools].filter(Boolean);
    const { session } = await mod.createAgentSession({
      cwd,
      agentDir,
      sessionManager: await diskSessionManager(mod, id, cwd, layout.sessionsDir),
      modelRuntime,
      resourceLoader: loader,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel || "medium",
      tools: [
        "read",
        "bash",
        "edit",
        "write",
        "ls",
        "grep",
        "find",
        ...extraTools.map((tool) => tool.name),
        "memory_write",
        "memory_forget",
        "memory_search",
        "save_skill",
      ],
      ...(customTools.length ? { customTools } : {}),
    });
    attachToolGate(session, opts.gate || getApprovalGate(), { rulesFile: layout.approvalsFile });
    const wrapped = { kind: "pi", id, stamp, session, running: false, aborted: false, bridge };
    sessions.set(id, wrapped);
    return wrapped;
  }

  async function runMock(wrapped, emit, message) {
    emit("status", { state: "mock", reason: piLoadError ? "sdk" : "no-api-key" });
    const live = catalog.filter((s) => s.available).map((s) => s.name);
    emit("tool", {
      id: "t-skills",
      name: "skills",
      status: "start",
      args: { list: true },
    });
    await new Promise((r) => setTimeout(r, 120));
    emit("tool", {
      id: "t-skills",
      name: "skills",
      status: "end",
      isError: false,
      output: live.length ? live.join(", ") : "(none available on this host)",
    });
    const text =
      `Mock mode — no model key, so Pi did not run.\n\n` +
      `You said: ${message}\n\n` +
      `Skills on this box: ${live.join(", ") || "none live"}. ` +
      `Unavailable: ${catalog.filter((s) => !s.available).map((s) => s.name).join(", ") || "none"}.\n\n` +
      `Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY) and restart for a real Pi loop.`;
    for (const chunk of text.split(/(\s+)/)) {
      if (wrapped.aborted) {
        emit("status", { state: "aborted" });
        break;
      }
      if (!chunk) continue;
      emit("text", { delta: chunk });
      await new Promise((r) => setTimeout(r, 8));
    }
    emit("done", { mock: true, aborted: Boolean(wrapped.aborted) });
  }

  async function runPi(wrapped, emit, message, images) {
    emit("status", { state: "pi" });
    const { session } = wrapped;
    const unsub = session.subscribe((event) => {
      try {
        if (event.type === "message_update") {
          const inner = event.assistantMessageEvent;
          if (inner?.type === "text_delta" && inner.delta) {
            emit("text", { delta: inner.delta });
          }
        } else if (event.type === "tool_execution_start") {
          emit("tool", {
            id: event.toolCallId || event.toolName,
            name: event.toolName,
            status: "start",
            args: event.args ?? event.toolCall?.arguments ?? undefined,
          });
        } else if (event.type === "tool_execution_update") {
          emit("tool", {
            id: event.toolCallId || event.toolName,
            name: event.toolName,
            status: "update",
            output: event.delta || event.output,
          });
        } else if (event.type === "tool_execution_end") {
          emit("tool", {
            id: event.toolCallId || event.toolName,
            name: event.toolName,
            status: "end",
            isError: Boolean(event.isError),
          });
        }
      } catch (err) {
        console.error("[pi-box] sse event failed", err);
      }
    });
    try {
      const promptOpts = images?.length ? { images } : undefined;
      await session.prompt(message, promptOpts);
    } finally {
      unsub();
    }
    emit("done", { mock: false });
  }

  async function composeTurn({ sessionId, message, attachments, cwd, agentDir }) {
    const prepared = await prepareAttachments({
      attachments,
      cwd: cwd || cwdOf(),
      agentDir: agentDir || agentDirOf(),
      sessionId,
    });
    const text = [String(message || "").trim(), prepared.note].filter(Boolean).join("\n\n");
    return { message: text, images: prepared.images };
  }

  async function runTurn({ sessionId, message, emit, attachments, bot }) {
    if (!capabilities) await refreshCatalog();
    const profile = normalizeBot(bot);
    const layout = ensureBotLayout(agentDirOf(), profile);
    process.env.PI_BOX_BOT_ID = layout.id;
    const wrapped = await getSession(String(sessionId), profile);
    const composed = await composeTurn({
      sessionId,
      message,
      attachments,
      cwd: layout.workspace,
      agentDir: agentDirOf(),
    });
    const prompt =
      wrapped.kind === "mock"
        ? composed.message
        : promptWithProfile(composed.message, readMemory(layout.memoryFile));
    wrapped.running = true;
    wrapped.aborted = false;
    wrapped.emit = emit;
    if (wrapped.bridge) wrapped.bridge.emit = emit;
    try {
      if (wrapped.kind === "mock") await runMock(wrapped, emit, prompt);
      else await runPi(wrapped, emit, prompt, composed.images);
    } finally {
      wrapped.running = false;
      wrapped.emit = null;
      if (wrapped.bridge) wrapped.bridge.emit = () => {};
    }
  }

  async function steer(sessionId, message, images) {
    const text = String(message || "").trim();
    if (!text) return { ok: false, error: "message required" };
    const wrapped = sessions.get(String(sessionId));
    if (!wrapped?.running) return { ok: false, error: "idle" };
    if (wrapped.kind === "pi" && typeof wrapped.session?.steer === "function") {
      if (images?.length) await wrapped.session.steer(text, images);
      else await wrapped.session.steer(text);
      return { ok: true, steered: true };
    }
    wrapped.steers = wrapped.steers || [];
    wrapped.steers.push(text);
    try {
      wrapped.emit?.("text", { delta: `\n[steer] ${text}\n` });
    } catch {
      /* stream closed */
    }
    return { ok: true, steered: true, mock: true };
  }

  async function abort(sessionId) {
    const wrapped = sessions.get(String(sessionId));
    if (!wrapped) return { ok: true, idle: true };
    wrapped.aborted = true;
    if (wrapped.kind === "pi" && typeof wrapped.session?.abort === "function") {
      await wrapped.session.abort();
    }
    return { ok: true };
  }

  return {
    sessions,
    refreshCatalog,
    loadPi,
    getSession,
    runTurn,
    steer,
    abort,
    catalog: () => catalog,
    capabilities: () => capabilities,
    piLoadError: () => piLoadError,
  };
}
