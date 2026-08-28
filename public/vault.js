(() => {
  const form = document.getElementById("form");
  const kindEl = document.getElementById("kind");
  const status = document.getElementById("status");
  const done = document.getElementById("done");
  const params = new URLSearchParams(location.search);
  const setup = params.get("setup") || "";

  function showKind(kind) {
    for (const k of ["login", "payment", "address", "contact"]) {
      document.getElementById("panel-" + k).classList.toggle("hidden", k !== kind);
    }
  }

  kindEl.addEventListener("change", () => showKind(kindEl.value));
  showKind(kindEl.value);

  async function loadSetup() {
    if (!setup) return;
    document.getElementById("token").value = setup;
    try {
      const res = await fetch("/api/vault/setup-form?setup=" + encodeURIComponent(setup));
      if (!res.ok) {
        status.textContent = "this setup link is unknown or expired";
        status.className = "hint bad";
        return;
      }
      const row = await res.json();
      if (row.kind) {
        kindEl.value = row.kind;
        kindEl.disabled = true;
        showKind(row.kind);
      }
      if (row.label) document.getElementById("label").value = row.label;
      if (row.identifierType) document.getElementById("identifierType").value = row.identifierType;
      if (row.origin) document.getElementById("origin").value = row.origin;
    } catch (err) {
      status.textContent = "could not load setup";
      status.className = "hint bad";
    }
  }

  function secretFields(kind) {
    if (kind === "login") {
      return {
        identifier: document.getElementById("identifier").value,
        password: document.getElementById("password").value,
      };
    }
    if (kind === "payment") {
      return {
        cardholder: document.getElementById("cardholder").value,
        cardNumber: document.getElementById("cardNumber").value,
        expMonth: document.getElementById("expMonth").value,
        expYear: document.getElementById("expYear").value,
        cvc: document.getElementById("cvc").value,
      };
    }
    if (kind === "address") {
      return {
        line1: document.getElementById("line1").value,
        line2: document.getElementById("line2").value,
        city: document.getElementById("city").value,
        region: document.getElementById("region").value,
        postalCode: document.getElementById("postalCode").value,
        country: document.getElementById("country").value,
      };
    }
    return {
      name: document.getElementById("name").value,
      email: document.getElementById("email").value,
      phone: document.getElementById("phone").value,
    };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "";
    status.className = "hint";
    const kind = kindEl.value;
    const body = {
      kind,
      label: document.getElementById("label").value,
      token: document.getElementById("token").value || undefined,
      account: {
        origin: document.getElementById("origin").value,
        identifierType: document.getElementById("identifierType").value,
        identifier: document.getElementById("identifier").value,
        city: document.getElementById("city").value,
        region: document.getElementById("region").value,
        country: document.getElementById("country").value,
        name: document.getElementById("name").value,
      },
      secretFields: secretFields(kind),
    };
    try {
      const res = await fetch("/api/vault/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      form.reset();
      document.getElementById("token").value = "";
      if (!res.ok) {
        status.textContent = "could not save";
        status.className = "hint bad";
        return;
      }
      form.classList.add("hidden");
      done.classList.remove("hidden");
    } catch (err) {
      status.textContent = "could not save";
      status.className = "hint bad";
    }
  });

  loadSetup();
})();
