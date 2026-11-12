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

// Open (or focus) a named window so the account "stays always open"
function openAccount(url, windowName) {
  const w = window.open(url, windowName, "noopener");
  if (w) w.focus();
}

function renderInbox() {
  // ── Messaging launch pads (Telegram ×2, WhatsApp ×2, Instagram ×2) ──
  const messaging = [
    {
      ic: "✈️",
      name: "Telegram",
      slots: [
        {
          label: "Compte 1",
          url: NXR.settings["tgram1_url"] || "https://web.telegram.org",
          win: "nexora-tgram-1",
        },
        {
          label: "Compte 2",
          url: NXR.settings["tgram2_url"] || "https://web.telegram.org",
          win: "nexora-tgram-2",
        },
      ],
    },
    {
      ic: "📱",
      name: "WhatsApp",
      slots: [
        {
          label: "Compte 1",
          url: NXR.settings["wa1_url"] || "https://web.whatsapp.com",
          win: "nexora-wa-1",
        },
        {
          label: "Compte 2",
          url: NXR.settings["wa2_url"] || "https://web.whatsapp.com",
          win: "nexora-wa-2",
        },
      ],
    },
    {
      ic: "📸",
      name: "Instagram",
      slots: [
        {
          label: "Compte 1",
          url: NXR.settings["insta1_url"] || "https://www.instagram.com",
          win: "nexora-insta-1",
        },
        {
          label: "Compte 2",
          url: NXR.settings["insta2_url"] || "https://www.instagram.com",
          win: "nexora-insta-2",
        },
      ],
    },
  ];

  const lp = el("inboxLaunchPads");
  if (lp) {
    lp.innerHTML = messaging
      .map(
        (p) => `
      <div class="launchpad-card">
        <div class="launchpad-head">
          <span class="launchpad-head-icon">${p.ic}</span>
          ${esc(p.name)}
        </div>
        <div class="launchpad-slots">
          ${p.slots
            .map(
              (s) => `
          <div class="launchpad-slot">
            <div>
              <div class="launchpad-label">${esc(s.label)}</div>
              <div class="launchpad-url">${esc(s.url)}</div>
            </div>
            <button class="launchpad-btn" data-url="${esc(s.url)}" data-win="${esc(s.win)}">
              Ouvrir ↗
            </button>
          </div>`,
            )
            .join("")}
        </div>
      </div>`,
      )
      .join("");

    lp.querySelectorAll(".launchpad-btn[data-url]").forEach((btn) => {
      btn.addEventListener("click", () => openAccount(btn.dataset.url, btn.dataset.win));
    });
  }

  // ── Social networks ──
  const socials = [
    { ic: "💼", name: "LinkedIn", url: "https://www.linkedin.com", win: "nexora-linkedin" },
    { ic: "🔴", name: "Reddit", url: "https://www.reddit.com", win: "nexora-reddit" },
    { ic: "✖️", name: "X / Twitter", url: "https://x.com", win: "nexora-x" },
  ];

  const sb = el("inboxSocials");
  if (sb) {
    sb.innerHTML =
      `<div class="card">` +
      socials
        .map(
          (s) => `
      <div class="list-row">
        <span>${s.ic} ${esc(s.name)}</span>
        <button class="launchpad-btn" style="padding:5px 11px;font-size:11px"
          data-url="${esc(s.url)}" data-win="${esc(s.win)}">Ouvrir ↗</button>
      </div>`,
        )
        .join("") +
      `</div>`;

    sb.querySelectorAll(".launchpad-btn[data-url]").forEach((btn) => {
      btn.addEventListener("click", () => openAccount(btn.dataset.url, btn.dataset.win));
    });
  }

  // ── Approval workflow ──
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

// ══ FREE AI PROVIDERS (Settings) ════════════════════════════════════════

async function renderProviders() {
  const box = el("aiProvidersCard");
  if (!box) return;
  try {
    const data = await apiFetch("/api/router/providers");
    const all = [...(data.providers || []), data.litellm].filter(Boolean);
    box.innerHTML =
      all
        .map((p) => {
          const okBadge = p.configured
            ? `<span class="badge b-ok" style="font-size:9px">✓ Actif</span>`
            : `<span class="badge b-off" style="font-size:9px">Non configuré</span>`;
          const tierBadge =
            p.tier === "pro"
              ? `<span class="badge b-w" style="font-size:9px">Pro</span>`
              : `<span class="badge b-live" style="font-size:9px">Gratuit</span>`;
          return `
        <div class="provider-row">
          <div class="provider-info">
            <div class="provider-name">${esc(p.name)}</div>
            <div class="provider-meta">${esc(p.specialty || "")}</div>
            <div class="provider-meta" style="margin-top:2px">${esc(p.freeLimit || "")}</div>
            ${
              p.envKey
                ? `<div class="provider-meta" style="margin-top:4px">Env : <span class="provider-env">${esc(p.envKey)}</span></div>`
                : ""
            }
          </div>
          <div class="provider-actions">
            ${okBadge} ${tierBadge}
            ${
              p.getKey
                ? `<a href="${esc(p.getKey)}" target="_blank" rel="noopener" class="provider-link">Obtenir clé →</a>`
                : ""
            }
          </div>
        </div>`;
        })
        .join("") +
      `<div class="alert a-info" style="margin-top:12px;font-size:11.5px;margin-bottom:0">
        <span class="ai">💡</span>
        <span>Ajoutez la variable d'environnement au démarrage du serveur :
        <br><code style="font-size:10px">GROQ_API_KEY=gsk_... node server.js</code>
        <br>NEXORA cascade automatiquement : Groq → Gemini → OpenRouter → Mistral → LiteLLM/Claude.</span>
      </div>`;
  } catch (_) {
    if (box)
      box.innerHTML = `<div class="alert a-w"><span class="ai">⚠️</span><span>Impossible de charger le statut des fournisseurs.</span></div>`;
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

// ── ZARA Hub section map (space + display label) ─────────────────
const ZARA_SECS = {
  dashboard: { space: "store", label: "📊 Dash" },
  team: { space: "store", label: "👥 Team" },
  dayplan: { space: "store", label: "🗓 Day Plan" },
  skills: { space: "store", label: "🎓 Skills" },
  followup: { space: "store", label: "📌 Staff" },
  sevendays: { space: "store", label: "🛡 7 Days" },
  feedback: { space: "store", label: "📝 Feedback" },
  dreport: { space: "store", label: "📋 Report" },
  reminder: { space: "store", label: "🔔 Alert" },
  "me-dash": { space: "me", label: "💶 Salary" },
  "me-shifts": { space: "me", label: "🕐 Shifts" },
  "me-audit": { space: "me", label: "⚖ Audit" },
  "me-import": { space: "me", label: "📥 Data" },
  "me-set": { space: "me", label: "⚙ Settings" },
};

// Navigate ZARA iframe to a specific section (same-origin → direct call)
function zaraGo(space, pageId) {
  const fInditex = el("toolFrameInditex");
  const fSchedule = el("toolFrameSchedule");
  if (!fInditex) return;

  // ── Switch to Schedule mode ──────────────────────────────────────
  if (space === "schedule") {
    fInditex.style.display = "none";
    fSchedule.style.display = "block";
    if (!fSchedule.src && fSchedule.dataset.src) fSchedule.src = fSchedule.dataset.src;

    document.querySelectorAll(".zara-sec-btn").forEach((b) => b.classList.remove("active"));
    el("zaraScheduleBtn")?.classList.add("active");
    if (el("zaraFrameLabel")) el("zaraFrameLabel").textContent = "📅 Schedule — Équipe";
    if (el("toolExpandLink")) el("toolExpandLink").href = "/tools/schedule-team.html";
    return;
  }

  // ── Switch to ZARA section ───────────────────────────────────────
  fInditex.style.display = "block";
  fSchedule.style.display = "none";

  // Update nav highlights
  document.querySelectorAll(".zara-sec-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === pageId);
  });
  el("zaraScheduleBtn")?.classList.remove("active");

  // Update topbar
  const sec = ZARA_SECS[pageId];
  if (sec && el("zaraFrameLabel")) el("zaraFrameLabel").textContent = sec.label;
  if (el("toolExpandLink")) el("toolExpandLink").href = "/tools/inditex-logistic.html";

  // Navigate inside the iframe via same-origin contentWindow call.
  // Use typeof-check instead of a dataset flag — the flag can miss if
  // the iframe already finished loading before the listener was wired.
  function navigate() {
    try {
      fInditex.contentWindow.hubShow(space, pageId);
    } catch (_) {}
  }
  const isReady = (() => {
    try {
      return typeof fInditex.contentWindow.hubShow === "function";
    } catch (_) {
      return false;
    }
  })();
  if (isReady) {
    navigate();
  } else {
    fInditex.addEventListener("load", function onLoad() {
      fInditex.removeEventListener("load", onLoad);
      navigate();
    });
  }
}

// Wire section picker buttons (called once on first Work tab visit)
function wireZaraSections() {
  if (el("zaraNavCard")?.dataset.wired) return;
  if (el("zaraNavCard")) el("zaraNavCard").dataset.wired = "1";

  document.querySelectorAll(".zara-sec-btn[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => zaraGo(btn.dataset.space, btn.dataset.page));
  });
  el("zaraScheduleBtn")?.addEventListener("click", () => zaraGo("schedule", "schedule"));
}

async function renderWork() {
  wireZaraSections();

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
  // Local token placeholders
  if (NXR.settings["ns_key"] && el("tkNS")) el("tkNS").placeholder = "•••••••• (sauvegardé)";
  if (NXR.settings["telegram_key"] && el("tkTelegram"))
    el("tkTelegram").placeholder = "•••••••• (sauvegardé)";
  if (NXR.settings["litellm_url"] && el("tkLiteLLM"))
    el("tkLiteLLM").value = NXR.settings["litellm_url"];

  // Account links — restore saved URLs
  const acctMap = {
    tgram1_url: "tkTgram1",
    tgram2_url: "tkTgram2",
    wa1_url: "tkWa1",
    wa2_url: "tkWa2",
    insta1_url: "tkInsta1",
    insta2_url: "tkInsta2",
  };
  Object.entries(acctMap).forEach(([settKey, inputId]) => {
    const inp = el(inputId);
    if (inp && NXR.settings[settKey]) inp.value = NXR.settings[settKey];
  });

  // Load free AI providers status
  renderProviders();
}

// Generic token-save handler (handles both password tokens AND URL account links)
document.querySelectorAll(".token-save").forEach((btn) => {
  btn.addEventListener("click", () => {
    // Map data-key → input element id
    const keyMap = {
      ns: "tkNS",
      telegram: "tkTelegram",
      litellm_url: "tkLiteLLM",
      tgram1_url: "tkTgram1",
      tgram2_url: "tkTgram2",
      wa1_url: "tkWa1",
      wa2_url: "tkWa2",
      insta1_url: "tkInsta1",
      insta2_url: "tkInsta2",
    };
    const inputEl = el(keyMap[btn.dataset.key]);
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (!val) return;

    // For URL-type keys store the value as-is; for token keys append "_key"
    const urlKeys = [
      "litellm_url",
      "tgram1_url",
      "tgram2_url",
      "wa1_url",
      "wa2_url",
      "insta1_url",
      "insta2_url",
    ];
    const storeKey = urlKeys.includes(btn.dataset.key) ? btn.dataset.key : btn.dataset.key + "_key";

    NXR.settings[storeKey] = val;
    localStorage.setItem("nxr_settings", JSON.stringify(NXR.settings));

    // For non-URL fields, mask the input after save
    if (!urlKeys.includes(btn.dataset.key)) {
      inputEl.value = "";
      inputEl.placeholder = "•••••••• (sauvegardé)";
    }
    toast("✅ Sauvegardé");
    addAudit("🔑", `Paramètre "${btn.dataset.key}" mis à jour`);
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
