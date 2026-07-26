(function () {
  "use strict";

  const CATEGORIES = {
    income: ["Contribution", "Courier Charges", "Loan Repayment", "Registration Fee", "Other Income"],
    expense: ["Payment to MUT", "Courier Charges", "Lend", "Other Expense"],
  };

  let currency = "₹";
  let Missionary = []; 
  let missionarySearchQuery = "";
  let allTransactions = [];
  // Set when a specific member/month is clicked in the Yearly Contribution table,
  // so the Contributions view can jump straight to the matching entries.
  let ytJumpFilter = null; // { clientId, clientName, year, month, monthLabel } | null

  /* ---------- fetch helpers ---------- */
  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        method: opts.method || "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      
      if (res.status === 401) {
        window.location.href = "/login.html";
        throw new Error("not authenticated");
      }
      
      const data = await res.json().catch(() => ({}));
      
      if (!res.ok) {
        console.error(`❌ API Error [${res.status}] ${path}:`, data);
        const err = new Error(data.error || "request_failed");
        err.data = data;
        throw err;
      }
      return data;
    } catch (e) {
      console.error("❌ Fetch failed:", e);
      throw e;
    }
  }

  /* ---------- Formatting ---------- */
  function fmtMoney(n) {
    const abs = Math.abs(n || 0);
    const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${currency}${formatted}`;
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function initials(name) {
    if (!name) return "";
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
  }
  function avatarHtml(client, size) {
    size = size || "sm";
    if (client.photo) return `<div class="avatar avatar-${size}"><img src="${client.photo}" alt=""></div>`;
    return `<div class="avatar avatar-${size}">${escapeHtml(initials(client.name))}</div>`;
  }
  function clientName(id) {
    const c = Missionary.find((x) => x.id === id);
    return c ? c.name : "";
  }
  function statusLabel(s) {
    return { pending: "Pending", partially_paid: "Partially paid", paid: "Paid" }[s] || s;
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, isError) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.style.background = isError ? "#A63D31" : "";
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 4000); // Increased to 4s for import messages
  }

  /* ---------- View switching ---------- */
  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    document.getElementById("view-" + name).classList.add("is-active");
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.view === name);
    });
    if (name === "entry") document.getElementById("fDate").value = todayISO();
    if (name === "thirdParty") document.getElementById("tpDate").value = todayISO();
    if (name === "courier" && !document.getElementById("couEditId").value) document.getElementById("couSendDate").value = todayISO();
    closeDrawer();
    closePayDrawer();
    renderAll();
  }
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => showView(el.dataset.view));
  });

  /* ============================================
     Dashboard
     ============================================ */
  async function renderDashboard() {
    let d;
    try { d = await api("/api/dashboard"); } catch (e) { return; }

    document.getElementById("sumIncome").textContent = fmtMoney(d.income);
    document.getElementById("sumExpense").textContent = fmtMoney(d.expense);
    document.getElementById("sumBalance").textContent = fmtMoney(d.balance);
    document.getElementById("sidebarBalance").textContent = fmtMoney(d.balance);

    const badge = document.getElementById("overdueBadge");
    if (d.overdueLoans.length) {
      badge.hidden = false;
      badge.textContent = d.overdueLoans.length;
    } else {
      badge.hidden = true;
    }

    const overduePanel = document.getElementById("overduePanel");
    overduePanel.hidden = d.overdueLoans.length === 0;
    document.getElementById("overdueBody").innerHTML = d.overdueLoans.map((l) => `
      <tr>
        <td>${escapeHtml(l.client_name)}</td>
        <td>${fmtDate(l.due_date)}</td>
        <td class="num debit-amt">${fmtMoney(l.outstanding)}</td>
        <td class="col-actions"><button class="link-btn" data-remind="${l.id}">Remind now</button></td>
      </tr>
    `).join("");
    overduePanel.querySelectorAll("[data-remind]").forEach((btn) => {
      btn.addEventListener("click", () => sendReminderNow(btn.dataset.remind));
    });

    const body = document.getElementById("recentBody");
    body.innerHTML = d.recent.map((t) => `
      <tr>
        <td>${fmtDate(t.date)}</td>
        <td class="particulars">${escapeHtml(t.description) || "<span style='color:var(--ink-faint)'>—</span>"}</td>
        <td class="client-cell">${escapeHtml(t.client_name) || "—"}</td>
        <td class="num">${t.type === "income" ? `<span class="credit-amt">${fmtMoney(t.amount)}</span>` : ""}</td>
        <td class="num">${t.type === "expense" ? `<span class="debit-amt">${fmtMoney(t.amount)}</span>` : ""}</td>
      </tr>
    `).join("");
    document.getElementById("recentEmpty").style.display = d.recent.length ? "none" : "block";

    const cbody = document.getElementById("clientBalBody");
    cbody.innerHTML = d.clientBalances.map((b) => `
      <tr>
        <td>${escapeHtml(b.name)}</td>
        <td class="num credit-amt">${fmtMoney(b.received)}</td>
        <td class="num debit-amt">${fmtMoney(b.spent)}</td>
        <td class="num balance-amt ${b.balance < 0 ? "neg" : ""}">${fmtMoney(b.balance)}</td>
      </tr>
    `).join("");
    document.getElementById("clientBalEmpty").style.display = d.clientBalances.length ? "none" : "block";
  }

  async function sendReminderNow(loanId) {
    try {
      const r = await api(`/api/loans/${loanId}/send-reminder`, { method: "POST" });
      if (r.ok) toast("Reminder SMS sent.");
      else if (r.error === "not_configured") toast("Twilio isn't configured yet.", true);
      else toast("Could not send reminder: " + (r.error || "unknown error"), true);
    } catch (e) {
      toast("Could not send reminder.", true);
    }
    renderAll();
  }

  /* ============================================
     New Entry
     ============================================ */
  let entryType = "income";

  function populateCategorySelect() {
    const sel = document.getElementById("fCategory");
    sel.innerHTML = CATEGORIES[entryType].map((c) => `<option value="${c}">${c}</option>`).join("");
  }

  function populateMissionarySelects() {
    const options = `<option value="">Missionaries</option>` +
      Missionary.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    document.getElementById("fClient").innerHTML = options;
    document.getElementById("lClient").innerHTML =
      `<option value="">Select missionaries</option>` +
      Missionary.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

    const filterOptions = `<option value="all">All Missionary</option>` +
      Missionary.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    document.getElementById("filterClient").innerHTML = filterOptions;

    const couClientSel = document.getElementById("couClient");
    if (couClientSel) {
      const prev = couClientSel.value;
      couClientSel.innerHTML = options;
      couClientSel.value = prev;
    }
  }

  document.getElementById("typeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".toggle-btn");
    if (!btn) return;
    entryType = btn.dataset.type;
    document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    document.getElementById("fSubmit").textContent = entryType === "income" ? "Add Income" : "Add Expense";
    populateCategorySelect();
  });

  document.getElementById("entryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById("fAmount").value);
    const date = document.getElementById("fDate").value;
    const category = document.getElementById("fCategory").value;
    const clientId = document.getElementById("fClient").value || null;
    const description = document.getElementById("fDesc").value.trim();
    if (!amount || amount <= 0) return toast("Enter a valid amount.", true);

    try {
      await api("/api/transactions", { 
        method: "POST", 
        body: { type: entryType, amount, date, category, clientId, description } 
      });
      toast(entryType === "income" ? "Income added." : "Expense added.");
      document.getElementById("entryForm").reset();
      document.getElementById("fDate").value = todayISO();
      populateCategorySelect();
      await refreshMissionary();
      await refreshAllTransactions();
      renderAll();
    } catch (err) {
      toast("Could not save entry: " + (err.message || "Unknown error"), true);
    }
  });

  /* ============================================
     Contributions
     ============================================ */
  async function refreshAllTransactions() {
    allTransactions = await api("/api/transactions");
  }

  function computeRunningBalances() {
    const asc = [...allTransactions].sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at));
    let bal = 0;
    const map = {};
    asc.forEach((t) => {
      bal += t.type === "income" ? t.amount : -t.amount;
      map[t.id] = bal;
    });
    return map;
  }

  function renderJumpBanner() {
    const banner = document.getElementById("ContributionsJumpBanner");
    if (!ytJumpFilter) { banner.hidden = true; return; }
    const monthPart = ytJumpFilter.month ? ` — <strong>${escapeHtml(ytJumpFilter.monthLabel)} ${ytJumpFilter.year}</strong>` : ` — <strong>${ytJumpFilter.year}</strong>`;
    document.getElementById("ContributionsJumpText").innerHTML =
      `Showing entries for <strong>${escapeHtml(ytJumpFilter.clientName)}</strong>${monthPart} (from Yearly Contribution)`;
    banner.hidden = false;
  }

  function clearJumpFilter() {
    ytJumpFilter = null;
    renderJumpBanner();
    renderContributions();
  }
  document.getElementById("ContributionsJumpClear").addEventListener("click", clearJumpFilter);

  function renderContributions() {
    const type = document.getElementById("filterType").value;
    const clientId = document.getElementById("filterClient").value;
    const q = document.getElementById("filterSearch").value.trim().toLowerCase();
    const balMap = computeRunningBalances();

    let rows = [...allTransactions].sort((a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at));
    if (type !== "all") rows = rows.filter((t) => t.type === type);
    if (clientId !== "all") rows = rows.filter((t) => t.client_id === clientId);
    if (q) {
      rows = rows.filter((t) =>
        (t.description || "").toLowerCase().includes(q) ||
        (t.category || "").toLowerCase().includes(q) ||
        (clientName(t.client_id) || "").toLowerCase().includes(q)
      );
    }
    if (ytJumpFilter) {
      rows = rows.filter((t) => {
        if (t.client_id !== ytJumpFilter.clientId) return false;
        if (!t.date) return false;
        const [y, m] = t.date.split("-");
        if (parseInt(y, 10) !== ytJumpFilter.year) return false;
        if (ytJumpFilter.month && parseInt(m, 10) !== ytJumpFilter.month) return false;
        return true;
      });
    }
    renderJumpBanner();

    document.getElementById("ContributionsBody").innerHTML = rows.map((t) => `
      <tr>
        <td>${fmtDate(t.date)}</td>
        <td class="particulars">${escapeHtml(t.description) || "—"}</td>
        <td>${escapeHtml(t.category) || "—"}</td>
        <td class="client-cell">${escapeHtml(clientName(t.client_id)) || "—"}</td>
        <td class="num">${t.type === "income" ? `<span class="credit-amt">${fmtMoney(t.amount)}</span>` : ""}</td>
        <td class="num">${t.type === "expense" ? `<span class="debit-amt">${fmtMoney(t.amount)}</span>` : ""}</td>
        <td class="num balance-amt ${balMap[t.id] < 0 ? "neg" : ""}">${fmtMoney(balMap[t.id])}</td>
        <td class="col-actions">
          <button class="icon-btn" title="Attach/view images" data-img-tx="${t.id}">📎</button>
          ${t.loan_id ? "" : `<button class="icon-btn" title="Delete" data-del-tx="${t.id}">✕</button>`}
        </td>
      </tr>
    `).join("");
    document.getElementById("ContributionsEmpty").style.display = rows.length ? "none" : "block";

    document.querySelectorAll("[data-del-tx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this entry?")) return;
        try {
          await api(`/api/transactions/${btn.dataset.delTx}`, { method: "DELETE" });
          toast("Entry deleted.");
          await refreshAllTransactions();
          await refreshMissionary();
          renderAll();
        } catch (err) {
          toast("Could not delete.", true);
        }
      });
    });

    document.querySelectorAll("[data-img-tx]").forEach((btn) => {
      btn.addEventListener("click", () => openImagesDrawer("transaction", btn.dataset.imgTx, "Entry"));
    });
  }

  ["filterType", "filterClient", "filterSearch"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => { ytJumpFilter = null; renderContributions(); });
    el.addEventListener("change", () => { ytJumpFilter = null; renderContributions(); });
  });

  /* ============================================
     Missionary
     ============================================ */
  async function refreshMissionary() {
    Missionary = await api("/api/Missionary");
  }

  function setPhotoPreview(dataUrl, name) {
    const el = document.getElementById("cPhotoPreview");
    document.getElementById("cPhotoRemove").hidden = !dataUrl;
    if (dataUrl) {
      el.innerHTML = `<img src="${dataUrl}" alt="">`;
    } else {
      el.textContent = name ? initials(name) || "+" : "+";
    }
  }

  document.getElementById("cPhoto").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 160;
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        document.getElementById("cPhotoData").value = dataUrl;
        setPhotoPreview(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("cPhotoRemove").addEventListener("click", () => {
    document.getElementById("cPhotoData").value = "";
    setPhotoPreview(null, document.getElementById("cName").value);
  });

  function resetClientForm() {
    document.getElementById("clientForm").reset();
    document.getElementById("cEditId").value = "";
    document.getElementById("cClientId").value = "";
    document.getElementById("cPhotoData").value = "";
    document.getElementById("cSubmit").textContent = "Add Client";
    document.getElementById("cCancel").hidden = true;
    setPhotoPreview(null, "");
  }

  async function prefillSuggestedClientId() {
    try {
      const { member_id } = await api("/api/Missionary/next-id");
      document.getElementById("cClientId").value = member_id;
    } catch (e) { /* leave blank if it fails; admin can type their own */ }
  }

  document.getElementById("cCancel").addEventListener("click", () => {
    resetClientForm();
    prefillSuggestedClientId();
  });

  document.getElementById("clientForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editId = document.getElementById("cEditId").value;
    const payload = {
      name: document.getElementById("cName").value.trim(),
      member_id: document.getElementById("cClientId").value.trim(),
      company: document.getElementById("cCompany").value.trim(),
      email: document.getElementById("cEmail").value.trim(),
      phone: document.getElementById("cPhone").value.trim(),
      YWAM: document.getElementById("cYWAM").value.trim(),
      notes: document.getElementById("cNotes").value.trim(),
      photo: document.getElementById("cPhotoData").value || null,
    };
    if (!payload.name) return toast("Name is required.", true);

    try {
      if (editId) {
        await api(`/api/Missionary/${editId}`, { method: "PUT", body: payload });
        toast("Client updated.");
      } else {
        await api("/api/Missionary", { method: "POST", body: payload });
        toast("Client added.");
      }
      resetClientForm();
      await refreshMissionary();
      renderAll();
      await prefillSuggestedClientId();
    } catch (err) {
      if (err.data?.error === "duplicate_client_id") {
        toast(err.data.message || "That MUT ID is already in use.", true);
      } else {
        toast("Could not save client: " + (err.message || "Unknown error"), true);
      }
    }
  });

  // Matches a client against the search query across every field an admin
  // would plausibly search by. Case-insensitive, and tolerant of the query
  // having extra spaces (e.g. pasted from somewhere).
  function missionaryMatchesQuery(c, query) {
    if (!query) return true;
    const haystack = [c.name, c.member_id, c.phone, c.email, c.company, c.YWAM]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }

  function getFilteredMissionary() {
    const query = missionarySearchQuery.trim().toLowerCase();
    if (!query) return Missionary;
    return Missionary.filter((c) => missionaryMatchesQuery(c, query));
  }

  function renderMissionary() {
    const body = document.getElementById("MissionaryBody");
    const filtered = getFilteredMissionary();

    body.innerHTML = filtered.map((c) => `
      <tr>
        <td>${avatarHtml(c, "sm")}</td>
        <td><button class="link-btn" data-open-client="${c.id}">${escapeHtml(c.name)}</button></td>
        <td>${escapeHtml(c.member_id || "—")}</td>
        <td>${escapeHtml(c.phone || c.email || "—")}</td>
        <td class="num balance-amt ${c.balance < 0 ? "neg" : ""}">${fmtMoney(c.balance)}</td>
        <td class="col-actions">
          <button class="icon-btn" title="Edit" data-edit-client="${c.id}">✎</button>
          <button class="icon-btn" title="Delete" data-del-client="${c.id}">✕</button>
        </td>
      </tr>
    `).join("");

    // "No Missionary yet" only makes sense when the whole list is empty;
    // if there IS data but the search matched nothing, show a distinct
    // "no results" message instead so admins don't think they lost data.
    const hasAny = Missionary.length > 0;
    const hasQuery = missionarySearchQuery.trim().length > 0;
    document.getElementById("MissionaryEmpty").style.display = (!hasAny && !hasQuery) ? "block" : "none";
    const searchEmptyEl = document.getElementById("MissionarySearchEmpty");
    if (searchEmptyEl) {
      searchEmptyEl.hidden = !(hasAny && hasQuery && filtered.length === 0);
    }

    body.querySelectorAll("[data-open-client]").forEach((b) => b.addEventListener("click", () => openClientDrawer(b.dataset.openClient)));
    body.querySelectorAll("[data-edit-client]").forEach((b) => b.addEventListener("click", () => editClient(b.dataset.editClient)));
    body.querySelectorAll("[data-del-client]").forEach((b) => b.addEventListener("click", () => deleteClient(b.dataset.delClient)));
  }

  const missionarySearchEl = document.getElementById("missionarySearch");
  const missionarySearchClearEl = document.getElementById("missionarySearchClear");
  if (missionarySearchEl) {
    missionarySearchEl.addEventListener("input", () => {
      missionarySearchQuery = missionarySearchEl.value;
      if (missionarySearchClearEl) missionarySearchClearEl.hidden = !missionarySearchQuery.trim();
      renderMissionary();
    });
  }
  if (missionarySearchClearEl) {
    missionarySearchClearEl.addEventListener("click", () => {
      missionarySearchQuery = "";
      if (missionarySearchEl) missionarySearchEl.value = "";
      missionarySearchClearEl.hidden = true;
      renderMissionary();
      missionarySearchEl?.focus();
    });
  }

  function editClient(id) {
    const c = Missionary.find((x) => x.id === id);
    if (!c) return;
    document.getElementById("cEditId").value = c.id;
    document.getElementById("cName").value = c.name;
    document.getElementById("cCompany").value = c.company || "";
    document.getElementById("cEmail").value = c.email || "";
    document.getElementById("cPhone").value = c.phone || "";
    document.getElementById("cClientId").value = c.member_id || "";
    document.getElementById("cYWAM").value = c.YWAM || "";
    document.getElementById("cNotes").value = c.notes || "";
    document.getElementById("cPhotoData").value = c.photo || "";
    setPhotoPreview(c.photo, c.name);
    document.getElementById("cSubmit").textContent = "Save changes";
    document.getElementById("cCancel").hidden = false;
    showView("Missionary");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteClient(id) {
    if (!confirm("Delete this client and all their entries and loans? This cannot be undone.")) return;
    try {
      await api(`/api/Missionary/${id}`, { method: "DELETE" });
      toast("Client deleted.");
      await refreshMissionary();
      await refreshAllTransactions();
      renderAll();
    } catch (err) {
      toast("Could not delete client.", true);
    }
  }

  /* ---------- Client profile drawer ---------- */
  function openDrawer() {
    document.getElementById("drawerOverlay").classList.add("is-visible");
    document.getElementById("clientDrawer").classList.add("is-open");
  }
  function closeDrawer() {
    document.getElementById("drawerOverlay").classList.remove("is-visible");
    document.getElementById("clientDrawer").classList.remove("is-open");
  }
  document.getElementById("drawerOverlay").addEventListener("click", closeDrawer);
  document.getElementById("drawerClose").addEventListener("click", closeDrawer);

  async function openClientDrawer(id) {
    let c;
    try { c = await api(`/api/Missionary/${id}`); } catch (e) { return toast("Could not load client.", true); }
    const portalUrl = `${window.location.origin}/portal.html?token=${c.portal_token}`;

    const loanRows = c.loans.map((l) => {
      const paid = l.paid || 0;
      const outstanding = l.amount - paid;
      const overdue = l.status !== "paid" && l.due_date < todayISO();
      return `<tr>
        <td>${fmtDate(l.due_date)}</td>
        <td class="num">${fmtMoney(l.amount)}</td>
        <td class="num">${fmtMoney(outstanding)}</td>
        <td><span class="status-pill ${overdue ? "overdue" : l.status}">${overdue ? "Overdue" : statusLabel(l.status)}</span></td>
      </tr>`;
    }).join("") || `<tr><td colspan="4" style="color:var(--ink-faint)">No loans yet.</td></tr>`;

    const txRows = c.transactions.slice(0, 12).map((t) => `
      <tr>
        <td>${fmtDate(t.date)}</td>
        <td class="particulars">${escapeHtml(t.description) || t.category || "—"}</td>
        <td class="num">${t.type === "income" ? `<span class="credit-amt">${fmtMoney(t.amount)}</span>` : `<span class="debit-amt">${fmtMoney(t.amount)}</span>`}</td>
      </tr>
    `).join("") || `<tr><td colspan="3" style="color:var(--ink-faint)">No activity yet.</td></tr>`;

    document.getElementById("drawerBody").innerHTML = `
      <div class="profile-head">
        ${avatarHtml(c, "lg")}
        <div>
          <h2>${escapeHtml(c.name)}</h2>
          <p class="view-sub">${escapeHtml(c.company || "")}</p>
          <p class="view-sub">MUT ID: <strong>${escapeHtml(c.member_id || "—")}</strong></p>
        </div>
      </div>

      <div class="summary-row" style="margin-top:20px;">
        <div class="summary-card credit"><span class="summary-label">Received</span><span class="summary-amount">${fmtMoney(c.received)}</span></div>
        <div class="summary-card debit"><span class="summary-label">Expenses/Lent</span><span class="summary-amount">${fmtMoney(c.spent)}</span></div>
        <div class="summary-card balance"><span class="summary-label">Balance</span><span class="summary-amount">${fmtMoney(c.balance)}</span></div>
      </div>

      <h2 style="margin-top:24px;">Withdraw savings</h2>
      <p class="settings-note">For emergencies — pays the member back out of their own saved balance (${fmtMoney(c.balance)} available). No extra money is added.</p>
      <div class="form-row" style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <label class="field" style="max-width:140px;">
          <span>Amount</span>
          <input type="number" id="wdAmount" min="1" step="0.01" max="${c.balance}" placeholder="0.00">
        </label>
        <label class="field" style="max-width:160px;">
          <span>Date</span>
          <input type="date" id="wdDate" value="${todayISO()}">
        </label>
        <label class="field field-wide" style="flex:1; min-width:160px;">
          <span>Note (optional)</span>
          <input type="text" id="wdNote" placeholder="Reason for withdrawal">
        </label>
        <button class="btn btn-primary" id="wdSubmit">Withdraw</button>
      </div>

      <h2 style="margin-top:24px;">Missionary self-service link</h2>
      <p class="settings-note">Send this link to the client — they can view their balance and loans, and mark a loan as paid.</p>
      <div class="portal-link-box">
        <span style="flex:1;">${portalUrl}</span>
        <button class="btn btn-ghost small" id="copyPortalLink">Copy</button>
      </div>
      <div class="form-actions" style="margin-top:10px;">
        <button class="btn btn-ghost small" id="regenLink">Regenerate link</button>
      </div>

      <h2 style="margin-top:24px;">Send a text</h2>
      <div class="form-actions">
        <input type="text" id="smsMsg" placeholder="Message…" style="flex:1; padding:8px; border:1px solid var(--line); border-radius:var(--radius);"
          value="Hi ${c.name}, this is a reminder about your account with us. View details: ${portalUrl}">
        <a class="btn btn-primary" id="smsLink" href="sms:${c.phone || ""}">Open messaging app</a>
      </div>

      <h2 style="margin-top:24px;">Loans</h2>
      <div class="table-wrap">
        <table class="Contributions-table">
          <thead><tr><th>Due</th><th class="num">Amount</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
          <tbody>${loanRows}</tbody>
        </table>
      </div>

      <h2 style="margin-top:24px;">Recent activity</h2>
      <div class="table-wrap">
        <table class="Contributions-table">
          <thead><tr><th>Date</th><th>Particulars</th><th class="num">Amount</th></tr></thead>
          <tbody>${txRows}</tbody>
        </table>
      </div>
    `;

    document.getElementById("copyPortalLink").addEventListener("click", () => {
      navigator.clipboard.writeText(portalUrl).then(() => toast("Link copied."));
    });
    document.getElementById("regenLink").addEventListener("click", async () => {
      if (!confirm("This invalidates the old link. Continue?")) return;
      await api(`/api/Missionary/${id}/regenerate-link`, { method: "POST" });
      toast("New link generated.");
      openClientDrawer(id);
    });
    document.getElementById("smsMsg").addEventListener("input", (e) => {
      document.getElementById("smsLink").href = `sms:${c.phone || ""}?&body=${encodeURIComponent(e.target.value)}`;
    });
    document.getElementById("smsLink").href = `sms:${c.phone || ""}?&body=${encodeURIComponent(document.getElementById("smsMsg").value)}`;

    document.getElementById("wdSubmit").addEventListener("click", async () => {
      const amount = parseFloat(document.getElementById("wdAmount").value);
      const date = document.getElementById("wdDate").value;
      const note = document.getElementById("wdNote").value;
      if (!amount || amount <= 0) return toast("Enter a valid withdrawal amount.", true);
      try {
        await api(`/api/Missionary/${id}/withdraw`, { method: "POST", body: { amount, date, note } });
        toast("Withdrawal recorded.");
        await refreshMissionary();
        await refreshAllTransactions();
        openClientDrawer(id);
        renderAll();
      } catch (err) {
        toast(err.data?.message || "Could not record withdrawal.", true);
      }
    });

    openDrawer();
  }

  /* ============================================
     Loans
     ============================================ */
  let allLoans = [];

  document.getElementById("loanForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const clientId = document.getElementById("lClient").value;
    const amount = parseFloat(document.getElementById("lAmount").value);
    const dateGiven = document.getElementById("lDateGiven").value;
    const dueDate = document.getElementById("lDueDate").value;
    const description = document.getElementById("lNote").value.trim();
    if (!clientId) return toast("Choose a client.", true);
    if (!amount || amount <= 0) return toast("Enter a valid amount.", true);
    if (!dueDate) return toast("Set a due date.", true);

    try {
      await api("/api/loans", { method: "POST", body: { clientId, amount, dateGiven, dueDate, description } });
      toast("Loan recorded.");
      document.getElementById("loanForm").reset();
      document.getElementById("lDateGiven").value = todayISO();
      await refreshAllTransactions();
      await refreshMissionary();
      renderAll();
    } catch (err) {
      toast("Could not save loan: " + (err.message || "Unknown error"), true);
    }
  });

  async function refreshLoans() {
    const status = document.getElementById("loanFilterStatus").value;
    allLoans = await api(`/api/loans${status !== "all" ? `?status=${status}` : ""}`);
  }

  function renderLoans() {
    const body = document.getElementById("loansBody");
    body.innerHTML = allLoans.map((l) => {
      const overdue = l.status !== "paid" && l.due_date < todayISO();
      return `<tr>
        <td>${escapeHtml(l.client_name)}</td>
        <td>${fmtDate(l.date_given)}</td>
        <td>${fmtDate(l.due_date)}</td>
        <td class="num">${fmtMoney(l.amount)}</td>
        <td class="num credit-amt">${fmtMoney(l.paid)}</td>
        <td class="num debit-amt">${fmtMoney(l.outstanding)}</td>
        <td><span class="status-pill ${overdue ? "overdue" : l.status}">${overdue ? "Overdue" : statusLabel(l.status)}</span></td>
        <td class="col-actions">
          ${l.status !== "paid" ? `<button class="link-btn" data-pay-loan="${l.id}">Record payment</button>` : ""}
          ${overdue ? `<button class="link-btn" data-remind-loan="${l.id}">Remind now</button>` : ""}
          <button class="icon-btn" title="Delete loan" data-del-loan="${l.id}">✕</button>
        </td>
      </tr>`;
    }).join("");
    document.getElementById("loansEmpty").style.display = allLoans.length ? "none" : "block";

    body.querySelectorAll("[data-pay-loan]").forEach((b) => b.addEventListener("click", () => openPayDrawer(b.dataset.payLoan)));
    body.querySelectorAll("[data-remind-loan]").forEach((b) => b.addEventListener("click", () => sendReminderNow(b.dataset.remindLoan)));
    body.querySelectorAll("[data-del-loan]").forEach((b) => b.addEventListener("click", () => deleteLoan(b.dataset.delLoan)));
  }

  async function deleteLoan(loanId) {
    const loan = allLoans.find((l) => l.id === loanId);
    const label = loan ? `${loan.client_name}'s ${fmtMoney(loan.amount)} loan` : "this loan";
    const paidNote = loan && loan.paid > 0
      ? ` This will also remove ${fmtMoney(loan.paid)} in recorded repayments against it.`
      : "";
    if (!confirm(`Delete ${label}? This cannot be undone.${paidNote}`)) return;

    try {
      await api(`/api/loans/${loanId}`, { method: "DELETE" });
      toast("Loan deleted.");
      await refreshLoans();
      renderLoans();
    } catch (err) {
      toast("Could not delete loan: " + (err.message || "Unknown error"), true);
    }
  }

  document.getElementById("loanFilterStatus").addEventListener("change", async () => {
    await refreshLoans();
    renderLoans();
  });

  /* ---------- Record-payment drawer ---------- */
  function openPayOverlay() {
    document.getElementById("payOverlay").classList.add("is-visible");
    document.getElementById("payDrawer").classList.add("is-open");
  }
  function closePayDrawer() {
    document.getElementById("payOverlay").classList.remove("is-visible");
    document.getElementById("payDrawer").classList.remove("is-open");
  }
  document.getElementById("payOverlay").addEventListener("click", closePayDrawer);
  document.getElementById("payClose").addEventListener("click", closePayDrawer);

  async function openPayDrawer(loanId) {
    let loan;
    try { loan = await api(`/api/loans/${loanId}`); } catch (e) { return toast("Could not load loan.", true); }

    document.getElementById("payBody").innerHTML = `
      <h2>Record a payment</h2>
      <p class="view-sub">${escapeHtml(loan.client_name)} — outstanding ${fmtMoney(loan.outstanding)} (due ${fmtDate(loan.due_date)})</p>
      <form id="payForm">
        <div class="form-grid">
          <label class="field">
            <span>Amount received</span>
            <input type="number" id="pAmount" step="0.01" min="0.01" max="${loan.outstanding}" value="${loan.outstanding}" required>
          </label>
          <label class="field">
            <span>Date</span>
            <input type="date" id="pDate" value="${todayISO()}" required>
          </label>
          <label class="field field-wide">
            <span>Note <em>(optional)</em></span>
            <input type="text" id="pNote" placeholder="Cash, UPI reference, etc.">
          </label>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save payment</button>
        </div>
      </form>
      <h2 style="margin-top:22px;">Payment history</h2>
      <div class="table-wrap">
        <table class="Contributions-table">
          <thead><tr><th>Date</th><th class="num">Amount</th><th>Via</th></tr></thead>
          <tbody>${loan.payments.map((p) => `<tr><td>${fmtDate(p.date)}</td><td class="num">${fmtMoney(p.amount)}</td><td>${p.source === "portal" ? "Client portal" : "Admin"}</td></tr>`).join("") || `<tr><td colspan="3" style="color:var(--ink-faint)">No payments yet.</td></tr>`}</tbody>
        </table>
      </div>
    `;

    document.getElementById("payForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const amount = parseFloat(document.getElementById("pAmount").value);
      const date = document.getElementById("pDate").value;
      const note = document.getElementById("pNote").value.trim();
      try {
        await api(`/api/loans/${loanId}/payments`, { method: "POST", body: { amount, date, note } });
        toast("Payment recorded.");
        closePayDrawer();
        await refreshAllTransactions();
        await refreshMissionary();
        await refreshLoans();
        renderAll();
      } catch (err) {
        toast("Could not save payment.", true);
      }
    });

    openPayOverlay();
  }

  /* ============================================
     Verify Payments (screenshot / OCR proof review)
     ============================================ */
  async function loadVerifyPayments() {
    const body = document.getElementById("verifyBody");
    body.innerHTML = `<tr><td colspan="6" class="empty-note">Loading pending payments…</td></tr>`;
    let payments;
    try {
      payments = await api("/api/verify-payments");
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6" class="empty-note">Could not load pending payments.</td></tr>`;
      return;
    }
    renderVerifyTable(payments);
  }

  function renderVerifyTable(payments) {
    const body = document.getElementById("verifyBody");
    const empty = document.getElementById("verifyEmpty");

    if (!payments.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    body.innerHTML = payments.map((p) => {
      const declared = fmtMoney(p.amount);
      const ocr = p.ocr_amount ? fmtMoney(p.ocr_amount) : "—";
      const matchBadge = p.ocr_match
        ? `<span class="status-pill paid">✓ Matches</span>`
        : `<span class="status-pill overdue">⚠ Check amount</span>`;
      const receipt = p.screenshot_url
        ? `<a href="${p.screenshot_url}" target="_blank" rel="noopener">View</a>`
        : "—";
      const uploaded = p.uploaded_at ? fmtDate(String(p.uploaded_at).slice(0, 10)) : "—";
      return `
        <tr>
          <td>${uploaded}</td>
          <td>${escapeHtml(p.client_name)}<br><span style="color:var(--ink-faint); font-size:12px;">${escapeHtml(p.client_member_id || "")}</span></td>
          <td class="num">${declared}</td>
          <td class="num">${ocr}<br>${matchBadge}</td>
          <td>${receipt}</td>
          <td class="col-actions">
            <button class="btn btn-primary small" data-approve-proof="${p.id}">Approve</button>
            <button class="btn btn-ghost small" data-reject-proof="${p.id}">Reject</button>
          </td>
        </tr>
      `;
    }).join("");

    body.querySelectorAll("[data-approve-proof]").forEach((b) =>
      b.addEventListener("click", () => approveProof(b.dataset.approveProof))
    );
    body.querySelectorAll("[data-reject-proof]").forEach((b) =>
      b.addEventListener("click", () => rejectProof(b.dataset.rejectProof))
    );
  }

  async function approveProof(id) {
    if (!confirm("Approve this payment? This will update the client's balance.")) return;
    try {
      await api(`/api/approve-payment/${id}`, { method: "POST" });
      toast("Payment approved and balance updated.");
      await refreshMissionary();
      await refreshAllTransactions();
      await loadVerifyPayments();
      renderAll();
    } catch (err) {
      toast("Could not approve payment.", true);
    }
  }

  async function rejectProof(id) {
    const remarks = prompt("Reason for rejecting (optional):") || "Rejected by admin";
    try {
      await api(`/api/reject-payment/${id}`, { method: "POST", body: { remarks } });
      toast("Payment rejected.");
      await loadVerifyPayments();
    } catch (err) {
      toast("Could not reject payment.", true);
    }
  }

  document.getElementById("btnRefreshVerify").addEventListener("click", loadVerifyPayments);

  /* ============================================
     Yearly Contribution Target
     (min ₹100/month, ₹1200/year per member)
     ============================================ */
  const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let ytData = null; // last-fetched raw month-wise data for the selected year
  let ytYearsPopulated = false;

  function populateYtYears() {
    if (ytYearsPopulated) return;
    ytYearsPopulated = true;
    const sel = document.getElementById("ytYear");
    const current = new Date().getFullYear();
    const years = [];
    for (let y = current + 5; y >= current - 2; y--) years.push(y);
    sel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    sel.value = String(current);
  }

  async function fetchYtData() {
    const year = document.getElementById("ytYear").value;
    try {
      ytData = await api(`/api/reports/yearly-contributions?year=${year}`);
    } catch (e) {
      ytData = null;
      toast("Could not load yearly contributions.", true);
    }
  }

  function renderYearlyTarget() {
    if (!ytData) return;
    const monthlyTarget = parseFloat(document.getElementById("ytMonthlyTarget").value) || 0;
    const yearlyTarget = parseFloat(document.getElementById("ytYearlyTarget").value) || 0;
    const keyword = document.getElementById("ytSearch").value.trim().toLowerCase();

    const filteredMembers = ytData.members.filter(mem => {
      return (
        (mem.name || "").toLowerCase().includes(keyword) ||
        (mem.member_id || "").toLowerCase().includes(keyword)
      );
    });

    document.getElementById("ytYearLabel").textContent = ytData.year;

    // ---- table head ----
    const headRow = document.getElementById("ytTableHeadRow");
    headRow.innerHTML = `<th class="sticky-col">Member</th><th>YWAM Branch</th>` +
      MONTH_LABELS.map((m) => `<th>${m}</th>`).join("") +
      `<th>Total Paid</th><th>Due</th><th>Status</th>`;

    // ---- table body + per-member computations ----
    // totalCollected/totalNetSaved come straight from the API response
    // (ytData.totalCollected / ytData.totalNetSaved), NOT summed from the
    // member rows here — the API total already has this year's Third-Party
    // Payments subtracted from it, which a client-side sum of only member
    // rows could never reflect (third-party payments aren't tied to any
    // member). totalPending still comes from summing each member's own
    // pending amount, since that's a per-client figure.
    const totalCollected = ytData.totalCollected || 0;
    const totalNetSaved = ytData.totalNetSaved || 0;
    let totalPending = 0;
    let paidCount = 0, partialCount = 0, noneCount = 0;
    let paidPendingSum = 0, partialPendingSum = 0, nonePendingSum = 0;

    const bodyRows = filteredMembers.map((mem) => {
      const pending = Math.max(0, yearlyTarget - mem.netSaved);
      totalPending += pending;

      let statusClass, statusLabel;
      if (mem.netSaved >= yearlyTarget && yearlyTarget > 0) {
        statusClass = "paid"; statusLabel = "Completed";
        paidCount++; paidPendingSum += pending;
      } else if (mem.netSaved > 0) {
        statusClass = "partially_paid"; statusLabel = "Partial";
        partialCount++; partialPendingSum += pending;
      } else {
        statusClass = "pending"; statusLabel = "Not started";
        noneCount++; nonePendingSum += pending;
      }

      const monthCells = MONTH_LABELS.map((_, i) => {
        const amt = mem.monthly[i + 1] || 0;
        let cls = "zero";
        if (amt >= monthlyTarget && monthlyTarget > 0) cls = "met";
        else if (amt > 0) cls = "under";
        return `<td class="month-cell ${cls} is-clickable" data-yt-jump="${mem.id}" data-yt-month="${i + 1}" title="View ${escapeHtml(mem.name)}'s ${MONTH_LABELS[i]} entries in Contributions">${amt ? fmtMoney(amt) : "—"}</td>`;
      }).join("");

      return `
        <tr>
          <td class="sticky-col is-clickable" data-yt-jump="${mem.id}" title="View all of ${escapeHtml(mem.name)}'s entries in Contributions">
            <span class="member-name">${escapeHtml(mem.name)}</span>
            <span class="member-id">${escapeHtml(mem.member_id || "")}</span>
          </td>
          <td>${escapeHtml(mem.YWAM || "—")}</td>
          ${monthCells}
          <td class="yt-total-paid">${fmtMoney(mem.totalPaid)}</td>
          <td class="${pending > 0 ? "yt-pending is-due" : "yt-pending is-clear"}">${fmtMoney(pending)}</td>
          <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        </tr>
      `;
    }).join("");

    document.getElementById("ytTableBody").innerHTML = bodyRows;
    document.getElementById("ytEmpty").hidden = ytData.members.length > 0;

    // ---- table foot (month-wise totals across all members) ----
    const footMonthCells = MONTH_LABELS.map((_, i) => {
      const total = ytData.totalsByMonth[i + 1] || 0;
      return `<td>${total ? fmtMoney(total) : "—"}</td>`;
    }).join("");
    document.getElementById("ytTableFoot").innerHTML = `
      <tr>
        <td class="sticky-col">Total</td>
        <td></td>
        ${footMonthCells}
        <td>${fmtMoney(totalCollected)}</td>
        <td>${fmtMoney(totalNetSaved)}</td>
        <td>${fmtMoney(totalPending)}</td>
        <td></td>
      </tr>
    `;

    // ---- summary cards ----
    const totalTarget = ytData.memberCount * yearlyTarget;
    document.getElementById("ytTotalCollected").textContent = fmtMoney(totalNetSaved);
    document.getElementById("ytTotalPending").textContent = fmtMoney(totalPending);
    document.getElementById("ytTotalTarget").textContent = fmtMoney(totalTarget);

    // ---- pending overview ----
    document.getElementById("ytStatusGrid").innerHTML = `
      <div class="yt-status-card paid">
        <span class="yt-status-count">${paidCount}</span>
        <span class="yt-status-label">Completed ₹${yearlyTarget || 0}</span>
        <span class="yt-status-sub">${fmtMoney(paidPendingSum)} pending</span>
      </div>
      <div class="yt-status-card partial">
        <span class="yt-status-count">${partialCount}</span>
        <span class="yt-status-label">Partially paid</span>
        <span class="yt-status-sub">${fmtMoney(partialPendingSum)} pending</span>
      </div>
      <div class="yt-status-card none">
        <span class="yt-status-count">${noneCount}</span>
        <span class="yt-status-label">Not started</span>
        <span class="yt-status-sub">${fmtMoney(nonePendingSum)} pending</span>
      </div>
    `;
  }

  async function loadAndRenderYearlyTarget() {
    populateYtYears();
    await fetchYtData();
    renderYearlyTarget();
  }

  document.getElementById("ytYear").addEventListener("change", loadAndRenderYearlyTarget);
  document.getElementById("ytMonthlyTarget").addEventListener("input", renderYearlyTarget);
  document.getElementById("ytYearlyTarget").addEventListener("input", renderYearlyTarget);
  document.getElementById("ytSearch").addEventListener("input", renderYearlyTarget);

  // Clicking a member name or a month cell in the Yearly Contribution table jumps
  // to Contributions, filtered to that same member (and month, if a month
  // cell was clicked) — so the payment shows up in both places.
  document.getElementById("ytTableBody").addEventListener("click", (e) => {
    const cell = e.target.closest("[data-yt-jump]");
    if (!cell || !ytData) return;
    const clientId = cell.dataset.ytJump;
    const mem = ytData.members.find((m) => m.id === clientId);
    if (!mem) return;
    const month = cell.dataset.ytMonth ? parseInt(cell.dataset.ytMonth, 10) : null;

    ytJumpFilter = {
      clientId,
      clientName: mem.name,
      year: parseInt(ytData.year, 10),
      month,
      monthLabel: month ? MONTH_LABELS[month - 1] : "",
    };

    document.getElementById("filterType").value = "income";
    document.getElementById("filterClient").value = clientId;
    document.getElementById("filterSearch").value = "";
    showView("Contributions");
  });
/* ---------- Export Yearly Contribution as CSV ---------- */

function exportYearlyTargetCsv() {
  const year = document.getElementById("ytYear").value;
  window.location.href =
    `/api/reports/yearly-contributions/export?year=${year}`;
}

document
  .getElementById("ytExportCsv")
  .addEventListener("click", exportYearlyTargetCsv);

function exportYearlyTargetPdf() {
  const year = document.getElementById("ytYear").value;
  window.location.href =
    `/api/reports/yearly-contributions/export-pdf?year=${year}`;
}

document
  .getElementById("ytExportPdf")
  .addEventListener("click", exportYearlyTargetPdf);
   /* ---------- Import Yearly Contribution from CSV ---------- */
  const ytImportInput = document.getElementById("ytImportCsv");
  if (ytImportInput) {
    ytImportInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!confirm(`Import contributions from "${file.name}"?\n\nThis will update existing monthly records, create new ones where needed, and automatically create any missing Missionary members.`)) {
        e.target.value = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        const csvText = event.target.result;
        const year = document.getElementById("ytYear").value;

        try {
          toast("Checking for missing members... Please wait.", false);
          
          // 1. Refresh the local Missionary list from the server to ensure it's 100% up to date
          await refreshMissionary();
          populateMissionarySelects();

          // Robust CSV line parser (handles names with commas inside quotes)
          const parseCSVLine = (line) => {
            const result = [];
            let current = "";
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
              const char = line[i];
              if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                  current += '"';
                  i++; // skip escaped quote
                } else {
                  inQuotes = !inQuotes;
                }
              } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = "";
              } else {
                current += char;
              }
            }
            result.push(current.trim());
            return result;
          };

          const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== "");
          if (lines.length < 2) {
            toast("CSV is empty or invalid.", true);
            e.target.value = "";
            return;
          }

          const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
          const memberIdIdx = headers.findIndex(h => h === "member id");
          const nameIdx = headers.findIndex(h => h === "name");
          const ywamIdx = headers.findIndex(h => h === "ywam");

          if (memberIdIdx === -1 || nameIdx === -1) {
            toast('CSV must have "Member ID" and "Name" columns.', true);
            e.target.value = "";
            return;
          }

          let createdCount = 0;

          // 2. Ensure all Missionary members exist before importing contributions
          for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i]);
            if (cols.length < 2) continue;

            const memberId = cols[memberIdIdx];
            const name = cols[nameIdx];
            const ywam = ywamIdx !== -1 ? cols[ywamIdx] : "";

            if (!memberId || !name) continue;

            // Check if member already exists locally (now accurate because we refreshed!)
            const exists = Missionary.some(m => m.member_id === memberId);

            if (!exists) {
              try {
                await api("/api/Missionary", { 
                  method: "POST", 
                  body: { 
                    name: name, 
                    member_id: memberId,
                    YWAM: ywam
                  } 
                });
                createdCount++;
                // Add to local array immediately so subsequent rows in the same file don't try to create it again
                Missionary.push({ id: "temp-" + i, name: name, member_id: memberId, YWAM: ywam }); 
              } catch (err) {
                // If it's a duplicate, it means it was added by another process. Safely ignore.
                if (err.data?.error === "duplicate_client_id") {
                  Missionary.push({ id: "temp-" + i, name: name, member_id: memberId, YWAM: ywam });
                } else {
                  console.error("Failed to create member:", memberId, err);
                }
              }
            }
          }

          if (createdCount > 0) {
            toast(`Created ${createdCount} new Missionary members. Now importing contributions...`, false);
            // Refresh again to get proper IDs from server
            await refreshMissionary();
            populateMissionarySelects();
          } else {
            toast("All members already exist. Importing contributions...", false);
          }

          // 3. Proceed with the backend import for contributions
          const response = await fetch("/api/reports/yearly-contributions/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ csvData: csvText, year: parseInt(year, 10) })
          });

          const result = await response.json();

          if (response.ok && result.success) {
            const msg = `✅ Import Complete!\n\nNew Members Created: ${createdCount}\nContributions Imported/Updated: ${result.results.imported + result.results.updated}\nSkipped: ${result.results.skipped}\nErrors: ${result.results.errors}`;
            toast(msg, false);
            
            // Refresh the Yearly Contribution data and dashboard
            await loadAndRenderYearlyTarget();
            await renderDashboard();
          } else {
            toast("❌ Import failed: " + (result.error || "Unknown error"), true);
          }
        } catch (error) {
          console.error("Import error:", error);
          toast("❌ Import failed: " + error.message, true);
        } finally {
          e.target.value = ""; // Clear file input for next time
        }
      };

      reader.onerror = () => {
        toast("❌ Error reading file", true);
        e.target.value = "";
      };

      reader.readAsText(file);
    });
  }
  /* ============================================
     Third-Party Payments
     ============================================ */
  let tpData = null;

  async function loadAndRenderThirdParty() {
    try {
      tpData = await api("/api/third-party-payments");
    } catch (e) {
      toast("Could not load third-party payments.", true);
      return;
    }
    renderThirdParty();
  }

  function renderThirdParty() {
    if (!tpData) return;

    document.getElementById("tpTotalIncome").textContent = fmtMoney(tpData.totalIncome);
    document.getElementById("tpTotalPaid").textContent = fmtMoney(tpData.totalPaid);
    const netEl = document.getElementById("tpNetAfter");
    netEl.textContent = fmtMoney(tpData.netAfterThirdParty);
    netEl.classList.toggle("neg", tpData.netAfterThirdParty < 0);

    const body = document.getElementById("tpBody");
    body.innerHTML = tpData.payments.map((p) => `
      <tr>
        <td>${fmtDate(p.date)}</td>
        <td>${escapeHtml(p.payee) || "—"}</td>
        <td class="particulars">${escapeHtml(p.description) || "—"}</td>
        <td class="num debit-amt">${fmtMoney(p.amount)}</td>
        <td class="col-actions"><button class="link-btn" data-tp-delete="${p.id}">Delete</button></td>
      </tr>
    `).join("");

    document.getElementById("tpEmpty").hidden = tpData.payments.length > 0;

    body.querySelectorAll("[data-tp-delete]").forEach((btn) => {
      btn.addEventListener("click", () => deleteThirdPartyPayment(btn.dataset.tpDelete));
    });
  }

  async function deleteThirdPartyPayment(id) {
    if (!confirm("Delete this payment?")) return;
    try {
      await api(`/api/third-party-payments/${id}`, { method: "DELETE" });
      toast("Payment deleted.");
      await loadAndRenderThirdParty();
    } catch (e) {
      toast(e.data?.error || "Could not delete payment.", true);
    }
  }

  const thirdPartyForm = document.getElementById("thirdPartyForm");
  if (thirdPartyForm) {
    thirdPartyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("tpSubmit");
      const msg = document.getElementById("tpFormMsg");

      const payee = document.getElementById("tpPayee").value.trim();
      const amount = document.getElementById("tpAmount").value;
      const date = document.getElementById("tpDate").value;
      const description = document.getElementById("tpDesc").value.trim();

      btn.disabled = true;
      msg.textContent = "";
      try {
        await api("/api/third-party-payments", {
          method: "POST",
          body: { payee, amount, date, description },
        });
        thirdPartyForm.reset();
        document.getElementById("tpDate").value = todayISO();
        toast("Payment recorded.");
        await loadAndRenderThirdParty();
      } catch (err) {
        msg.textContent = err.data?.message || "Could not save payment.";
        toast("Could not save payment.", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ============================================
     Images drawer (multiple images per entry)
     Reusable for both Contributions entries ('transaction') and
     Courier shipments ('courier').
     ============================================ */
  let imagesCtx = null; // { entryType, entryId, label }

  function openImagesOverlay() {
    document.getElementById("imagesOverlay").classList.add("is-visible");
    document.getElementById("imagesDrawer").classList.add("is-open");
  }
  function closeImagesDrawer() {
    document.getElementById("imagesOverlay").classList.remove("is-visible");
    document.getElementById("imagesDrawer").classList.remove("is-open");
    imagesCtx = null;
  }
  document.getElementById("imagesOverlay").addEventListener("click", closeImagesDrawer);
  document.getElementById("imagesClose").addEventListener("click", closeImagesDrawer);

  async function openImagesDrawer(entryType, entryId, label) {
    imagesCtx = { entryType, entryId, label };
    openImagesOverlay();
    await renderImagesDrawer();
  }

  async function renderImagesDrawer() {
    if (!imagesCtx) return;
    const { entryType, entryId, label } = imagesCtx;
    const body = document.getElementById("imagesBody");
    body.innerHTML = `<h2>${escapeHtml(label)} — Images</h2><p class="empty-note">Loading…</p>`;

    let images = [];
    try {
      images = await api(`/api/entries/${entryType}/${entryId}/images`);
    } catch (e) {
      body.innerHTML = `<h2>${escapeHtml(label)} — Images</h2><p class="empty-note">Could not load images.</p>`;
      return;
    }

    body.innerHTML = `
      <h2>${escapeHtml(label)} — Images</h2>
      <p class="view-sub">Upload one or more photos (receipts, packaging, proof, etc.) for this entry.</p>
      <label class="btn btn-ghost file-btn" style="margin-bottom:14px; display:inline-block; cursor:pointer;">
        📤 Upload images
        <input type="file" id="imagesUploadInput" accept="image/*" multiple hidden>
      </label>
      <div class="images-grid" id="imagesGrid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:10px;">
        ${images.map((img) => `
          <div class="image-tile" style="position:relative; border:1px solid #e2e2e2; border-radius:8px; overflow:hidden;">
            <a href="${img.url}" target="_blank" rel="noopener">
              <img src="${img.url}" alt="${escapeHtml(img.original_name || "")}" style="width:100%; height:90px; object-fit:cover; display:block;">
            </a>
            <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; font-size:11px; background:#fafafa;">
              <a href="/api/entries/${entryType}/${entryId}/images/${img.id}/download" title="Download">⬇</a>
              <button type="button" class="icon-btn" title="Delete image" data-img-del="${img.id}" style="font-size:11px;">✕</button>
            </div>
          </div>
        `).join("")}
      </div>
      <p class="empty-note" ${images.length ? "hidden" : ""}>No images uploaded yet.</p>
    `;

    document.getElementById("imagesUploadInput").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const formData = new FormData();
      files.forEach((f) => formData.append("images", f));
      try {
        const res = await fetch(`/api/entries/${entryType}/${entryId}/images`, { method: "POST", body: formData });
        if (!res.ok) throw new Error("upload_failed");
        toast("Images uploaded.");
        await renderImagesDrawer();
      } catch (err) {
        toast("Could not upload images.", true);
      }
    });

    body.querySelectorAll("[data-img-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this image?")) return;
        try {
          await api(`/api/entries/${entryType}/${entryId}/images/${btn.dataset.imgDel}`, { method: "DELETE" });
          toast("Image deleted.");
          await renderImagesDrawer();
        } catch (err) {
          toast("Could not delete image.", true);
        }
      });
    });
  }

  /* ============================================
     Courier — Client-to-Third-Party shipments
     ============================================ */
  let courierData = null;

  async function loadAndRenderCourier() {
    const q = document.getElementById("courierSearch").value.trim();
    try {
      const qs = q ? `?q=${encodeURIComponent(q)}` : "";
      courierData = await api(`/api/courier${qs}`);
    } catch (e) {
      toast("Could not load courier shipments.", true);
      return;
    }
    renderCourier();
  }

  function renderCourier() {
    if (!courierData) return;
    document.getElementById("courierTotalAmount").textContent = fmtMoney(courierData.totalAmount);
    document.getElementById("courierTotalPayout").textContent = fmtMoney(courierData.totalPayout);
    const netEl = document.getElementById("courierNetRetained");
    netEl.textContent = fmtMoney(courierData.netRetained);
    netEl.classList.toggle("neg", courierData.netRetained < 0);

    const body = document.getElementById("courierBody");
    body.innerHTML = courierData.shipments.map((s) => `
      <tr>
        <td>${escapeHtml(s.client_name) || "—"}</td>
        <td>${escapeHtml(s.third_party_name) || "—"}</td>
        <td>${fmtDate(s.send_date)}</td>
        <td>${s.courier_date ? fmtDate(s.courier_date) : "—"}</td>
        <td class="num">${fmtMoney(s.total_amount)}</td>
        <td class="num">${fmtMoney(s.third_party_payout)}</td>
        <td class="particulars">${escapeHtml(s.description) || "—"}</td>
        <td class="col-actions">
          <button class="icon-btn" title="Attach/view images" data-cou-img="${s.id}">📎</button>
          <button class="icon-btn" title="Edit" data-cou-edit="${s.id}">✎</button>
          <button class="icon-btn" title="Delete" data-cou-del="${s.id}">✕</button>
        </td>
      </tr>
    `).join("");
    document.getElementById("courierEmpty").hidden = courierData.shipments.length > 0;

    body.querySelectorAll("[data-cou-img]").forEach((btn) => {
      btn.addEventListener("click", () => openImagesDrawer("courier", btn.dataset.couImg, "Courier Shipment"));
    });
    body.querySelectorAll("[data-cou-edit]").forEach((btn) => {
      btn.addEventListener("click", () => editCourier(btn.dataset.couEdit));
    });
    body.querySelectorAll("[data-cou-del]").forEach((btn) => {
      btn.addEventListener("click", () => deleteCourier(btn.dataset.couDel));
    });
  }

  function editCourier(id) {
    const s = courierData.shipments.find((x) => x.id === id);
    if (!s) return;
    document.getElementById("couEditId").value = s.id;
    document.getElementById("couClient").value = s.client_id || "";
    document.getElementById("couThirdParty").value = s.third_party_name || "";
    document.getElementById("couSendDate").value = s.send_date || "";
    document.getElementById("couCourierDate").value = s.courier_date || "";
    document.getElementById("couTotalAmount").value = s.total_amount ?? "";
    document.getElementById("couPayout").value = s.third_party_payout ?? "";
    document.getElementById("couDesc").value = s.description || "";
    document.getElementById("courierFormTitle").textContent = "Edit shipment";
    document.getElementById("couSubmit").textContent = "Save changes";
    document.getElementById("couCancel").hidden = false;
    document.getElementById("view-courier").scrollIntoView({ behavior: "smooth" });
  }

  function resetCourierForm() {
    document.getElementById("courierForm").reset();
    document.getElementById("couEditId").value = "";
    document.getElementById("courierFormTitle").textContent = "Add shipment";
    document.getElementById("couSubmit").textContent = "Add Shipment";
    document.getElementById("couCancel").hidden = true;
    document.getElementById("couSendDate").value = todayISO();
  }

  document.getElementById("couCancel").addEventListener("click", resetCourierForm);

  async function deleteCourier(id) {
    if (!confirm("Delete this courier shipment? It will be logged under Deleted Entries.")) return;
    try {
      await api(`/api/courier/${id}`, { method: "DELETE" });
      toast("Shipment deleted.");
      await loadAndRenderCourier();
    } catch (e) {
      toast("Could not delete shipment.", true);
    }
  }

  const courierForm = document.getElementById("courierForm");
  if (courierForm) {
    courierForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("couSubmit");
      const msg = document.getElementById("couFormMsg");
      const editId = document.getElementById("couEditId").value;

      const payload = {
        clientId: document.getElementById("couClient").value || null,
        thirdPartyName: document.getElementById("couThirdParty").value.trim(),
        sendDate: document.getElementById("couSendDate").value,
        courierDate: document.getElementById("couCourierDate").value || null,
        totalAmount: document.getElementById("couTotalAmount").value,
        thirdPartyPayout: document.getElementById("couPayout").value || 0,
        description: document.getElementById("couDesc").value.trim(),
      };

      btn.disabled = true;
      msg.textContent = "";
      try {
        if (editId) {
          await api(`/api/courier/${editId}`, { method: "PUT", body: payload });
          toast("Shipment updated.");
        } else {
          await api("/api/courier", { method: "POST", body: payload });
          toast("Shipment added.");
        }
        resetCourierForm();
        await loadAndRenderCourier();
      } catch (err) {
        msg.textContent = err.data?.message || "Could not save shipment.";
        toast("Could not save shipment.", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.getElementById("courierSearch").addEventListener("input", () => loadAndRenderCourier());
  document.getElementById("courierExportBtn").addEventListener("click", () => {
    const format = document.getElementById("courierExportFormat").value;
    const q = document.getElementById("courierSearch").value.trim();
    const params = new URLSearchParams({ format });
    if (q) params.set("q", q);
    window.location.href = `/api/courier/export?${params.toString()}`;
  });

  /* ============================================
     Deleted Entries (trash)
     ============================================ */
  async function loadAndRenderDeleted() {
    const type = document.getElementById("delFilterType").value;
    const q = document.getElementById("delSearch").value.trim();
    let rows;
    try {
      const params = new URLSearchParams();
      if (type !== "all") params.set("type", type);
      if (q) params.set("q", q);
      rows = await api(`/api/deleted-entries?${params.toString()}`);
    } catch (e) {
      toast("Could not load deleted entries.", true);
      return;
    }
    renderDeleted(rows);
  }

  function renderDeleted(rows) {
    const body = document.getElementById("deletedBody");
    body.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.entry_type_label)}</td>
        <td class="particulars">${escapeHtml(r.summary) || "—"}</td>
        <td class="num">${r.amount === null || r.amount === undefined ? "—" : fmtMoney(r.amount)}</td>
        <td>${r.entry_date ? fmtDate(r.entry_date) : "—"}</td>
        <td>${new Date(r.deleted_at).toLocaleString()}</td>
        <td class="col-actions"><button class="link-btn" data-del-clear="${r.id}">Remove from list</button></td>
      </tr>
    `).join("");
    document.getElementById("deletedEmpty").hidden = rows.length > 0;

    body.querySelectorAll("[data-del-clear]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this from the deleted-entries list? (The original record is already gone — this only clears the log.)")) return;
        try {
          await api(`/api/deleted-entries/${btn.dataset.delClear}`, { method: "DELETE" });
          await loadAndRenderDeleted();
        } catch (e) {
          toast("Could not remove.", true);
        }
      });
    });
  }

  document.getElementById("delFilterType").addEventListener("change", () => loadAndRenderDeleted());
  document.getElementById("delSearch").addEventListener("input", () => loadAndRenderDeleted());
  document.getElementById("delExportBtn").addEventListener("click", () => {
    const format = document.getElementById("delExportFormat").value;
    const type = document.getElementById("delFilterType").value;
    const q = document.getElementById("delSearch").value.trim();
    const params = new URLSearchParams({ format });
    if (type !== "all") params.set("type", type);
    if (q) params.set("q", q);
    window.location.href = `/api/deleted-entries/export?${params.toString()}`;
  });

  /* ============================================
     Logout
     ============================================ */
  document.getElementById("btnLogout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  /* ============================================
     Init
     ============================================ */
  async function renderAll() {
    const activeView = document.querySelector(".view.is-active")?.id;
    populateMissionarySelects();
    if (activeView === "view-dashboard") await renderDashboard();
    if (activeView === "view-Contributions") renderContributions();
    if (activeView === "view-Missionary") renderMissionary();
    if (activeView === "view-loans") { await refreshLoans(); renderLoans(); }
    
    if (activeView === "view-verify") {
      if (typeof loadVerifyPayments === 'function') loadVerifyPayments();
    }

    if (activeView === "view-thirdParty") await loadAndRenderThirdParty();

    if (activeView === "view-courier") await loadAndRenderCourier();

    if (activeView === "view-deleted") await loadAndRenderDeleted();

    if (activeView === "view-yearlyTarget") await loadAndRenderYearlyTarget();
  }

  async function init() {
    // BUG FIX: the very first thing init() used to do was fetch
    // /api/settings, whose failure (401) was silently swallowed by a
    // `catch (e) { /* fall back to default currency */ }` — so on an
    // unauthenticated visit, init() kept going and built out the whole
    // dashboard shell (form defaults, category options, etc.) before the
    // browser ever got around to the redirect the 401 triggered elsewhere.
    // That's the flash of the dashboard before landing on the login page.
    // Checking the session first, and stopping immediately if there isn't
    // one, makes the login page the actual first thing shown.
    try {
      const session = await api("/api/session");
      if (!session || !session.isAdmin) {
        window.location.href = "/login.html";
        return;
      }
    } catch (e) {
      window.location.href = "/login.html";
      return;
    }

    try {
      const settings = await api("/api/settings");
      currency = settings.currency || "₹";
    } catch (e) { /* fall back to default currency */ }

    populateCategorySelect();
    document.getElementById("fDate").value = todayISO();
    document.getElementById("lDateGiven").value = todayISO();
    setPhotoPreview(null, "");

    await refreshMissionary();
    await refreshAllTransactions();
    populateMissionarySelects();
    await loadAndRenderYearlyTarget();
    await prefillSuggestedClientId();
  }

  init();
})();