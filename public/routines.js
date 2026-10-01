(() => {
  const list = document.getElementById("list");
  const err = document.getElementById("err");
  const tzForm = document.getElementById("tz");
  const tzInput = document.getElementById("timezone");
  const createForm = document.getElementById("create");
  const trigger = document.getElementById("trigger");
  const schedule = document.getElementById("schedule");
  let clerk = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showError(message) {
    if (err) err.textContent = message || "";
  }

  async function authHeader() {
    if (!clerk?.session) return {};
    const token = await clerk.session.getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  function formatWhen(ms, timeZone) {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timeZone || "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString();
    }
  }

  function triggerLabel(routine) {
    if (routine.trigger?.type === "webhook") return "webhook";
    return routine.trigger?.schedule || "cron";
  }

  async function call(path, options = {}) {
    const headers = { ...(await authHeader()), ...(options.headers || {}) };
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  }

  function render(data) {
    const routines = data.routines || [];
    if (tzInput && data.settings?.timezone) tzInput.value = data.settings.timezone;
    list.innerHTML = "";
    if (!routines.length) {
      list.append(el("p", "lede", "No routines yet. Create one here or ask in chat."));
      return;
    }
    for (const routine of routines) {
      const row = el("article", "row");
      const title = el("h2", "", routine.name);
      const last = routine.lastStatus || "never";
      const state = routine.enabled ? last : "paused";
      const meta = el(
        "p",
        "meta",
        `${triggerLabel(routine)} · ${routine.timezone} · next ${formatWhen(routine.nextRunAt, routine.timezone)} · last ${state}`,
      );
      const badge = el("div", "st " + state, state);
      const actions = el("div", "actions");
      const pause = el("button", "ghost", routine.enabled ? "Pause" : "Resume");
      pause.type = "button";
      pause.addEventListener("click", async () => {
        pause.disabled = true;
        try {
          await call(`/api/routines/${encodeURIComponent(routine.id)}/${routine.enabled ? "pause" : "resume"}`, {
            method: "POST",
          });
          await load();
        } catch (error) {
          showError(error.message);
          pause.disabled = false;
        }
      });
      const run = el("button", "ghost", "Run now");
      run.type = "button";
      run.addEventListener("click", async () => {
        run.disabled = true;
        try {
          await call(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" });
          await load();
        } catch (error) {
          showError(error.message);
          run.disabled = false;
        }
      });
      const del = el("button", "ghost", "Delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        del.disabled = true;
        try {
          await call(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
          await load();
        } catch (error) {
          showError(error.message);
          del.disabled = false;
        }
      });
      actions.append(pause, run, del);
      row.append(title, meta, badge, actions);
      if (routine.webhookUrl) {
        row.append(el("p", "meta", routine.webhookUrl));
      }
      const history = routine.history || [];
      if (history.length) {
        const details = el("details", "history");
        details.append(el("summary", "", `history (${history.length})`));
        for (const item of history) {
          const block = el("div");
          block.append(
            el(
              "p",
              "meta",
              `${item.status} · ${item.trigger} · ${formatWhen(item.startedAt, routine.timezone)}`,
            ),
          );
          if (item.result || item.error) {
            block.append(el("pre", "", item.result || item.error));
          }
          details.append(block);
        }
        row.append(details);
      }
      list.append(row);
    }
  }

  async function load() {
    showError("");
    try {
      const data = await call("/api/routines");
      render(data);
    } catch (error) {
      list.textContent = error.message === "401" ? "sign in from chat first, then come back." : "could not load routines";
      if (error.message !== "401") showError(error.message);
    }
  }

  tzForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await call("/api/routines/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone: tzInput.value.trim() }),
      });
      await load();
    } catch (error) {
      showError(error.message);
    }
  });

  trigger?.addEventListener("change", () => {
    if (schedule) schedule.hidden = trigger.value === "webhook";
  });

  createForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    const body = {
      name: document.getElementById("name").value,
      prompt: document.getElementById("prompt").value,
      trigger: trigger.value,
      timezone: tzInput.value.trim() || undefined,
    };
    if (trigger.value === "cron") body.schedule = schedule.value;
    try {
      const data = await call("/api/routines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      createForm.reset();
      if (schedule) schedule.hidden = false;
      await load();
      if (data.webhookKey) {
        const note = el("div", "secret", `Webhook key (shown once): ${data.webhookKey}`);
        list.prepend(note);
      }
    } catch (error) {
      showError(error.message);
    }
  });

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("script failed"));
      document.head.append(script);
    });
  }

  async function boot() {
    const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
    if (cfg.clerkPublishableKey) {
      await loadScript("https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js");
      clerk = new window.Clerk(cfg.clerkPublishableKey);
      await clerk.load();
    }
    await load();
  }

  boot();
})();
