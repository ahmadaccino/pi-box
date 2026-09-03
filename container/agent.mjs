/**
 * Pi session runner. One createAgentSession per named bot / session id.
 * Do not use AgentSessionRuntime (it chdir's).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, annotateAvailability, toPiSkills } from "./skills.mjs";
import { detectCapabilities } from "./host.mjs";

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
}

async function diskSessionManager(mod, sessionId, cwd, agentDir) {
  const sessionDir = path.join(agentDir, "sessions");
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

  async function getSession(id) {
    if (sessions.has(id)) return sessions.get(id);
    const mod = await loadPi();
    if (!mod || !hasProviderKey(envOf())) {
      const mock = { kind: "mock", id };
      sessions.set(id, mock);
      return mock;
    }
    await refreshCatalog();
    const agentDir = agentDirOf();
    const cwd = cwdOf();
    seedAgentDir(agentDir, envOf());
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
    const { session } = await mod.createAgentSession({
      cwd,
      agentDir,
      sessionManager: await diskSessionManager(mod, id, cwd, agentDir),
      modelRuntime,
      resourceLoader: loader,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel || "medium",
      tools: ["read", "bash", "edit", "write", "ls", "grep", "find"],
    });
    const wrapped = { kind: "pi", id, session };
    sessions.set(id, wrapped);
    return wrapped;
  }

  async function runMock(emit, message) {
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
      if (!chunk) continue;
      emit("text", { delta: chunk });
      await new Promise((r) => setTimeout(r, 8));
    }
    emit("done", { mock: true });
  }

  async function runPi(wrapped, emit, message) {
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
      await session.prompt(message);
    } finally {
      unsub();
    }
    emit("done", { mock: false });
  }

  async function runTurn({ sessionId, message, emit }) {
    if (!capabilities) await refreshCatalog();
    const wrapped = await getSession(String(sessionId));
    if (wrapped.kind === "mock") await runMock(emit, message);
    else await runPi(wrapped, emit, message);
  }

  return {
    sessions,
    refreshCatalog,
    loadPi,
    getSession,
    runTurn,
    catalog: () => catalog,
    capabilities: () => capabilities,
    piLoadError: () => piLoadError,
  };
}
