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
const userBtn = document.getElementById("userbtn");
const signin = document.getElementById("signin");

let clerk = null;
let boxes = [];
let current = null;

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
      "x-pi-box-session": current.id,
      ...(await authHeader()),
    };
    const res = await fetch(`/api/chat?session=${encodeURIComponent(current.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, session: current.id, boxId: current.id }),
    });
    if (!res.ok || !res.body) {
      asst.append(`error ${res.status}`);
      setStatus("error", "err");
      return;
    }
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
        else if (event === "error") {
          asst.append("\n" + (payload.message || "error"));
          setStatus("error", "err");
        } else if (event === "done") setStatus(payload.mock ? "mock" : "idle");
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

async function boot() {
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
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
