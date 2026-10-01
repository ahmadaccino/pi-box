import { composerAction, composerView } from "./turn-control.js";
import { mountMath, renderMarkdown } from "./markdown.js";
import { backgroundNotice, urlBase64ToUint8Array } from "./notify.js";

const gate = document.getElementById("gate");
const app = document.getElementById("app");
const roster = document.getElementById("roster");
const skillList = document.getElementById("skill-list");
const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const fileInput = document.getElementById("file");
const attachBtn = document.getElementById("attach");
const pendingFiles = document.getElementById("pending-files");
const send = document.getElementById("send");
const stop = document.getElementById("stop");
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
const newbot = document.getElementById("newbot");
const chatsEl = document.getElementById("chats");
const botSettings = document.getElementById("bot-settings");
const botSheet = document.getElementById("bot-sheet");
const botForm = document.getElementById("bot-form");
const showBots = document.getElementById("show-bots");

const BOT_COLORS = ["#e6a23c", "#8fbe8b", "#d36b5e", "#7aa2d6", "#c58bbd", "#d6c48a"];

let clerk = null;
let boxes = [];
let current = null;
let bots = [];
let currentBot = null;
let sessions = [];
let chatSession = localStorage.getItem("pi-box-chat") || "";
let sheetBotId = null;
let sheetColor = BOT_COLORS[0];
let computerSessionId = null;
let computerTimer = null;
let turnLive = false;
let pushReady = false;
let pushPublicKey = "";
const pending = [];

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

function applyComposer() {
  const view = composerView(turnLive);
  if (input) input.placeholder = view.placeholder;
  if (send) {
    send.textContent = view.sendLabel;
    send.disabled = view.sendDisabled;
  }
  if (stop) stop.hidden = view.stopHidden;
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

function renderBots() {
  if (!roster) return;
  roster.innerHTML = "";
  for (const bot of bots) {
    const btn = el("button", "box-row" + (currentBot?.id === bot.id ? " active" : ""));
    btn.type = "button";
    const mark = el("span", "bot-mark");
    mark.style.background = bot.avatarColor || "#e6a23c";
    const copy = el("span", "bot-copy");
    copy.append(el("span", "name", bot.name || bot.id));
    if (bot.description) copy.append(el("span", "caps", bot.description));
    btn.append(mark, copy);
    btn.addEventListener("click", () => {
      selectBot(bot.id);
      document.querySelector("aside")?.classList.remove("open");
    });
    roster.append(btn);
  }
}

function renderChats() {
  if (!chatsEl) return;
  chatsEl.innerHTML = "";
  for (const session of sessions) {
    const btn = el("button", "box-row" + (session.id === chatSession ? " active" : ""));
    btn.type = "button";
    const copy = el("span", "bot-copy");
    copy.append(el("span", "name", session.title || "New chat"));
    btn.append(copy);
    btn.addEventListener("click", () => {
      selectSession(session.id);
      document.querySelector("aside")?.classList.remove("open");
    });
    chatsEl.append(btn);
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
    const chip = el(
      "span",
      "chip" + (s.available ? "" : " off") + (s.source === "user" ? " user" : ""),
      s.source === "user" ? `${s.name} · yours` : s.name,
    );
    chip.title = s.available
      ? s.description
      : `needs ${ (s.missing || s.requires || []).join(", ") }`;
    skillList.append(chip);
  }
}

function applyMeshBox(box) {
  current = box || null;
  if (!current) return;
  renderSkills(current);
  startComputer(current);
}

async function selectBot(id) {
  currentBot = bots.find((bot) => bot.id === id) || bots[0] || null;
  if (!currentBot) return;
  localStorage.setItem("pi-box-bot", currentBot.id);
  boxName.textContent = currentBot.name;
  boxMeta.textContent = currentBot.description || "";
  renderBots();
  await loadSessions();
}

function chatKey(botId) {
  return `pi-box-chat:${botId || "default"}`;
}

async function loadSessions() {
  if (!currentBot) return;
  const res = await fetch(`/api/bots/${encodeURIComponent(currentBot.id)}/sessions`, {
    headers: await authHeader(),
  });
  if (!res.ok) return;
  const data = await res.json();
  sessions = data.sessions || [];
  const saved = localStorage.getItem(chatKey(currentBot.id))
    || (currentBot.id === "default" ? localStorage.getItem("pi-box-chat") : "");
  let session = sessions.find((item) => item.id === saved) || sessions[0];
  if (!session) session = await createSession(saved || "");
  if (!session) session = await createSession("");
  if (session) await selectSession(session.id);
  else renderChats();
}

async function createSession(id) {
  if (!currentBot) return null;
  const body = {};
  if (id) body.id = id;
  const res = await fetch(`/api/bots/${encodeURIComponent(currentBot.id)}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.session && !sessions.some((item) => item.id === data.session.id)) {
    sessions.unshift(data.session);
  }
  return data.session || null;
}

async function selectSession(id) {
  chatSession = id;
  if (currentBot) localStorage.setItem(chatKey(currentBot.id), id);
  renderChats();
  await loadTranscript();
  input?.focus();
}

async function loadTranscript() {
  if (!log || !chatSession) return;
  log.innerHTML = "";
  const res = await fetch(`/api/sessions/${encodeURIComponent(chatSession)}/transcript`, {
    headers: await authHeader(),
  });
  if (!res.ok) return;
  const data = await res.json();
  for (const message of data.messages || []) {
    if (message.role === "user") addUser(message.text || "");
    else {
      const asst = addAssistant();
      asst.append(message.text || "");
    }
  }
}

async function loadBots() {
  const res = await fetch("/api/bots", { headers: await authHeader() });
  if (!res.ok) throw new Error("bots " + res.status);
  const data = await res.json();
  bots = data.bots || [];
  const saved = localStorage.getItem("pi-box-bot");
  const pick = bots.find((bot) => bot.id === saved) || bots.find((bot) => bot.id === "default") || bots[0];
  if (pick) await selectBot(pick.id);
  else renderBots();
}

function addUser(text, files) {
  const wrap = el("article", "msg user");
  wrap.append(el("div", "who", "you"));
  const bubble = el("div", "bubble", text);
  const extra = userAttachments(files);
  if (extra) bubble.append(extra);
  wrap.append(bubble);
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
}

function addAssistant() {
  const wrap = el("article", "msg assistant");
  wrap.append(el("div", "who", currentBot?.name || "pi-box"));
  const bubble = el("div", "bubble");
  wrap.append(bubble);
  log.append(wrap);
  const tools = new Map();
  return {
    wrap,
    bubble,
    raw: "",
    append(delta) {
      this.raw += delta;
      bubble.innerHTML = renderMarkdown(this.raw);
      mountMath(bubble, window.katex);
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
    approval(payload) {
      wrap.insertBefore(approvalCard(payload), bubble);
      log.scrollTop = log.scrollHeight;
    },
    card(payload) {
      const kind = payload.kind || payload.type;
      const node =
        kind === "approval"
          ? approvalCard(payload)
          : kind === "question"
            ? questionCard(payload)
            : kind === "artifact"
              ? artifactCard(payload)
              : draftCard(payload);
      wrap.insertBefore(node, bubble);
      log.scrollTop = log.scrollHeight;
      if (kind === "approval") ping("approval", "Approval needed", payload.summary || "Waiting for you", payload.id);
      else if (kind === "draft") ping("draft", "Ready to send", payload.subject || payload.title || "A draft is waiting", payload.id);
      else if (kind === "question") ping("question", "Question", payload.prompt || "A question is waiting", payload.id);
    },
  };
}

function cardShell(title) {
  const card = el("div", "card");
  card.append(el("div", "card-title", title));
  return card;
}

function approvalCard(payload) {
  const card = cardShell("Approval needed");
  card.classList.add("approval");
  card.append(el("p", "card-summary", payload.summary || `${payload.tool || "tool"} ${payload.target || ""}`));
  const row = el("div", "card-actions");
  const choices = [
    ["allow_once", "Allow once"],
    ["always", "Always allow"],
    ["deny", "Deny"],
  ];
  for (const [decision, label] of choices) {
    const btn = el("button", decision === "deny" ? "ghost" : "", label);
    btn.type = "button";
    btn.addEventListener("click", async () => {
      for (const child of row.querySelectorAll("button")) child.disabled = true;
      try {
        await fetch(`/api/approvals/${encodeURIComponent(payload.id)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await authHeader()) },
          body: JSON.stringify({ decision }),
        });
        card.append(el("p", "card-result", label));
      } catch (err) {
        card.append(el("p", "card-result", String(err)));
      }
    });
    row.append(btn);
  }
  card.append(row);
  return card;
}

function draftCard(payload) {
  const card = cardShell(payload.title || "Ready to send");
  card.classList.add("draft");
  const who = [payload.to, payload.cc].filter(Boolean).join(", ");
  if (payload.channel === "telegram") {
    card.append(el("p", "card-line", `Telegram ${payload.chatId || ""}`.trim()));
  } else if (who) {
    card.append(el("p", "card-line", who));
  }
  if (payload.subject) card.append(el("p", "card-subject", payload.subject));
  card.append(el("pre", "card-body", payload.body || ""));
  const row = el("div", "card-actions");
  const sendBtn = el("button", "", "Send");
  const discardBtn = el("button", "ghost", "Discard");
  sendBtn.type = "button";
  discardBtn.type = "button";
  const act = async (op) => {
    sendBtn.disabled = true;
    discardBtn.disabled = true;
    try {
      const res = await fetch(`/api/outbox/${encodeURIComponent(payload.id)}/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ nonce: payload.nonce }),
      });
      const data = await res.json().catch(() => ({}));
      const label = op === "send" ? (data.sent ? "Sent" : "Send failed") : "Discarded";
      card.append(el("p", "card-result", label));
    } catch (err) {
      card.append(el("p", "card-result", String(err)));
    }
  };
  sendBtn.addEventListener("click", () => act("send"));
  discardBtn.addEventListener("click", () => act("discard"));
  row.append(sendBtn, discardBtn);
  card.append(row);
  return card;
}

function questionCard(payload) {
  const card = cardShell(payload.title || "Question");
  card.classList.add("question");
  card.append(el("p", "card-summary", payload.prompt || ""));
  const selected = new Set();
  const row = el("div", "card-actions");
  const options = Array.isArray(payload.options) ? payload.options : [];
  const custom = document.createElement("input");
  custom.type = "text";
  custom.placeholder = "Your answer";
  custom.hidden = payload.allowCustom === false;
  for (const option of options) {
    const btn = el("button", "ghost", option);
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (payload.multiple) {
        if (selected.has(option)) selected.delete(option);
        else selected.add(option);
        btn.classList.toggle("on", selected.has(option));
      } else {
        selected.clear();
        selected.add(option);
        for (const child of row.querySelectorAll("button")) child.classList.remove("on");
        btn.classList.add("on");
      }
    });
    row.append(btn);
  }
  const submit = el("button", "", "Answer");
  submit.type = "button";
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    const body = { options: [...selected], custom: payload.allowCustom === false ? "" : custom.value };
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(payload.id)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        submit.disabled = false;
        card.append(el("p", "card-result", data.error || "Could not send that answer"));
        return;
      }
      card.append(el("p", "card-result", data.reply || "Sent"));
      addUser(data.reply || "");
    } catch (err) {
      submit.disabled = false;
      card.append(el("p", "card-result", String(err)));
    }
  });
  card.append(row);
  if (!custom.hidden) card.append(custom);
  card.append(submit);
  return card;
}

function artifactCard(payload) {
  const card = cardShell(payload.title || (payload.image ? "Image" : "File"));
  card.classList.add("artifact");
    if (payload.image) {
    const img = document.createElement("img");
    img.alt = payload.name || "image";
    if (payload.src) img.src = payload.src;
    else if (payload.url) {
      void (async () => {
        const res = await fetch(payload.url, { headers: await authHeader() });
        if (!res.ok) return;
        img.src = URL.createObjectURL(await res.blob());
      })();
    }
    card.append(img);
  }
  card.append(el("p", "card-line", payload.name || payload.path || "file"));
  const link = el("button", "ghost", "Download");
  link.type = "button";
  link.addEventListener("click", () => downloadFile(payload));
  card.append(link);
  return card;
}

async function downloadFile(payload) {
  const res = await fetch(payload.url, { headers: await authHeader() });
  if (!res.ok) return;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = payload.name || "download";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result || "");
      const data = result.includes(",") ? result.split(",").pop() : result;
      resolve({ name: file.name || "pasted", type: file.type || "application/octet-stream", data });
    };
    reader.readAsDataURL(file);
  });
}

function renderPending() {
  if (!pendingFiles) return;
  pendingFiles.innerHTML = "";
  for (const file of pending) {
    const chip = el("span", "file-chip", file.name || "file");
    pendingFiles.append(chip);
  }
}

function addPending(files) {
  for (const file of files) {
    if (!file) continue;
    if (!file.name) {
      const ext = (file.type || "application/octet-stream").split("/")[1] || "bin";
      pending.push(new File([file], `pasted.${ext}`, { type: file.type }));
    } else pending.push(file);
  }
  renderPending();
}

function ping(kind, title, body, tag) {
  const notice = backgroundNotice({
    hidden: document.hidden,
    unfocused: typeof document.hasFocus === "function" ? !document.hasFocus() : false,
    kind,
    title,
    body,
    tag: tag ? `${kind}-${tag}` : kind,
  });
  if (!notice) return;
  if (window.piBoxDesktop?.notify) {
    window.piBoxDesktop.notify(notice);
    return;
  }
  if (pushReady) return;
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(notice.title, { body: notice.body, tag: notice.tag });
  }
}

async function ensureNotifyPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* the browser may ignore a permission prompt */
    }
  }
}

async function enablePush(publicKey) {
  if (!publicKey || window.piBoxDesktop || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const res = await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
      body: JSON.stringify(sub.toJSON()),
    });
    pushReady = res.ok;
  } catch {
    pushReady = false;
  }
}

function userAttachments(files) {
  if (!files?.length) return null;
  const row = el("div", "user-files");
  for (const file of files) {
    if (file.type && file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.alt = file.name || "image";
      img.src = URL.createObjectURL(file);
      row.append(img);
    } else {
      row.append(el("span", "file-chip", file.name || "file"));
    }
  }
  return row;
}

async function chat(message, files = []) {
  if (!current || !currentBot || !chatSession) return;
  addUser(message, files);
  const asst = addAssistant();
  turnLive = true;
  applyComposer();
  setStatus("running", "live");
  try {
    const headers = {
      "x-pi-box-session": chatSession,
      ...(await authHeader()),
    };
    let body;
    if (files.length) {
      body = new FormData();
      body.set("message", message);
      body.set("session", chatSession);
      body.set("botId", currentBot.id);
      for (const file of files) body.append("file", file, file.name);
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({
        message,
        session: chatSession,
        botId: currentBot.id,
        boxId: current.id,
      });
    }
    const res = await fetch(`/api/chat?session=${encodeURIComponent(chatSession)}`, {
      method: "POST",
      headers,
      body,
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
        else if (event === "card") asst.card(payload);
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
        }         else if (event === "done") {
          setStatus(payload.waiting ? "waiting" : payload.error ? "error" : payload.mock ? "mock" : "idle");
          if (!payload.waiting && !payload.error) ping("done", "pi-box", payload.mock ? "Mock turn finished" : "Turn finished", "turn");
        }
      }
    }
    if (statusEl.textContent === "running") setStatus("idle");
    await refreshSessionList();
    await refreshSkills();
  } catch (err) {
    asst.append(String(err));
    setStatus("error", "err");
  } finally {
    turnLive = false;
    applyComposer();
    input.focus();
  }
}

async function steerTurn(message, files = []) {
  addUser(message, files);
  try {
    const attachments = [];
    for (const file of files) attachments.push(await fileToAttachment(file));
    const res = await fetch(`/api/sessions/${encodeURIComponent(chatSession)}/steer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pi-box-session": chatSession,
        ...(await authHeader()),
      },
      body: JSON.stringify({ message, attachments }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus(data.error === "idle" ? "idle" : "error", data.error === "idle" ? "" : "err");
    }
  } catch (err) {
    setStatus("error", "err");
    console.error(err);
  }
}

async function stopTurn() {
  if (!turnLive) return;
  try {
    await fetch(`/api/sessions/${encodeURIComponent(chatSession)}/abort`, {
      method: "POST",
      headers: await authHeader(),
    });
    setStatus("stopping", "live");
  } catch (err) {
    setStatus("error", "err");
    console.error(err);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const files = pending.splice(0, pending.length);
  renderPending();
  const action = composerAction(turnLive, input.value, { attachments: files.length });
  if (action.type === "ignore") return;
  input.value = "";
  void ensureNotifyPermission();
  if (action.type === "steer") steerTurn(action.message, files);
  else chat(action.message, files);
});
if (attachBtn && fileInput) {
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addPending(fileInput.files || []);
    fileInput.value = "";
  });
}
if (input) {
  input.addEventListener("paste", (e) => {
    const files = [];
    for (const item of e.clipboardData?.items || []) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    addPending(files);
  });
}
if (form) {
  form.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    form.classList.add("drag");
  });
  form.addEventListener("dragleave", () => form.classList.remove("drag"));
  form.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    form.classList.remove("drag");
    addPending(e.dataTransfer.files);
  });
}
if (stop) stop.addEventListener("click", () => stopTurn());
applyComposer();
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

async function refreshSessionList() {
  if (!currentBot) return;
  try {
    const res = await fetch(`/api/bots/${encodeURIComponent(currentBot.id)}/sessions`, {
      headers: await authHeader(),
    });
    if (!res.ok) return;
    const data = await res.json();
    sessions = data.sessions || [];
    renderChats();
  } catch {
    /* title refresh is optional */
  }
}

async function refreshSkills() {
  try {
    const res = await fetch("/api/skills", { headers: await authHeader() });
    if (!res.ok) return;
    const data = await res.json();
    if (current) current.skills = data.skills || [];
    renderSkills(current);
  } catch {
    /* catalog refresh is optional */
  }
}

async function loadBoxes() {
  if (pushPublicKey) void enablePush(pushPublicKey);
  const res = await fetch("/api/boxes", { headers: await authHeader() });
  if (!res.ok) throw new Error("boxes " + res.status);
  const data = await res.json();
  boxes = data.boxes || [];
  applyMeshBox(boxes[0]);
  await loadMachines();
  await loadBots();
  await pollRoutineFeed();
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
  newchat.addEventListener("click", async () => {
    const session = await createSession("");
    if (!session) return;
    await selectSession(session.id);
    setStatus("new chat");
  });
}

function paintSwatches() {
  const host = document.getElementById("bot-colors");
  if (!host) return;
  host.innerHTML = "";
  for (const color of BOT_COLORS) {
    const btn = el("button", "swatch" + (color === sheetColor ? " on" : ""));
    btn.type = "button";
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener("click", () => {
      sheetColor = color;
      paintSwatches();
    });
    host.append(btn);
  }
}

function openSheet(bot) {
  if (!botSheet || !botForm) return;
  sheetBotId = bot?.id || null;
  sheetColor = bot?.avatarColor || BOT_COLORS[0];
  const title = document.getElementById("bot-sheet-title");
  if (title) title.textContent = bot ? bot.name : "New bot";
  document.getElementById("bot-name").value = bot?.name || "";
  document.getElementById("bot-description").value = bot?.description || "";
  document.getElementById("bot-instructions").value = bot?.instructions || "";
  const del = document.getElementById("bot-delete");
  if (del) del.hidden = !bot || bot.id === "default";
  paintSwatches();
  renderMemory([]);
  botSheet.hidden = false;
  if (bot) loadMemory(bot.id);
}

function closeSheet() {
  if (botSheet) botSheet.hidden = true;
}

function renderMemory(facts) {
  const host = document.getElementById("bot-memory");
  if (!host) return;
  host.innerHTML = "";
  if (!facts.length) {
    host.append(el("p", "lede", sheetBotId ? "No facts yet." : "Save the bot, then facts show up here."));
    return;
  }
  for (const fact of facts) {
    const row = el("div", "memory-row");
    const copy = el("div");
    copy.append(el("p", "", fact.text || ""));
    copy.append(el("p", "memory-kind", fact.kind === "log" ? `log ${fact.at || ""}`.trim() : "profile"));
    const del = el("button", "ghost", "Delete");
    del.type = "button";
    del.addEventListener("click", () => forgetFact(fact.id));
    row.append(copy, del);
    host.append(row);
  }
}

async function loadMemory(botId) {
  try {
    const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/memory`, {
      headers: await authHeader(),
    });
    if (!res.ok) return;
    const data = await res.json();
    const facts = [
      ...(data.profile || []).map((fact) => ({ ...fact, kind: "profile" })),
      ...(data.log || []).map((fact) => ({ ...fact, kind: "log" })),
    ];
    renderMemory(facts);
  } catch {
    /* memory view is optional until the container is up */
  }
}

async function forgetFact(id) {
  if (!sheetBotId || !id) return;
  await fetch(`/api/bots/${encodeURIComponent(sheetBotId)}/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  await loadMemory(sheetBotId);
}

if (newbot) newbot.addEventListener("click", () => openSheet(null));
if (botSettings) {
  botSettings.addEventListener("click", () => {
    if (currentBot) openSheet(currentBot);
  });
}
document.getElementById("bot-sheet-close")?.addEventListener("click", closeSheet);
document.getElementById("bot-delete")?.addEventListener("click", async () => {
  if (!sheetBotId || sheetBotId === "default") return;
  const res = await fetch(`/api/bots/${encodeURIComponent(sheetBotId)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok) return;
  closeSheet();
  await loadBots();
});
botForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    name: document.getElementById("bot-name").value,
    description: document.getElementById("bot-description").value,
    avatarColor: sheetColor,
    instructions: document.getElementById("bot-instructions").value,
  };
  const creating = !sheetBotId;
  const res = await fetch(creating ? "/api/bots" : `/api/bots/${encodeURIComponent(sheetBotId)}`, {
    method: creating ? "POST" : "PATCH",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) return;
  const data = await res.json();
  if (creating && data.bot?.id) localStorage.setItem("pi-box-bot", data.bot.id);
  closeSheet();
  await loadBots();
});
if (showBots) {
  showBots.addEventListener("click", () => {
    document.querySelector("aside")?.classList.toggle("open");
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
  pushPublicKey = cfg.pushPublicKey || "";
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

function readSeenRoutines() {
  try {
    const parsed = JSON.parse(localStorage.getItem("pi-box-routine-seen") || "[]");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

const seenRoutines = readSeenRoutines();

function rememberRoutine(id) {
  seenRoutines.add(id);
  localStorage.setItem("pi-box-routine-seen", JSON.stringify([...seenRoutines].slice(-200)));
}

async function pollRoutineFeed() {
  if (!log || app.hidden) return;
  try {
    const res = await fetch(`/api/routines/feed?session=${encodeURIComponent(chatSession)}`, {
      headers: await authHeader(),
    });
    if (!res.ok) return;
    const data = await res.json();
    const fresh = (data.notices || [])
      .filter((notice) => notice?.id && !seenRoutines.has(notice.id))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const notice of fresh) {
      rememberRoutine(notice.id);
      const wrap = el("article", "msg assistant");
      wrap.append(el("div", "who", "routine"));
      const bubble = el("div", "bubble");
      bubble.innerHTML = renderMarkdown(notice.text || "");
      wrap.append(bubble);
      log.append(wrap);
      const failed = notice.status === "failed";
      ping("routine", failed ? "Routine failed" : "Routine finished", notice.text || notice.name || "", notice.id);
    }
    if (fresh.length) log.scrollTop = log.scrollHeight;
  } catch {
    /* feed is optional until the mesh is up */
  }
}

boot();
setInterval(loadMachines, 15000);
setInterval(pollRoutineFeed, 10000);
