// NEXORA Hub — SPA client
"use strict";

// ══ STATE ══════════════════════════════════════════════════════════════
const NXR = {
  chatHistory: [],
  attachments: [],
  settings: JSON.parse(localStorage.getItem("nxr_settings") || "{}"),
  auditLog: JSON.parse(localStorage.getItem("nxr_audit") || "[]"),
};

// ══ UTILITIES ══════════════════════════════════════════════════════════

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el(id) {
  return document.getElementById(id);
}

function toast(msg, duration = 2400) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove("show"), duration);
}

function addAudit(icon, msg) {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  NXR.auditLog.unshift({ ts, icon, msg, iso: new Date().toISOString() });
  if (NXR.auditLog.length > 100) NXR.auditLog.pop();
  localStorage.setItem("nxr_audit", JSON.stringify(NXR.auditLog));
}

async function apiFetch(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function fmtPct(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

function fmtPrice(p, currency) {
  if (p === null || p === undefined || p === "") return "—";
  const v = Number(p);
  if (isNaN(v)) return "—";
  return (
    (currency === "EUR" ? "€" : "$") +
    v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

// ══ THEME ══════════════════════════════════════════════════════════════

function applyTheme(t) {
  document.body.classList.toggle("light", t === "light");
  const btn = el("themeBtn");
  if (btn) btn.textContent = t === "light" ? "☀️" : "🌙";
  localStorage.setItem("nxr_theme", t);
}

function initTheme() {
  const stored = localStorage.getItem("nxr_theme");
  if (stored === "light" || stored === "dark") {
    applyTheme(stored);
    return;
  }
  applyTheme(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

el("themeBtn")?.addEventListener("click", () =>
  applyTheme(document.body.classList.contains("light") ? "dark" : "light"),
);
el("themeLight")?.addEventListener("click", () => applyTheme("light"));
el("themeDark")?.addEventListener("click", () => applyTheme("dark"));

initTheme();

// ══ TAB NAVIGATION ══════════════════════════════════════════════════════

const allTabs = document.querySelectorAll(".tab[data-page]");
const allPages = document.querySelectorAll(".page");

function showPage(pageId) {
  allPages.forEach((p) => p.classList.toggle("active", p.id === pageId));
  allTabs.forEach((t) => t.classList.toggle("active", t.dataset.page === pageId));
  localStorage.setItem("nxr_tab", pageId);
  onPageEnter(pageId);
}

function onPageEnter(pageId) {
  switch (pageId) {
    case "page-cmd":
      renderCmd();
      break;
    case "page-inbox":
      renderInbox();
      break;
    case "page-biz":
      renderBiz();
      break;
    case "page-intel":
      renderIntel();
      break;
    case "page-fin":
      renderFinance();
      break;
    case "page-work":
      renderWork();
      break;
    case "page-life":
      renderLife();
      break;
    case "page-auto":
      renderAuto();
      break;
  }
}

allTabs.forEach((t) => t.addEventListener("click", () => showPage(t.dataset.page)));

// Refresh buttons
el("refreshCmd")?.addEventListener("click", renderCmd);
el("refreshInbox")?.addEventListener("click", renderInbox);
el("refreshBiz")?.addEventListener("click", renderBiz);
el("refreshIntel")?.addEventListener("click", renderIntel);
el("refreshFin")?.addEventListener("click", renderFinance);
el("refreshWork")?.addEventListener("click", renderWork);
el("refreshLife")?.addEventListener("click", renderLife);
el("refreshAudit")?.addEventListener("click", renderAuditLog);

// ══ ROUTER PILL ═════════════════════════════════════════════════════════

function updateRouterPill(tier, label) {
  const cls = tier === "pro" ? "dot-pro" : tier === "free" ? "dot-free" : "dot-off";
  ["routerDot", "chatDot"].forEach((id) => {
    const d = el(id);
    if (d) d.className = "dot " + cls;
  });
  if (el("routerLabel"))
    el("routerLabel").textContent = tier === "pro" ? "Pro" : tier === "free" ? "Free" : "—";
  if (el("chatModel")) el("chatModel").textContent = label || "—";
}

async function fetchRouterStatus() {
  try {
    const s = await apiFetch("/api/router/status");
    updateRouterPill(s.lastTier, s.lastProviderLabel || s.lastModel);
    const total = (s.requestsFree || 0) + (s.requestsPro || 0);
    const cost = Number(s.estimatedCostUSD) || 0;
    if (el("cmStatReqs")) el("cmStatReqs").textContent = total;
    if (el("cmStatCost"))
      el("cmStatCost").textContent = "$" + (cost < 1 ? cost.toFixed(4) : cost.toFixed(2));
    if (el("cmStatModel"))
      el("cmStatModel").textContent =
        s.lastTier === "pro" ? "Pro" : s.lastTier === "free" ? "Free" : "—";
    return s;
  } catch (_) {
    /* silent – connection may be starting */
  }
}

// ══ CHAT ════════════════════════════════════════════════════════════════

function appendMessage(role, text) {
  const container = el("chatMessages");
  if (!container) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg msg-" + role;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function autoResize() {
  const ta = el("chatInput");
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
}

el("chatInput")?.addEventListener("input", autoResize);
el("chatInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("chatForm")?.requestSubmit();
  }
});

el("attachBtn")?.addEventListener("click", () => el("fileInput")?.click());
el("fileInput")?.addEventListener("change", () => {
  Array.from(el("fileInput").files || []).forEach((f) => NXR.attachments.push({ name: f.name }));
  el("fileInput").value = "";
  renderAttachments();
});

function renderAttachments() {
  const bar = el("chatAttachments");
  if (!bar) return;
  bar.innerHTML = "";
  if (!NXR.attachments.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  NXR.attachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>📎 ${esc(a.name)}</span><button type="button" data-idx="${i}">✕</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      NXR.attachments.splice(i, 1);
      renderAttachments();
    });
    bar.appendChild(chip);
  });
}

el("chatForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = (el("chatInput")?.value || "").trim();
  if (!raw && !NXR.attachments.length) return;

  let text = raw;
  if (NXR.attachments.length) {
    const names = NXR.attachments.map((a) => a.name).join(", ");
    text = (raw ? raw + "\n\n" : "") + "[Pièces jointes: " + names + "]";
  }

  appendMessage("user", text);
  NXR.chatHistory.push({ role: "user", content: text });
  el("chatInput").value = "";
  autoResize();
  NXR.attachments = [];
  renderAttachments();

  const tierChoice = el("tierSelect")?.value || "auto";
  const body = { messages: NXR.chatHistory };
  if (tierChoice !== "auto") body.tier = tierChoice;

  el("sendBtn").disabled = true;
  const bubble = appendMessage("assistant", "…");
  if (bubble) bubble.textContent = "";

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const tierH = resp.headers.get("X-Nexora-Tier");
    const modelH = resp.headers.get("X-Nexora-Model");
    if (tierH) updateRouterPill(tierH, modelH);

    if (!resp.ok || !resp.body) {
      let d = "";
      try {
        d = (await resp.json()).detail || "";
      } catch (_) {}
      if (bubble) bubble.textContent = `⚠️ Erreur (${resp.status})${d ? " — " + d : ""}`;
      return;
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "",
      full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const tr = line.trim();
        if (!tr.startsWith("data:")) continue;
        const pay = tr.slice(5).trim();
        if (pay === "[DONE]") continue;
        try {
          const delta = JSON.parse(pay)?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            if (bubble) {
              bubble.textContent = full;
            }
            const cm = el("chatMessages");
            if (cm) cm.scrollTop = cm.scrollHeight;
          }
        } catch (_) {}
      }
    }
    if (!full) full = "(réponse vide)";
    NXR.chatHistory.push({ role: "assistant", content: full });
    addAudit("💬", `Chat: "${text.slice(0, 60)}…"`);
  } catch (err) {
    if (bubble) bubble.textContent = "⚠️ Erreur réseau: " + (err?.message || err);
  } finally {
    el("sendBtn").disabled = false;
    fetchRouterStatus();
  }
});

// ══ COMMAND CENTER ══════════════════════════════════════════════════════

async function renderCmd() {
  const now = new Date();
  const h = now.getHours();
  const greeting = h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir";
  if (el("cmdGreeting")) el("cmdGreeting").textContent = greeting + ", Halim";
  if (el("cmdDate")) {
    el("cmdDate").textContent = now.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  fetchRouterStatus();

  // Commute quick view
  const commuteBox = el("cmdCommute");
  if (commuteBox) {
    try {
      const data = await apiFetch("/api/widgets/ns");
      if (data.demo) {
        commuteBox.innerHTML = `<div class="alert a-w"><span class="ai">🚉</span><span>${esc(data.note || "NS API non connectée. Ajoutez votre clé dans Mémoire → Tokens.")} <a href="#" onclick="document.querySelector(\'[data-page=page-mem]\').click();return false" style="color:var(--ios)">Configurer →</a></span></div>`;
      } else {
        const tmpDiv = document.createElement("div");
        renderNSTrainList(tmpDiv, (data.departures || []).slice(0, 3));
        commuteBox.innerHTML = tmpDiv.innerHTML;
      }
    } catch (_) {
      commuteBox.innerHTML = `<div class="alert a-d"><span class="ai">⚠️</span><span>NS inaccessible.</span></div>`;
    }
  }

  // Approvals
  const appBox = el("cmdApprovals");
  if (appBox) {
    appBox.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-txt">Aucune approbation en attente.<br>Connectez Telegram ou WhatsApp pour activer le workflow.</div>
      </div>`;
  }

  // Quick nav
  const modules = [
    { page: "page-chat", ic: "💬", title: "AI Chat", desc: "Envoyer un message" },
    { page: "page-inbox", ic: "📬", title: "Inbox", desc: "Communications & approbations" },
    { page: "page-biz", ic: "📈", title: "Growth", desc: "GitHub, analytics" },
    { page: "page-intel", ic: "🌍", title: "Intelligence", desc: "Marchés, Algérie, Ukraine, IND" },
    { page: "page-fin", ic: "💰", title: "Finance", desc: "Portefeuille & budget" },
    { page: "page-work", ic: "🏢", title: "Work", desc: "Utrecht team & outils Inditex" },
    { page: "page-life", ic: "🚉", title: "Vie quotidienne", desc: "Trains NS & météo Arnhem" },
    { page: "page-auto", ic: "⚙️", title: "Automation", desc: "Journal & triggers" },
  ];
  const grid = el("cmdModules");
  if (grid) {
    grid.innerHTML = modules
      .map(
        (m) =>
          `<div class="quick-card" data-goto="${m.page}">
        <span class="quick-card-icon">${m.ic}</span>
        <div>
          <div class="quick-card-title">${m.title}</div>
          <div class="quick-card-desc">${esc(m.desc)}</div>
        </div>
      </div>`,
      )
      .join("");
    grid
      .querySelectorAll(".quick-card")
      .forEach((c) => c.addEventListener("click", () => showPage(c.dataset.goto)));
  }
}

// ══ COMMUNICATIONS / INBOX ══════════════════════════════════════════════

function renderInbox() {
  const platforms = [
    {
      ic: "✈️",
      name: "Telegram",
      note: "Connecter TELEGRAM_BOT_TOKEN dans Mémoire → Tokens",
      on: false,
    },
    { ic: "📱", name: "WhatsApp", note: "WhatsApp Business API credentials requis", on: false },
    { ic: "📸", name: "Instagram", note: "Meta Graph API token requis", on: false },
    { ic: "💼", name: "LinkedIn", note: "LinkedIn OAuth token requis", on: false },
  ];

  const platBox = el("inboxPlatforms");
  if (platBox) {
    platBox.innerHTML = platforms
      .map(
        (p) => `
      <div class="connect-card">
        <span class="connect-icon">${p.ic}</span>
        <div class="connect-info">
          <div class="connect-name">${esc(p.name)}</div>
          <div class="connect-note">${esc(p.note)}</div>
        </div>
        <div class="connect-status">
          <span class="sdot ${p.on ? "sdot-on" : "sdot-off"}"></span>
        </div>
      </div>`,
      )
      .join("");
  }

  const approvalBox = el("inboxApprovalSettings");
  if (approvalBox) {
    approvalBox.innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title">Niveaux d'approbation</span></div>
        <div class="approval-card">
          <div class="approval-level level-1">L1 — Toujours demander</div>
          <div class="approval-msg">Rédige une réponse, attend la validation manuelle avant envoi. Pour les contacts importants ou les sujets sensibles.</div>
        </div>
        <div class="approval-card">
          <div class="approval-level level-2">L2 — Conditionnel</div>
          <div class="approval-msg">Réponses automatiques dans des périmètres pré-approuvés (contacts de confiance, sujets définis).</div>
        </div>
        <div class="approval-card" style="margin-bottom:0">
          <div class="approval-level level-3">L3 — Automatique</div>
          <div class="approval-msg">Accusés de réception routiniers à faible risque sans intervention humaine.</div>
        </div>
      </div>`;
  }
}

// ══ BUSINESS & GROWTH ═══════════════════════════════════════════════════

async function renderBiz() {
  // GitHub
  try {
    const data = await apiFetch("/api/widgets/github?user=Qlf296");
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';
    const rows =
      (data.repos || [])
        .map(
          (r) =>
            `<div class="list-row">
        <a href="${r.url}" target="_blank" rel="noopener">${esc(r.name)}</a>
        <span>★ ${r.stars}</span>
      </div>`,
        )
        .join("") || '<span class="loading-txt">Aucun dépôt trouvé.</span>';
    el("bizGithub").innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title">GitHub — Qlf296</span>${badge}</div>
        ${rows}
        ${data.note ? `<div class="loading-txt" style="margin-top:8px">${esc(data.note)}</div>` : ""}
      </div>`;
  } catch (_) {
    el("bizGithub").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>GitHub inaccessible.</span></div>`;
  }

  // Reddit community
  try {
    const data = await apiFetch("/api/widgets/reddit?sub=webdev");
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';
    const rows = (data.posts || [])
      .map(
        (p) =>
          `<div class="list-row">
        <a href="${p.url}" target="_blank" rel="noopener">${esc(p.title.slice(0, 90))}</a>
        <span>↑${p.score}</span>
      </div>`,
      )
      .join("");
    el("bizReddit").innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title">r/webdev</span>${badge}</div>
        ${rows}
      </div>`;
  } catch (_) {
    el("bizReddit").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>Reddit inaccessible.</span></div>`;
  }
}

// ══ INTELLIGENCE ════════════════════════════════════════════════════════

async function renderIntel() {
  // Finance (key markets)
  try {
    const data = await apiFetch("/api/widgets/finance?symbols=BTC-USD,VWRL.AS,IWDA.AS,EUNL.DE,VTI");
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';
    const rows = (data.quotes || [])
      .map((q) => {
        const pct = Number(q.changePercent) || 0;
        return `<div class="pf-row">
        <span class="pf-symbol">${esc(q.symbol)}</span>
        <span class="pf-price">${fmtPrice(q.price, q.currency)}</span>
        <span class="pf-pct ${pct >= 0 ? "pf-up" : "pf-down"}">${fmtPct(pct)}</span>
      </div>`;
      })
      .join("");
    el("intelFinance").innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title">Marchés</span>${badge}</div>
        ${rows}
        ${data.note ? `<div class="loading-txt" style="margin-top:8px">${esc(data.note)}</div>` : ""}
      </div>`;
  } catch (_) {
    el("intelFinance").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>Finance inaccessible.</span></div>`;
  }

  // Algeria
  try {
    const data = await apiFetch("/api/widgets/reddit?sub=algeria");
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';
    const rows = (data.posts || [])
      .map(
        (p) =>
          `<div class="list-row"><a href="${p.url}" target="_blank" rel="noopener">${esc(p.title.slice(0, 80))}</a><span>↑${p.score}</span></div>`,
      )
      .join("");
    el("intelAlgeria").innerHTML = `
      <div class="card"><div class="card-head"><span class="card-title">r/Algeria</span>${badge}</div>${rows}</div>`;
  } catch (_) {
    el("intelAlgeria").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>Reddit inaccessible.</span></div>`;
  }

  // Ukraine
  try {
    const data = await apiFetch("/api/widgets/reddit?sub=ukraine");
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';
    const rows = (data.posts || [])
      .map(
        (p) =>
          `<div class="list-row"><a href="${p.url}" target="_blank" rel="noopener">${esc(p.title.slice(0, 80))}</a><span>↑${p.score}</span></div>`,
      )
      .join("");
    el("intelUkraine").innerHTML = `
      <div class="card"><div class="card-head"><span class="card-title">r/ukraine</span>${badge}</div>${rows}</div>`;
  } catch (_) {
    el("intelUkraine").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>Reddit inaccessible.</span></div>`;
  }
}

// ══ FINANCE & INVESTMENTS ════════════════════════════════════════════════

async function renderFinance() {
  // Portfolio
  try {
    const data = await apiFetch(
      "/api/widgets/finance?symbols=BTC-USD,VWRL.AS,IWDA.AS,EUNL.DE,VTI,AAPL",
    );
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';
    const rows = (data.quotes || [])
      .map((q) => {
        const pct = Number(q.changePercent) || 0;
        return `<div class="pf-row">
        <span class="pf-symbol">${esc(q.symbol)}</span>
        <span class="pf-price">${fmtPrice(q.price, q.currency)}</span>
        <span class="pf-pct ${pct >= 0 ? "pf-up" : "pf-down"}">${fmtPct(pct)}</span>
      </div>`;
      })
      .join("");
    el("finPortfolio").innerHTML = `
      <div class="card-head"><span class="card-title">Cotations</span>${badge}</div>${rows}
      ${data.note ? `<div class="loading-txt" style="margin-top:8px">${esc(data.note)}</div>` : ""}`;
  } catch (_) {
    el("finPortfolio").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>Finance inaccessible.</span></div>`;
  }

  // Budget
  renderBudget();

  // Wire up ETF simulator button (safe to call multiple times)
  el("simCalcBtn")?.removeEventListener("click", calcSim);
  el("simCalcBtn")?.addEventListener("click", calcSim);
}

function renderBudget() {
  const b = JSON.parse(localStorage.getItem("nxr_budget") || "{}");
  const salary = b.salary || 1800;
  const expenses = [
    { name: "Loyer (Arnhem)", amount: b.rent || 650 },
    { name: "NS Abonnement", amount: b.ns || 95 },
    { name: "Basic-Fit", amount: b.gym || 25 },
    { name: "Hetzner VPS", amount: b.vps || 15 },
    { name: "Téléphone/Net", amount: b.phone || 40 },
  ];
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const remaining = salary - total;
  const pct = Math.min(100, Math.round((total / salary) * 100));
  const barColor = pct > 80 ? "var(--dan)" : pct > 60 ? "var(--wrn)" : "var(--ok)";

  el("budgetContent").innerHTML = `
    <div class="card-head">
      <span class="card-title">Budget mensuel</span>
      <span class="badge b-acc">€${salary}/mois</span>
    </div>
    <div class="stat-row"><span class="label">Salaire net</span><span class="value" style="color:var(--ok)">+€${salary}</span></div>
    ${expenses
      .map(
        (e) =>
          `<div class="stat-row"><span class="label">${esc(e.name)}</span><span class="value" style="color:var(--dan)">-€${e.amount}</span></div>`,
      )
      .join("")}
    <div class="budget-bar"><div class="budget-fill" style="width:${pct}%;background:${barColor}"></div></div>
    <div class="stat-row" style="margin-top:4px">
      <span class="label">Charges fixes (${pct}%)</span><span class="value" style="color:var(--dan)">-€${total}</span>
    </div>
    <div class="stat-row">
      <span class="label"><strong>Disponible</strong></span>
      <span class="value" style="color:var(--ok)"><strong>€${remaining}</strong></span>
    </div>`;
}

function calcSim() {
  const monthly = Number(el("simAmount")?.value) || 150;
  const years = Number(el("simYears")?.value) || 10;
  const rate = (Number(el("simRate")?.value) || 7) / 100;
  const months = years * 12;
  const mr = rate / 12;
  let fv = 0;
  for (let i = 0; i < months; i++) fv = (fv + monthly) * (1 + mr);
  const invested = monthly * months;
  const gains = fv - invested;
  const roi = ((gains / invested) * 100).toFixed(1);

  el("simResult").innerHTML = `
    <div class="sg">
      <div class="sc">
        <div class="sv" style="color:var(--ok)">€${Math.round(fv).toLocaleString("fr-FR")}</div>
        <div class="sl">Valeur finale</div>
      </div>
      <div class="sc">
        <div class="sv" style="color:var(--acc)">€${Math.round(gains).toLocaleString("fr-FR")}</div>
        <div class="sl">Plus-values</div>
      </div>
    </div>
    <div class="stat-row"><span class="label">Capital investi</span><span class="value">€${invested.toLocaleString("fr-FR")}</span></div>
    <div class="stat-row"><span class="label">Rendement total</span><span class="value" style="color:var(--ok)">${roi}%</span></div>
    <div class="alert a-w" style="font-size:11.5px;margin-top:10px">
      <span class="ai">⚠️</span><span>Simulation indicative. Passé ≠ futur. Box 3 NL peut s'appliquer. Consultez un conseiller financier agréé.</span>
    </div>`;
}

// ══ WORK & PROJECTS ══════════════════════════════════════════════════════

async function renderWork() {
  const teamBox = el("workTeam");
  try {
    const data = await apiFetch("/api/widgets/team");
    const badge = data.demo
      ? '<span class="badge b-demo">demo</span>'
      : '<span class="badge b-live">live</span>';

    if (data.demo) {
      teamBox.innerHTML = `<div class="card-head"><span class="card-title">Équipe Utrecht</span>${badge}</div>
        <span class="loading-txt">${esc(data.note || "Données indisponibles.")}</span>`;
    } else {
      const absences = data.todayAbsences || [];
      const absHTML = absences.length
        ? absences
            .map(
              (a) =>
                `<div class="list-row">
              <span>${esc(a.name)} <span style="color:var(--txt3);font-size:11px">(${esc(a.role || "")})</span></span>
              <span>${esc(a.detail)}</span>
            </div>`,
            )
            .join("")
        : `<div class="list-row"><span>Équipe complète aujourd'hui</span><span style="color:var(--ok)">✓</span></div>`;

      teamBox.innerHTML = `
        <div class="card-head"><span class="card-title">Équipe — ${esc(data.todayName || "")}</span>${badge}</div>
        <div class="sg">
          <div class="sc"><div class="sv">${data.teamSize ?? "—"}</div><div class="sl">Effectif</div></div>
          <div class="sc"><div class="sv">${data.weeklyAveragePercent != null ? data.weeklyAveragePercent + "%" : "—"}</div><div class="sl">Dispo. moy.</div></div>
        </div>
        <div class="sh" style="margin-top:0">Absences — ${esc(data.todayName || "")}</div>
        ${absHTML}
        ${data.sheetUrl ? `<div class="loading-txt" style="margin-top:8px"><a href="${data.sheetUrl}" target="_blank" rel="noopener" style="color:var(--ios)">Ouvrir Google Sheets ↗</a></div>` : ""}`;
    }
  } catch (_) {
    teamBox.innerHTML = `<div class="alert a-d"><span class="ai">⚠️</span><span>Données équipe inaccessibles.</span></div>`;
  }

  // Wire tool tab buttons (safe once)
  if (!el("toolFrameInditex").dataset.wired) {
    el("toolFrameInditex").dataset.wired = "1";
    document
      .querySelectorAll(".tool-tab-btn[data-tool]")
      .forEach((btn) => btn.addEventListener("click", () => switchTool(btn.dataset.tool)));
  }
}

function switchTool(name) {
  const framesMap = { inditex: el("toolFrameInditex"), schedule: el("toolFrameSchedule") };
  const hrefsMap = {
    inditex: "/tools/inditex-logistic.html",
    schedule: "/tools/schedule-team.html",
  };

  document.querySelectorAll(".tool-tab-btn[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === name);
    b.setAttribute("aria-selected", b.dataset.tool === name ? "true" : "false");
  });
  Object.entries(framesMap).forEach(([k, f]) => {
    if (!f) return;
    f.classList.toggle("active", k === name);
    if (k === name && !f.src && f.dataset.src) f.src = f.dataset.src;
  });
  const expLink = el("toolExpandLink");
  if (expLink && hrefsMap[name]) expLink.href = hrefsMap[name];
}

// ══ DAILY LIFE ════════════════════════════════════════════════════════════

async function renderLife() {
  // NS Trains
  try {
    const data = await apiFetch("/api/widgets/ns");
    if (data.demo) {
      el("nsTrains").innerHTML = `<div class="alert a-w" style="margin-bottom:0">
        <span class="ai">ℹ️</span>
        <span>${esc(data.note || "NS API non connectée.")}
          <a href="#" onclick="document.querySelector('[data-page=page-mem]').click();return false" style="color:var(--ios)"> Configurer →</a>
        </span>
      </div>`;
    } else {
      renderNSTrainList(el("nsTrains"), data.departures || []);
    }

    const disBox = el("nsDisruptions");
    if (disBox) {
      const dis = data.disruptions || [];
      disBox.innerHTML = dis.length
        ? dis
            .map(
              (d) =>
                `<div class="alert a-w" style="margin-bottom:6px"><span class="ai">🚧</span><span>${esc(d.title || d.description || JSON.stringify(d))}</span></div>`,
            )
            .join("")
        : `<div class="alert a-ok" style="margin-bottom:0"><span class="ai">✅</span><span>Aucune perturbation connue sur Arnhem → Utrecht.</span></div>`;
    }
  } catch (e) {
    el("nsTrains").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>NS inaccessible: ${esc(e.message)}</span></div>`;
  }

  // Weather
  try {
    const data = await apiFetch("/api/widgets/weather");
    renderWeather(data);
  } catch (_) {
    el("lifeWeather").innerHTML =
      `<div class="alert a-d"><span class="ai">⚠️</span><span>Météo inaccessible.</span></div>`;
  }
}

function renderNSTrainList(container, departures) {
  if (!departures.length) {
    container.innerHTML = '<span class="loading-txt">Aucun départ disponible.</span>';
    return;
  }
  container.innerHTML = departures
    .slice(0, 5)
    .map((d) => {
      const time = d.plannedDepartureTime
        ? new Date(d.plannedDepartureTime).toLocaleTimeString("nl-NL", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : d.time || "—";
      const dest = d.direction || d.destination || "Utrecht Centraal";
      const track = d.plannedTrack || d.track || "?";
      const delay =
        d.actualDepartureTime && d.plannedDepartureTime
          ? Math.round((new Date(d.actualDepartureTime) - new Date(d.plannedDepartureTime)) / 60000)
          : d.delayMinutes || 0;
      const cancelled = d.cancelled || d.status === "CANCELLED";
      return `
      <div class="train-row" ${cancelled ? 'style="opacity:.4;text-decoration:line-through"' : ""}>
        <div>
          <div class="train-time">${esc(time)}${delay > 0 ? ` <span class="delay">+${delay}′</span>` : ""}</div>
          <div class="train-dest">${esc(dest)}</div>
        </div>
        <div class="train-track">spoor ${esc(String(track))}</div>
      </div>`;
    })
    .join("");
}

const WMO = {
  0: "Ciel dégagé",
  1: "Principalement dégagé",
  2: "Partiellement nuageux",
  3: "Couvert",
  45: "Brouillard",
  48: "Brouillard givrant",
  51: "Bruine légère",
  53: "Bruine modérée",
  55: "Bruine dense",
  61: "Pluie légère",
  63: "Pluie modérée",
  65: "Pluie forte",
  71: "Neige légère",
  73: "Neige modérée",
  75: "Neige forte",
  80: "Averses légères",
  81: "Averses modérées",
  82: "Averses fortes",
  95: "Orageux",
};
const WMO_ICON = (c) =>
  c === 0
    ? "☀️"
    : c <= 2
      ? "🌤️"
      : c === 3
        ? "☁️"
        : c <= 55
          ? "🌫️"
          : c <= 65
            ? "🌧️"
            : c <= 75
              ? "❄️"
              : c <= 82
                ? "🌦️"
                : "⛈️";

function renderWeather(data) {
  const c = data.current_weather || {};
  const temp = c.temperature != null ? Math.round(c.temperature) + "°C" : "—";
  const wind = c.windspeed != null ? c.windspeed + " km/h" : "—";
  const code = c.weathercode || 0;
  const is_day = c.is_day !== 0;
  el("lifeWeather").innerHTML = `
    <div class="weather-main">
      <div style="font-size:48px;line-height:1">${WMO_ICON(code)}</div>
      <div>
        <div class="weather-temp">${temp}</div>
        <div class="weather-desc">${esc(WMO[code] || `Code ${code}`)}</div>
        <div class="weather-loc">📍 Arnhem, NL · Vent ${esc(wind)} · ${is_day ? "Jour" : "Nuit"}</div>
      </div>
    </div>`;
}

// ══ AUTOMATION ════════════════════════════════════════════════════════════

function renderAuto() {
  const nsKey = NXR.settings["ns_key"] || NXR.settings.ns;
  el("autoJobs").innerHTML = `
    <div class="card">
      <div class="card-head"><span class="card-title">Tâches de fond</span><span class="badge b-ok">3 actives</span></div>
      <div class="list-row"><span>🔄 Rafraîchissement widgets</span><span class="badge b-ok">60s</span></div>
      <div class="list-row"><span>📊 Statut routeur IA</span><span class="badge b-ok">60s</span></div>
      <div class="list-row"><span>🚉 Trains NS</span><span class="badge ${nsKey ? "b-ok" : "b-off"}">${nsKey ? "60s" : "NS key requis"}</span></div>
    </div>`;
  renderAuditLog();
}

function renderAuditLog() {
  const logs = NXR.auditLog;
  const box = el("auditLogContent");
  if (!box) return;
  if (!logs.length) {
    box.innerHTML = '<span class="loading-txt">Journal vide.</span>';
    return;
  }
  box.innerHTML = logs
    .slice(0, 40)
    .map(
      (l) =>
        `<div class="log-row">
      <span class="log-ts">${esc(l.ts)}</span>
      <span class="log-ic">${l.icon || "📌"}</span>
      <span class="log-msg">${esc(l.msg)}</span>
    </div>`,
    )
    .join("");
}

// ══ SETTINGS ═════════════════════════════════════════════════════════════

function renderSettings() {
  if (NXR.settings["ns_key"] && el("tkNS")) el("tkNS").placeholder = "•••••••• (sauvegardé)";
  if (NXR.settings["telegram_key"] && el("tkTelegram"))
    el("tkTelegram").placeholder = "•••••••• (sauvegardé)";
  if (NXR.settings["litellm_url"] && el("tkLiteLLM"))
    el("tkLiteLLM").value = NXR.settings["litellm_url"];
}

document.querySelectorAll(".token-save").forEach((btn) => {
  btn.addEventListener("click", () => {
    const keyMap = { ns: "tkNS", telegram: "tkTelegram", litellm_url: "tkLiteLLM" };
    const inputEl = el(keyMap[btn.dataset.key]);
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (!val) return;
    const storeKey = btn.dataset.key === "litellm_url" ? "litellm_url" : btn.dataset.key + "_key";
    NXR.settings[storeKey] = val;
    localStorage.setItem("nxr_settings", JSON.stringify(NXR.settings));
    inputEl.value = "";
    inputEl.placeholder = "•••••••• (sauvegardé)";
    toast("✅ Token sauvegardé");
    addAudit("🔑", `Token "${btn.dataset.key}" mis à jour`);
  });
});

document.querySelectorAll(".lang-pill[data-lang]").forEach((pill) => {
  pill.addEventListener("click", () => {
    pill.classList.toggle("active");
  });
});

el("clearAuditBtn")?.addEventListener("click", () => {
  NXR.auditLog = [];
  localStorage.removeItem("nxr_audit");
  toast("🗑 Journal effacé");
  renderAuditLog();
});

el("exportMemBtn")?.addEventListener("click", () => {
  const data = {
    settings: { ...NXR.settings },
    auditLog: NXR.auditLog,
    exportedAt: new Date().toISOString(),
  };
  delete data.settings["ns_key"];
  delete data.settings["telegram_key"];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "nexora-memory-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
  toast("📤 Export téléchargé");
});

// ══ AUTO-REFRESH ══════════════════════════════════════════════════════════

setInterval(() => {
  fetchRouterStatus();
  const activeTab = document.querySelector(".tab.active");
  if (!activeTab) return;
  const pid = activeTab.dataset.page;
  if (["page-life", "page-intel", "page-fin", "page-biz"].includes(pid)) {
    onPageEnter(pid);
  } else if (pid === "page-cmd") {
    renderCmd();
  }
}, 60000);

// ══ INIT ══════════════════════════════════════════════════════════════════

(function init() {
  // Restore last active tab, default to Command Center
  const lastTab = localStorage.getItem("nxr_tab") || "page-cmd";
  showPage(lastTab);
  fetchRouterStatus();
  renderSettings();
  addAudit("🚀", "NEXORA Hub démarré");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("/sw.js").catch(() => {}),
    );
  }
})();
