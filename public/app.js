const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const statusEl = document.getElementById("status");

const session =
  localStorage.getItem("pi-box-session") || crypto.randomUUID();
localStorage.setItem("pi-box-session", session);

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

function addUser(text) {
  const wrap = el("article", "msg user");
  wrap.append(el("div", "who", "you"));
  wrap.append(el("div", "bubble", text));
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
}

function addAssistant() {
  const wrap = el("article", "msg assistant");
  wrap.append(el("div", "who", "pi-box"));
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
  addUser(message);
  const asst = addAssistant();
  setStatus("running", "live");
  send.disabled = true;
  try {
    const res = await fetch(`/api/chat?session=${encodeURIComponent(session)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, session }),
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
        else if (event === "status" && payload.state === "mock") {
          setStatus("mock", "live");
        } else if (event === "error") {
          asst.append("\n" + (payload.message || "error"));
          setStatus("error", "err");
        } else if (event === "done") {
          setStatus(payload.mock ? "mock" : "idle");
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

fetch("/healthz")
  .then((r) => r.json())
  .then((j) => setStatus(j.mock ? "mock" : "ready", j.mock ? "live" : ""))
  .catch(() => setStatus("offline", "err"));
