// NEXORA Hub — frontend logic (chat streaming + widget dashboard)
"use strict";

/* ===================== STATE ===================== */
let pendingAttachments = []; // [{name}]
let chatHistory = []; // [{role, content}]

/* ===================== DOM REFS ===================== */
const chatMessagesEl = document.getElementById("chatMessages");
const chatAttachmentsEl = document.getElementById("chatAttachments");
const chatFormEl = document.getElementById("chatForm");
const chatInputEl = document.getElementById("chatInput");
const fileInputEl = document.getElementById("fileInput");
const attachBtnEl = document.getElementById("attachBtn");
const tierSelectEl = document.getElementById("tierSelect");
const sendBtnEl = document.getElementById("sendBtn");

const routerPillDotEl = document.getElementById("routerPillDot");
const routerPillTextEl = document.getElementById("routerPillText");

const rsModelEl = document.getElementById("rsModel");
const rsTierEl = document.getElementById("rsTier");
const rsFreeEl = document.getElementById("rsFree");
const rsProEl = document.getElementById("rsPro");
const rsCostEl = document.getElementById("rsCost");
const rsErrorRowEl = document.getElementById("rsErrorRow");
const rsErrorEl = document.getElementById("rsError");

const financeBadgeEl = document.getElementById("financeBadge");
const financeBodyEl = document.getElementById("financeBody");
const socialBadgeEl = document.getElementById("socialBadge");
const socialBodyEl = document.getElementById("socialBody");
const teamBadgeEl = document.getElementById("teamBadge");
const teamBodyEl = document.getElementById("teamBody");
const githubBadgeEl = document.getElementById("githubBadge");
const githubBodyEl = document.getElementById("githubBody");
const redditBadgeEl = document.getElementById("redditBadge");
const redditBodyEl = document.getElementById("redditBody");

const refreshAllBtnEl = document.getElementById("refreshAll");

/* ===================== HELPERS ===================== */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function appendMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-" + role;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chatMessagesEl.appendChild(wrap);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return bubble;
}

function setBadge(el, demo, { live = "live", demoLabel = "demo", error = false } = {}) {
  if (!el) return;
  el.classList.remove("badge-live", "badge-demo", "badge-error");
  if (error) {
    el.classList.add("badge-error");
    el.textContent = "erreur";
  } else if (demo) {
    el.classList.add("badge-demo");
    el.textContent = demoLabel;
  } else {
    el.classList.add("badge-live");
    el.textContent = live;
  }
}

function fmtUsd(n) {
  const v = Number(n) || 0;
  return "$" + v.toFixed(v < 1 ? 4 : 2);
}

/* ===================== ATTACHMENTS ===================== */
function renderAttachments() {
  chatAttachmentsEl.innerHTML = "";
  if (pendingAttachments.length === 0) {
    chatAttachmentsEl.hidden = true;
    return;
  }
  chatAttachmentsEl.hidden = false;
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = "📎 " + att.name;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.title = "Retirer";
    removeBtn.addEventListener("click", () => {
      pendingAttachments.splice(idx, 1);
      renderAttachments();
    });
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    chatAttachmentsEl.appendChild(chip);
  });
}

attachBtnEl.addEventListener("click", () => fileInputEl.click());

fileInputEl.addEventListener("change", () => {
  const files = Array.from(fileInputEl.files || []);
  files.forEach((f) => pendingAttachments.push({ name: f.name }));
  fileInputEl.value = "";
  renderAttachments();
});

/* ===================== ROUTER PILL ===================== */
function updateRouterPill(tier, label) {
  if (!tier) return;
  routerPillDotEl.classList.remove("dot-free", "dot-pro");
  routerPillDotEl.classList.add(tier === "pro" ? "dot-pro" : "dot-free");
  routerPillTextEl.textContent = label || (tier === "pro" ? "Pro (Claude)" : "Gratuit");
}

/* ===================== CHAT SEND / STREAM ===================== */
function autoResizeTextarea() {
  chatInputEl.style.height = "auto";
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 140) + "px";
}
chatInputEl.addEventListener("input", autoResizeTextarea);
chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatFormEl.requestSubmit();
  }
});

chatFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = chatInputEl.value.trim();
  if (!raw && pendingAttachments.length === 0) return;

  let outgoing = raw;
  if (pendingAttachments.length > 0) {
    const names = pendingAttachments.map((a) => a.name).join(", ");
    outgoing = (raw ? raw + "\n\n" : "") + "[Pièces jointes: " + names + "]";
  }

  appendMessage("user", outgoing);
  chatHistory.push({ role: "user", content: outgoing });

  chatInputEl.value = "";
  autoResizeTextarea();
  pendingAttachments = [];
  renderAttachments();

  const tierChoice = tierSelectEl.value; // auto | free | pro
  const body = { messages: chatHistory };
  if (tierChoice !== "auto") body.tier = tierChoice;

  sendBtnEl.disabled = true;
  const assistantBubble = appendMessage("assistant", "…");
  assistantBubble.textContent = "";

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const modelHeader = resp.headers.get("X-Nexora-Model");
    const tierHeader = resp.headers.get("X-Nexora-Tier");
    if (tierHeader) updateRouterPill(tierHeader, modelHeader);

    if (!resp.ok || !resp.body) {
      let detail = "";
      try {
        const errJson = await resp.json();
        detail = errJson.detail || errJson.error || "";
      } catch (_) {
        /* not json */
      }
      assistantBubble.textContent = "⚠️ Erreur (" + resp.status + ")" + (detail ? " — " + detail : "");
      sendBtnEl.disabled = false;
      refreshRouterStatus();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete tail

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            assistantBubble.textContent = fullText;
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
          }
        } catch (_) {
          /* ignore malformed chunk */
        }
      }
    }

    if (!fullText) fullText = "(réponse vide)";
    chatHistory.push({ role: "assistant", content: fullText });
  } catch (err) {
    assistantBubble.textContent = "⚠️ Erreur réseau: " + (err?.message || err);
  } finally {
    sendBtnEl.disabled = false;
    refreshRouterStatus();
  }
});

/* ===================== ROUTER STATUS ===================== */
async function refreshRouterStatus() {
  try {
    const resp = await fetch("/api/router/status");
    if (!resp.ok) throw new Error("status " + resp.status);
    const s = await resp.json();

    rsModelEl.textContent = s.lastProviderLabel || s.lastModel || "—";
    rsTierEl.textContent = s.lastTier || "—";
    rsFreeEl.textContent = s.requestsFree ?? 0;
    rsProEl.textContent = s.requestsPro ?? 0;
    rsCostEl.textContent = fmtUsd(s.estimatedCostUSD);

    if (s.lastTier) updateRouterPill(s.lastTier, s.lastProviderLabel);

    if (s.lastError) {
      rsErrorRowEl.hidden = false;
      rsErrorEl.textContent = s.lastError;
    } else {
      rsErrorRowEl.hidden = true;
    }
  } catch (_) {
    rsErrorRowEl.hidden = false;
    rsErrorEl.textContent = "Impossible de contacter le routeur";
  }
}

/* ===================== WIDGETS ===================== */
async function loadGithubWidget() {
  githubBodyEl.textContent = "Chargement…";
  try {
    const resp = await fetch("/api/widgets/github");
    const data = await resp.json();
    setBadge(githubBadgeEl, data.demo);
    if (!data.repos || data.repos.length === 0) {
      githubBodyEl.textContent = "Aucun dépôt.";
      return;
    }
    githubBodyEl.innerHTML =
      data.repos
        .map(
          (r) =>
            `<div class="list-row"><a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(
              r.name
            )}</a><span>★ ${r.stars}</span></div>`
        )
        .join("") + (data.note ? `<div class="widget-note">${escapeHtml(data.note)}</div>` : "");
  } catch (err) {
    setBadge(githubBadgeEl, false, { error: true });
    githubBodyEl.textContent = "Erreur de chargement.";
  }
}

async function loadRedditWidget() {
  redditBodyEl.textContent = "Chargement…";
  try {
    const resp = await fetch("/api/widgets/reddit");
    const data = await resp.json();
    setBadge(redditBadgeEl, data.demo);
    if (!data.posts || data.posts.length === 0) {
      redditBodyEl.textContent = "Aucun post.";
      return;
    }
    redditBodyEl.innerHTML =
      data.posts
        .map(
          (p) =>
            `<div class="list-row"><a href="${p.url}" target="_blank" rel="noopener">${escapeHtml(
              p.title
            )}</a><span>${p.score}</span></div>`
        )
        .join("") + (data.note ? `<div class="widget-note">${escapeHtml(data.note)}</div>` : "");
  } catch (err) {
    setBadge(redditBadgeEl, false, { error: true });
    redditBodyEl.textContent = "Erreur de chargement.";
  }
}

async function loadFinanceWidget() {
  financeBodyEl.textContent = "Chargement…";
  try {
    const resp = await fetch("/api/widgets/finance");
    const data = await resp.json();
    setBadge(financeBadgeEl, data.demo);
    if (!data.quotes || data.quotes.length === 0) {
      financeBodyEl.textContent = "Aucune cotation.";
      return;
    }
    financeBodyEl.innerHTML =
      data.quotes
        .map((q) => {
          const pct = Number(q.changePercent) || 0;
          const sign = pct >= 0 ? "+" : "";
          // q.price may be null when Yahoo's endpoint omits the field;
          // never let a raw null/undefined leak into the template.
          const priceStr = typeof q.price === "number" ? q.price : "—";
          return `<div class="router-stat"><span class="label">${escapeHtml(
            q.symbol
          )}</span><span class="value">${priceStr} ${escapeHtml(q.currency || "")} (${sign}${pct.toFixed(
            2
          )}%)</span></div>`;
        })
        .join("") + (data.note ? `<div class="widget-note">${escapeHtml(data.note)}</div>` : "");
  } catch (err) {
    setBadge(financeBadgeEl, false, { error: true });
    financeBodyEl.textContent = "Erreur de chargement.";
  }
}

async function loadSocialWidget() {
  socialBodyEl.textContent = "Chargement…";
  try {
    const resp = await fetch("/api/widgets/social");
    const data = await resp.json();
    setBadge(socialBadgeEl, data.demo);
    socialBodyEl.innerHTML = (data.platforms || [])
      .map(
        (p) =>
          `<div class="social-row"><span><span class="status-dot ${
            p.connected ? "status-on" : "status-off"
          }"></span>${escapeHtml(p.platform)}</span><span class="widget-note">${escapeHtml(
            p.note || ""
          )}</span></div>`
      )
      .join("");
  } catch (err) {
    setBadge(socialBadgeEl, false, { error: true });
    socialBodyEl.textContent = "Erreur de chargement.";
  }
}

async function loadTeamWidget() {
  teamBodyEl.textContent = "Chargement…";
  try {
    const resp = await fetch("/api/widgets/team");
    const data = await resp.json();
    setBadge(teamBadgeEl, data.demo, { live: "live", demoLabel: "demo" });

    if (data.demo) {
      teamBodyEl.innerHTML = `<div class="widget-note">${escapeHtml(
        data.note || "Données indisponibles."
      )}</div>`;
      return;
    }

    const week = data.week || {};
    const managers = data.managers || [];
    const absences = data.todayAbsences || [];
    const vac = data.vacationStatus || {};
    const requests = data.vacationRequests || [];

    const managersHtml =
      managers
        .map((m) => `${escapeHtml(m.name)}${m.role ? " (" + escapeHtml(m.role) + ")" : ""}`)
        .join(" · ") || "—";

    const absencesHtml = absences.length
      ? absences
          .map(
            (a) =>
              `<div class="list-row"><span>${escapeHtml(a.name)}${
                a.role ? " <span class=\"widget-note\" style=\"display:inline\">(" + escapeHtml(a.role) + ")</span>" : ""
              }</span><span>${escapeHtml(a.detail)}</span></div>`
          )
          .join("")
      : `<div class="list-row"><span>Équipe complète aujourd'hui</span><span>✓</span></div>`;

    let vacationHtml = "";
    if (vac.status === "active" && vac.window) {
      vacationHtml = `<div class="vacation-banner vacation-active">🌴 Fenêtre de vacances en cours (${escapeHtml(
        vac.window.from
      )} → ${escapeHtml(vac.window.to)}) — ${vac.daysRemaining} j restants</div>`;
    } else if (vac.status === "upcoming" && vac.window) {
      vacationHtml = `<div class="vacation-banner vacation-upcoming">📅 Prochaine fenêtre de vacances : ${escapeHtml(
        vac.window.from
      )} → ${escapeHtml(vac.window.to)} (dans ${vac.daysUntil} j)</div>`;
    }

    const requestsHtml = requests.length
      ? requests
          .map(
            (r) =>
              `<div class="list-row"><span>${escapeHtml(r.name)}</span><span>${escapeHtml(
                r.status
              )} · ${escapeHtml(r.date)}</span></div>`
          )
          .join("")
      : "";

    teamBodyEl.innerHTML = `
      <div class="router-stat"><span class="label">Semaine</span><span class="value">${escapeHtml(
        week.range || "—"
      )}</span></div>
      <div class="router-stat"><span class="label">Verrouillage</span><span class="value">${escapeHtml(
        week.lockDeadline || "—"
      )}</span></div>
      <div class="router-stat"><span class="label">Effectif</span><span class="value">${
        data.teamSize ?? "—"
      }</span></div>
      <div class="router-stat"><span class="label">Disponibilité moy.</span><span class="value">${
        data.weeklyAveragePercent != null ? data.weeklyAveragePercent + "%" : "—"
      }</span></div>
      <div class="widget-note">Managers : ${managersHtml}</div>
      ${vacationHtml}
      <div class="team-section-title">Absences aujourd'hui${
        data.todayName ? " (" + escapeHtml(data.todayName) + ")" : ""
      }</div>
      ${absencesHtml}
      ${
        requestsHtml
          ? `<div class="team-section-title">Demandes de vacances en attente</div>${requestsHtml}`
          : ""
      }
      ${
        data.sheetUrl
          ? `<div class="widget-note"><a href="${data.sheetUrl}" target="_blank" rel="noopener">Ouvrir la feuille Google Sheets ↗</a></div>`
          : ""
      }
      ${data.note ? `<div class="widget-note">${escapeHtml(data.note)}</div>` : ""}
    `;
  } catch (err) {
    setBadge(teamBadgeEl, false, { error: true });
    teamBodyEl.textContent = "Erreur de chargement.";
  }
}

function loadAllWidgets() {
  loadGithubWidget();
  loadRedditWidget();
  loadFinanceWidget();
  loadSocialWidget();
  loadTeamWidget();
  refreshRouterStatus();
}

refreshAllBtnEl.addEventListener("click", loadAllWidgets);

/* ===================== INIT ===================== */
loadAllWidgets();
setInterval(loadAllWidgets, 60000);

/* ===================== PWA: SERVICE WORKER ===================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("NEXORA Hub: service worker registration failed", err);
    });
  });
}

/* ===================== PERSONNEL — TRAVAIL (tool tabs) ===================== */
const toolTabs = document.querySelectorAll(".tool-tab[data-tool]");
const toolFrames = {
  inditex: document.getElementById("toolFrameInditex"),
  schedule: document.getElementById("toolFrameSchedule"),
};
const toolExpandLink = document.getElementById("toolExpandLink");
const toolHrefs = {
  inditex: "/tools/inditex-logistic.html",
  schedule: "/tools/schedule-team.html",
};

function activateTool(name) {
  toolTabs.forEach((btn) => {
    const isActive = btn.dataset.tool === name;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  Object.entries(toolFrames).forEach(([key, frame]) => {
    if (!frame) return;
    const isActive = key === name;
    frame.classList.toggle("active", isActive);
    if (isActive && !frame.getAttribute("src") && frame.dataset.src) {
      frame.setAttribute("src", frame.dataset.src);
    }
  });
  if (toolExpandLink && toolHrefs[name]) {
    toolExpandLink.setAttribute("href", toolHrefs[name]);
  }
}

toolTabs.forEach((btn) => {
  btn.addEventListener("click", () => activateTool(btn.dataset.tool));
});

/* ===================== THEME (light/dark) ===================== */
const THEME_KEY = "nexora_theme";
const themeToggleBtn = document.getElementById("themeToggleBtn");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  if (themeToggleBtn) themeToggleBtn.textContent = theme === "light" ? "☀️" : "🌙";
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") {
    applyTheme(stored);
    return;
  }
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(prefersLight ? "light" : "dark");
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const next = current === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

initTheme();
