(() => {
  const list = document.getElementById("list");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function statusLabel(status) {
    if (status === "connected") return "connected";
    if (status === "authenticate") return "authenticate";
    if (status === "error") return "error";
    return "—";
  }

  async function authenticate(id) {
    const res = await fetch("/api/plugins/" + encodeURIComponent(id) + "/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      throw new Error(data.error || "authenticate failed");
    }
    location.href = data.url;
  }

  async function load() {
    list.textContent = "loading…";
    try {
      const res = await fetch("/api/plugins");
      if (res.status === 401) {
        list.textContent = "sign in from chat first, then come back.";
        return;
      }
      if (!res.ok) throw new Error("plugins " + res.status);
      const data = await res.json();
      const packs = data.plugins || [];
      list.innerHTML = "";
      if (!packs.length) {
        list.textContent = "no plugin packs indexed";
        return;
      }
      for (const pack of packs) {
        const row = el("div", "row");
        const left = el("div");
        left.append(el("h2", "", pack.name || pack.id));
        left.append(el("p", "", pack.description || ""));
        const st = el("div", "st " + (pack.status || ""), statusLabel(pack.status));
        const right = el("div");
        right.append(st);
        if (pack.status === "authenticate" || pack.status === "error") {
          const btn = el("button", "ghost", "Authenticate");
          btn.type = "button";
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
              await authenticate(pack.id);
            } catch (err) {
              st.textContent = String(err.message || err);
              st.className = "st error";
              btn.disabled = false;
            }
          });
          right.append(btn);
        }
        row.append(left, right);
        list.append(row);
      }
    } catch (err) {
      list.textContent = "could not load plugins";
    }
  }

  load();
})();
