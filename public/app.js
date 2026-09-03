const gate = document.getElementById("gate");
const app = document.getElementById("app");
const roster = document.getElementById("roster");
const skillList = document.getElementById("skill-list");
const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const statusEl = document.getElementById("status");
const boxName = document.getElementById("box-name");
const boxMeta = document.getElementById("box-meta");
const boxRuntime = document.getElementById("box-runtime");
const userBtn = document.getElementById("userbtn");
const signin = document.getElementById("signin");
const machinesEl = document.getElementById("machines");

const pwform = document.getElementById("pwform");
const pw = document.getElementById("pw");
const pwerr = document.getElementById("pwerr");
const newchat = document.getElementById("newchat");

let clerk = null;
let boxes = [];
let current = null;
let chatSession = localStorage.getItem("pi-box-chat") || crypto.randomUUID();
let computerSessionId = null;
let computerTimer = null;

localStorage.setItem("pi-box-chat", chatSession);

function computerPane() {
  return document.getElementById("computer-pane");
}

function stopComputer() {
  if (computerTimer) {
    clearInterval(computerTimer);
    computerTimer = null;
  }
  const pane = computerPane();
  if (pane && typeof pane._piComputerStop === "function") {
    pane._piComputerStop();
    pane._piComputerStop = null;
  }
}

function showIdleComputer(pane) {
  if (!pane) return;
  pane.className = "pi-computer";
  pane.innerHTML = "";
  const bar = el("div", "pi-computer-bar", "browser idle");
  pane.append(bar);
}

async function syncComputer(box) {
  const pane = computerPane();
  if (!pane || !window.PiBoxComputer) return;
  const on = Boolean(box?.capabilities?.browser);
  if (!on) {
    stopComputer();
    pane.hidden = true;
    pane.innerHTML = "";
    computerSessionId = null;
    return;
  }
  pane.hidden = false;
  let sid = null;
  let takeover = false;
  try {
    const data = await PiBoxComputer.listBrowsers({ headers: await authHeader() });
    const session = (data.sessions || [])[0];
    if (session?.id) {
      sid = session.id;
      takeover = Boolean(session.takeover);
    }
  } catch {
    sid = null;
  }
  if (sid && sid !== computerSessionId) {
    computerSessionId = sid;
    PiBoxComputer.renderComputerPane(pane, sid, { takeover });
  } else if (!sid) {
    computerSessionId = null;
    showIdleComputer(pane);
  }
}

function startComputer(box) {
  stopComputer();
  syncComputer(box);
  if (box?.capabilities?.browser) {
    computerTimer = setInterval(() => syncComputer(box), 3000);
  }
}

async function authHeader() {
  if (!clerk?.session) return {};
  const token = await clerk.session.getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setRuntime(text) {
  if (boxRuntime) boxRuntime.textContent = text || "";
}

function deviceCapsLine(device) {
  const c = device.caps || {};
  const bits = [];
  if (c.os || c.platform) bits.push(c.os || c.platform);
  if (c.arch) bits.push(c.arch);
  if (c.gpu && c.gpu !== "none") bits.push(c.gpu);
  if ((c.features || []).includes("inference")) bits.push("inference");
  const flags = ["browser", "ios", "android", "cloud"].filter((k) => c[k] === true);
  bits.push(...flags);
  const inflight = `${device.inflight || 0}/${device.inflightCap || 1}`;
  bits.push(`jobs ${inflight}`);
  return bits.join(" · ");
}

function renderMachines(devices) {
  if (!machinesEl) return;
  machinesEl.innerHTML = "";
  if (!devices.length) {
    machinesEl.append(el("p", "machine-hint", "no machines yet"));
    return;
  }
  for (const device of devices) {
    const row = el(
      "div",
      "machine-row" + (device.online ? " online" : "") + (device.drain ? " drain" : ""),
    );
    row.append(el("span", "dot"));
    const body = el("div");
    const state = device.drain ? "drain" : device.online ? "online" : "offline";
    body.append(el("span", "name", `${device.name || device.id} · ${state}`));
    body.append(el("span", "caps", deviceCapsLine(device)));
    if (device.id && device.id !== "cloud") {
      const actions = el("div", "machine-actions");
      if (!device.drain) {
        const drainBtn = el("button", "ghost tiny", "Drain");
        drainBtn.type = "button";
        drainBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          drainDevice(device.id);
        });
        actions.append(drainBtn);
      }
      const delBtn = el("button", "ghost tiny", "Remove");
      delBtn.type = "button";
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteDevice(device.id);
      });
      actions.append(delBtn);
      body.append(actions);
    }
    row.append(body);
    machinesEl.append(row);
  }
}

async function loadMachines() {
  try {
    const res = await fetch("/api/devices", { headers: await authHeader() });
    if (!res.ok) return;
    const data = await res.json();
    renderMachines(data.devices || []);
  } catch {
    /* machines pane is optional on older sidecars */
  }
}

async function drainDevice(id) {
  try {
    await fetch(`/api/devices/${encodeURIComponent(id)}/drain`, {
      method: "POST",
      headers: await authHeader(),
    });
  } finally {
    await loadMachines();
  }
}

async function deleteDevice(id) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: await authHeader(),
    });
    if (res.status === 409) {
      await drainDevice(id);
      await fetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: await authHeader(),
      });
    }
  } finally {
    await loadMachines();
  }
}

function capsLine(box) {
  const c = box.capabilities || {};
  const on = Object.entries(c)
    .filter(([k, v]) => v === true && k !== "cloud")
    .map(([k]) => k);
  return on.join(" · ") || box.kind || "box";
}

function renderRoster() {
  roster.innerHTML = "";
  for (const box of boxes) {
    const btn = el("button", "box-row" + (current?.id === box.id ? " active" : ""));
    btn.type = "button";
    btn.append(el("span", "name", box.name || box.id));
    btn.append(el("span", "caps", capsLine(box)));
    btn.addEventListener("click", () => selectBox(box.id));
    roster.append(btn);
  }
}

function renderSkills(box) {
  skillList.innerHTML = "";
  const skills = box?.skills || [];
  if (!skills.length) {
    skillList.textContent = "no skills indexed";
    return;
  }
  for (const s of skills) {
    const chip = el("span", "chip" + (s.available ? "" : " off"), s.name);
    chip.title = s.available
      ? s.description
      : `needs ${ (s.missing || s.requires || []).join(", ") }`;
    skillList.append(chip);
  }
}

function selectBox(id) {
  current = boxes.find((b) => b.id === id) || boxes[0];
  if (!current) return;
  localStorage.setItem("pi-box-session", current.id);
  boxName.textContent = current.name;
  boxMeta.textContent = capsLine(current);
  renderRoster();
  renderSkills(current);
  startComputer(current);
  log.innerHTML = "";
  input.focus();
}

function addUser(text) {
  const wrap = el("article", "msg user");
  wrap.append(el("div", "who", "you"));
  wrap.append(el("div", "bubble", text));
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
}

function addAssistant() {
  const wrap = el("article", "msg assistant");
  wrap.append(el("div", "who", current?.name || "pi-box"));
  const bubble = el("div", "bubble");
  wrap.append(bubble);
  log.append(wrap);
  const tools = new Map();
  return {
    wrap,
    bubble,
    append(delta) {
      bubble.textContent += delta;
      log.scrollTop = log.scrollHeight;
    },
    tool(ev) {
      const id = ev.id || ev.name;
      let card = tools.get(id);
      if (!card) {
        card = el("div", "tool");
        const head = el("div", "head");
        const name = el("span", "name", ev.name || "tool");
        const st = el("span", "st", "running");
        head.append(name, st);
        const pre = document.createElement("pre");
        card.append(head, pre);
        head.addEventListener("click", () => card.classList.toggle("open"));
        wrap.insertBefore(card, bubble);
        card._st = st;
        card._pre = pre;
        tools.set(id, card);
      }
      if (ev.args) card._pre.textContent = JSON.stringify(ev.args, null, 2);
      if (ev.output) {
        card._pre.textContent += (card._pre.textContent ? "\n" : "") + ev.output;
        card.classList.add("open");
      }
      if (ev.status === "end") {
        card._st.textContent = ev.isError ? "error" : "done";
        card._st.className = "st " + (ev.isError ? "bad" : "ok");
      }
      log.scrollTop = log.scrollHeight;
    },
  };
}

async function chat(message) {
  if (!current) return;
  addUser(message);
  const asst = addAssistant();
  setStatus("running", "live");
  send.disabled = true;
  try {
    const headers = {
      "content-type": "application/json",
      "x-pi-box-session": chatSession,
      ...(await authHeader()),
    };
    const res = await fetch(`/api/chat?session=${encodeURIComponent(chatSession)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, session: chatSession, boxId: current.id }),
    });
    if (!res.ok || !res.body) {
      asst.append(`error ${res.status}`);
      setStatus("error", "err");
      return;
    }
    const runtime = res.headers.get("x-pi-box-runtime");
    if (runtime) setRuntime(runtime === "cloud" ? "cloud" : runtime);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const block of parts) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload = {};
        try {
          payload = JSON.parse(data);
        } catch {
          payload = { delta: data };
        }
        if (event === "text" && payload.delta) asst.append(payload.delta);
        else if (event === "tool") asst.tool(payload);
        else if (event === "status" && payload.state === "mock") setStatus("mock", "live");
        else if (event === "status" && payload.state === "waiting") {
          setStatus("waiting", "live");
          setRuntime(payload.message || "waiting");
          asst.append(payload.message || "Waiting for a matching machine.");
        } else if (event === "status" && payload.runtime) {
          setRuntime(payload.runtime);
        } else if (event === "error") {
          asst.append("\n" + (payload.message || "error"));
          setStatus("error", "err");
        } else if (event === "done") {
          setStatus(payload.waiting ? "waiting" : payload.mock ? "mock" : "idle");
        }
      }
    }
    if (statusEl.textContent === "running") setStatus("idle");
  } catch (err) {
    asst.append(String(err));
    setStatus("error", "err");
  } finally {
    send.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  chat(message);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

async function loadBoxes() {
  const res = await fetch("/api/boxes", { headers: await authHeader() });
  if (!res.ok) throw new Error("boxes " + res.status);
  const data = await res.json();
  boxes = data.boxes || [];
  const saved = localStorage.getItem("pi-box-session");
  selectBox(saved && boxes.some((b) => b.id === saved) ? saved : boxes[0]?.id);
  await loadMachines();
}

function showApp() {
  gate.hidden = true;
  app.hidden = false;
  app.style.display = "grid";
}

function showGate() {
  gate.hidden = false;
  gate.style.display = "grid";
  app.hidden = true;
}

if (newchat) {
  newchat.addEventListener("click", () => {
    chatSession = crypto.randomUUID();
    localStorage.setItem("pi-box-chat", chatSession);
    if (log) log.innerHTML = "";
    setStatus("new chat");
    input?.focus();
  });
}

if (pwform) {
  pwform.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pwerr) pwerr.hidden = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw?.value || "" }),
      });
      if (!res.ok) {
        if (pwerr) pwerr.hidden = false;
        return;
      }
      showApp();
      await loadBoxes();
      setStatus("ready");
    } catch {
      if (pwerr) pwerr.hidden = false;
    }
  });
}

async function boot() {
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (cfg.passwordRequired && pwform) {
    showGate();
    document.getElementById("gate-copy").textContent = "Password to open this box.";
    pwform.hidden = false;
    const probe = await fetch("/api/boxes").catch(() => ({ ok: false }));
    if (probe.ok) {
      showApp();
      await loadBoxes();
      setStatus("ready");
      return;
    }
    return;
  }
  if (cfg.clerkPublishableKey && window.Clerk) {
    clerk = new window.Clerk(cfg.clerkPublishableKey);
    await clerk.load();
    if (!clerk.user) {
      showGate();
      signin.onclick = () => clerk.openSignIn();
      clerk.addListener(({ user }) => {
        if (user) location.reload();
      });
      return;
    }
    userBtn.textContent = clerk.user.firstName || clerk.user.username || "you";
    userBtn.onclick = () => clerk.openUserProfile();
  } else {
    userBtn.hidden = true;
  }
  showApp();
  try {
    await loadBoxes();
    setStatus("ready");
  } catch (err) {
    setStatus("offline", "err");
    console.error(err);
  }
}

boot();
setInterval(loadMachines, 15000);
