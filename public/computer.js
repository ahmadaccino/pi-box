/**
 * Standalone computer pane for pi-box browser sessions.
 * Parent includes this later (do not assume app.js / index.html).
 */
(function (global) {
  var STYLE_ID = "pi-box-computer-css";
  var CSS =
    ".pi-computer{display:flex;flex-direction:column;min-height:240px;border:1px solid #2c2922;background:#1b1914;color:#ece7dc;font-family:IBM Plex Sans,ui-sans-serif,system-ui,sans-serif}" +
    ".pi-computer-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid #2c2922;font-family:IBM Plex Mono,ui-monospace,Menlo,monospace;font-size:11px;color:#9a9283}" +
    ".pi-computer-bar a{color:#e6a23c;text-decoration:none}" +
    ".pi-computer-frame,.pi-computer-img{flex:1;width:100%;border:0;background:#12110e;min-height:200px}" +
    ".pi-computer-banner{background:#241f18;color:#e6a23c;padding:6px 10px;font-size:12px}";

  function ensureStyle() {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function liveViewUrl(sessionId, origin) {
    var base = origin || "";
    return base + "/api/browsers/" + encodeURIComponent(sessionId) + "/live";
  }

  function screenshotUrl(sessionId, origin) {
    var base = origin || "";
    return base + "/api/browsers/" + encodeURIComponent(sessionId) + "/screenshot";
  }

  function renderComputerPane(container, sessionId, opts) {
    opts = opts || {};
    ensureStyle();
    container.className = (container.className ? container.className + " " : "") + "pi-computer";
    container.innerHTML = "";
    var bar = document.createElement("div");
    bar.className = "pi-computer-bar";
    var label = document.createElement("span");
    label.textContent = "browser " + sessionId;
    var link = document.createElement("a");
    link.href = liveViewUrl(sessionId, opts.origin || "");
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open live";
    bar.appendChild(label);
    bar.appendChild(link);
    container.appendChild(bar);
    if (opts.takeover) {
      var banner = document.createElement("div");
      banner.className = "pi-computer-banner";
      banner.textContent = "Takeover — finish CAPTCHA / OTP / 3DS, then resume the agent.";
      container.appendChild(banner);
    }
    if (opts.mode === "img") {
      var img = document.createElement("img");
      img.className = "pi-computer-img";
      img.alt = "browser";
      function tick() {
        img.src = screenshotUrl(sessionId, opts.origin || "") + "?t=" + Date.now();
      }
      tick();
      var timer = setInterval(tick, opts.pollMs || 900);
      container._piComputerStop = function () { clearInterval(timer); };
      container.appendChild(img);
    } else {
      var frame = document.createElement("iframe");
      frame.className = "pi-computer-frame";
      frame.title = "browser live view";
      frame.src = liveViewUrl(sessionId, opts.origin || "") + (opts.takeover ? "?takeover=1" : "");
      container.appendChild(frame);
    }
    return container;
  }

  async function listBrowsers(opts) {
    opts = opts || {};
    var res = await fetch((opts.origin || "") + "/api/browsers", { headers: opts.headers || {} });
    if (!res.ok) throw new Error("browsers " + res.status);
    return res.json();
  }

  async function createBrowser(startUrl, opts) {
    opts = opts || {};
    var res = await fetch((opts.origin || "") + "/api/browsers", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, opts.headers || {}),
      body: JSON.stringify({ startUrl: startUrl }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ("create " + res.status));
    return data;
  }

  var api = {
    liveViewUrl: liveViewUrl,
    screenshotUrl: screenshotUrl,
    renderComputerPane: renderComputerPane,
    listBrowsers: listBrowsers,
    createBrowser: createBrowser,
  };
  global.PiBoxComputer = api;
})(typeof window !== "undefined" ? window : globalThis);
