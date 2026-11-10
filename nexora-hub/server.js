// NEXORA Hub — single-page chat + control-center dashboard server.
//
// Zero external dependencies on purpose: this runs inside a small Docker
// image and must build fast and reliably with no network access beyond
// pulling the base Node image. Uses Node's built-in http + global fetch
// (Node >= 18).
//
// Responsibilities:
//   1. Serve the static frontend (./public).
//   2. Proxy chat requests to the LiteLLM proxy (/v1/chat/completions),
//      picking the "nexora-free" or "nexora-pro" model alias per request
//      (see pickModel below) and streaming the SSE response straight back.
//   3. Expose lightweight read-only widget endpoints backed by free public
//      APIs where one exists (GitHub, Reddit), with a clearly-labeled demo
//      fallback (`demo: true`) when a live fetch fails or no free API
//      applies (social accounts requiring OAuth).
//   4. Mirror the Utrecht team-availability Google Sheet (owned/automated by
//      Apps Script v6.8 — that script remains the sole source of truth for
//      scheduling, locking and emails) into a read-only JSON cache at
//      public/data/team-availability.json, served by handleTeamWidget below.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 3001);
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://host.docker.internal:31140";
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY || "sk-nexora-local-1234";

// ---------------------------------------------------------------------------
// In-memory router state (reset on restart — this is a status indicator for
// the "AI Router Status" widget, not a billing ledger).
// ---------------------------------------------------------------------------
const state = {
  lastModel: null,
  lastTier: null,
  lastProviderLabel: null,
  requestsFree: 0,
  requestsPro: 0,
  estimatedCostUSD: 0,
  lastError: null,
  startedAt: new Date().toISOString(),
};

const PROVIDER_LABELS = {
  "nexora-free": "Groq / Gemini Flash / Ollama (free tier)",
  "nexora-pro": "Claude (Anthropic, pro fallback)",
};

// Rough, clearly-labeled cost estimate for Claude usage only — the Hub never
// bills anyone, this just gives the widget a number to show. ~$3/M input +
// $15/M output tokens, approximated as a single blended rate since we don't
// split input/output here.
const PRO_BLENDED_RATE_PER_1K_TOKENS = 0.006;

function estimateTokens(messages) {
  const chars = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
  return Math.max(1, Math.ceil(chars / 4));
}

// Simple, transparent complexity heuristic. The brief asks for Claude to be
// triggered "only when the task requires complex analysis, heavy code, or a
// strategic decision" — this is a first pass; tune the keyword list / length
// threshold freely, nothing downstream depends on the exact cutoff.
const PRO_KEYWORDS = [
  "```",
  "analyse approfondie",
  "analyse stratégique",
  "stratégie",
  "strategic",
  "architecture",
  "refactor",
  "audit",
  "debug",
  "complexe",
  "complex",
  "algorithme",
  "algorithm",
  "optimis",
  "sécurité",
  "security",
  "production",
  "déploiement",
  "deploy",
  "pipeline",
];
const PRO_LENGTH_THRESHOLD = 800;

function pickModel(messages, tierHint) {
  if (tierHint === "pro") return { model: "nexora-pro", tier: "pro" };
  if (tierHint === "free") return { model: "nexora-free", tier: "free" };

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = (lastUser && typeof lastUser.content === "string" ? lastUser.content : "").toLowerCase();
  const totalLength = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);

  const hitsKeyword = PRO_KEYWORDS.some((kw) => text.includes(kw));
  const isLong = totalLength > PRO_LENGTH_THRESHOLD;

  if (hitsKeyword || isLong) return { model: "nexora-pro", tier: "pro" };
  return { model: "nexora-free", tier: "free" };
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relative = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));

  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Chat proxy -> LiteLLM (/v1/chat/completions, streamed straight through)
// ---------------------------------------------------------------------------
async function handleChat(req, res) {
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = JSON.parse(raw || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) {
    return sendJSON(res, 400, { error: "`messages` array is required" });
  }

  const { model, tier } = pickModel(messages, parsed.tier);

  state.lastModel = model;
  state.lastTier = tier;
  state.lastProviderLabel = PROVIDER_LABELS[model];
  if (tier === "free") {
    state.requestsFree += 1;
  } else {
    state.requestsPro += 1;
    const tokens = estimateTokens(messages);
    state.estimatedCostUSD += (tokens / 1000) * PRO_BLENDED_RATE_PER_1K_TOKENS;
  }

  let upstream;
  try {
    upstream = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (err) {
    state.lastError = `LiteLLM unreachable: ${err.message}`;
    return sendJSON(res, 502, {
      error: "Could not reach the LiteLLM proxy. Is it running? (launchd/start-litellm.sh)",
      detail: err.message,
    });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    state.lastError = `LiteLLM responded ${upstream.status}`;
    return sendJSON(res, upstream.status || 502, { error: "LiteLLM error", detail: detail.slice(0, 2000) });
  }

  state.lastError = null;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Nexora-Model": model,
    "X-Nexora-Tier": tier,
  });

  const reader = upstream.body.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    state.lastError = `Stream interrupted: ${err.message}`;
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Widget endpoints — free public data where available, demo fallback always.
// ---------------------------------------------------------------------------
async function fetchJSON(url, init, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function handleGithubWidget(req, res, query) {
  const user = query.get("user") || "openclaw";
  try {
    const repos = await fetchJSON(`https://api.github.com/users/${encodeURIComponent(user)}/repos?sort=updated&per_page=6`, {
      headers: { "User-Agent": "nexora-hub", Accept: "application/vnd.github+json" },
    });
    sendJSON(res, 200, {
      demo: false,
      user,
      repos: repos.map((r) => ({ name: r.name, stars: r.stargazers_count, url: r.html_url, updatedAt: r.updated_at })),
    });
  } catch (err) {
    sendJSON(res, 200, {
      demo: true,
      user,
      note: `Live GitHub fetch failed (${err.message}); showing placeholder data.`,
      repos: [
        { name: "nexora-hub", stars: 0, url: "#", updatedAt: new Date().toISOString() },
        { name: "openclaw", stars: 0, url: "#", updatedAt: new Date().toISOString() },
      ],
    });
  }
}

async function handleRedditWidget(req, res, query) {
  const sub = query.get("sub") || "technology";
  try {
    const json = await fetchJSON(`https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=5`, {
      headers: { "User-Agent": "nexora-hub/0.1 (dashboard widget)" },
    });
    const posts = (json?.data?.children || []).map((c) => ({
      title: c.data.title,
      url: `https://reddit.com${c.data.permalink}`,
      score: c.data.score,
    }));
    sendJSON(res, 200, { demo: false, sub, posts });
  } catch (err) {
    sendJSON(res, 200, {
      demo: true,
      sub,
      note: `Live Reddit fetch failed (${err.message}); showing placeholder data.`,
      posts: [
        { title: "(placeholder) r/" + sub + " is quiet right now", url: "#", score: 0 },
      ],
    });
  }
}

async function handleFinanceWidget(req, res, query) {
  const symbolsParam = query.get("symbols") || "AAPL,BTC-USD";
  const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  try {
    const json = await fetchJSON(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`,
      { headers: { "User-Agent": "Mozilla/5.0 (nexora-hub widget)" } },
    );
    const quotes = (json?.quoteResponse?.result || []).map((q) => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      changePercent: q.regularMarketChangePercent,
      currency: q.currency,
    }));
    if (quotes.length === 0) throw new Error("empty result");
    sendJSON(res, 200, { demo: false, quotes });
  } catch (err) {
    sendJSON(res, 200, {
      demo: true,
      note: `Live quote fetch failed (${err.message}); showing placeholder data. Swap in the repo's extensions/yfinance plugin for real signals.`,
      quotes: symbols.map((symbol) => ({ symbol, price: 0, changePercent: 0, currency: "USD" })),
    });
  }
}

function handleSocialWidget(req, res) {
  // Telegram / WhatsApp / Instagram / LinkedIn require OAuth or bot tokens
  // that this Hub does not hold yet — ship as explicit "not connected"
  // placeholders rather than faking activity.
  sendJSON(res, 200, {
    demo: true,
    platforms: [
      { platform: "Telegram", connected: false, note: "Connect TELEGRAM_BOT_TOKEN to enable." },
      { platform: "WhatsApp", connected: false, note: "Requires WhatsApp Business API credentials." },
      { platform: "Instagram", connected: false, note: "Requires Meta Graph API token." },
      { platform: "LinkedIn", connected: false, note: "Requires LinkedIn OAuth token." },
    ],
  });
}

const TEAM_CACHE_PATH = path.join(PUBLIC_DIR, "data", "team-availability.json");
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function parseISODate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Finds the vacation window that contains today, or the next upcoming one.
function computeVacationStatus(approvedWindows, today) {
  let next = null;
  let active = null;
  for (const w of approvedWindows || []) {
    const from = parseISODate(w.from);
    const to = parseISODate(w.to);
    if (today >= from && today <= to) {
      active = w;
    } else if (from > today && (!next || from < parseISODate(next.from))) {
      next = w;
    }
  }
  if (active) {
    return { status: "active", window: active, daysRemaining: Math.ceil((parseISODate(active.to) - today) / 86400000) };
  }
  if (next) {
    return { status: "upcoming", window: next, daysUntil: Math.ceil((parseISODate(next.from) - today) / 86400000) };
  }
  return { status: "none", window: null };
}

async function handleTeamWidget(req, res) {
  try {
    const raw = await fs.promises.readFile(TEAM_CACHE_PATH, "utf8");
    const cache = JSON.parse(raw);

    const today = new Date();
    const todayName = DAY_NAMES[today.getUTCDay()];

    const employees = cache.employees || [];
    const roster = employees.filter((e) => !e.notInWeeklySheet);

    const todayAbsences = roster
      .filter((e) => e.unavailability && e.unavailability[todayName])
      .map((e) => ({ name: e.name, role: e.role, detail: e.unavailability[todayName] }));

    const withPercent = roster.filter((e) => typeof e.availabilityPercent === "number");
    const weeklyAveragePercent = withPercent.length
      ? Math.round(withPercent.reduce((sum, e) => sum + e.availabilityPercent, 0) / withPercent.length)
      : null;

    const vacationStatus = computeVacationStatus(cache.vacationPlan?.approvedWindows, today);

    sendJSON(res, 200, {
      demo: false,
      generatedAt: cache.generatedAt,
      sheetUrl: cache.source?.sheetUrl,
      week: cache.week,
      managers: cache.managers,
      teamSize: roster.length,
      weeklyAveragePercent,
      todayName,
      todayAbsences,
      vacationStatus,
      vacationRequests: cache.vacationPlan?.requests || [],
      vacationLegend: cache.vacationPlan?.legend || {},
      employees: roster.map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
        availabilityPercent: e.availabilityPercent,
        unavailability: e.unavailability,
      })),
      note: "Mirror of the Utrecht team-availability sheet. Apps Script v6.8 remains authoritative for locking/emails inside Google Sheets.",
    });
  } catch (err) {
    sendJSON(res, 200, {
      demo: true,
      note: `Team availability cache unavailable (${err.message}). Run the sync job to regenerate public/data/team-availability.json.`,
      employees: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/healthz") {
      return sendJSON(res, 200, { status: "ok", uptimeSeconds: process.uptime() });
    }
    if (url.pathname === "/api/router/status") {
      return sendJSON(res, 200, state);
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      return await handleChat(req, res);
    }
    if (url.pathname === "/api/widgets/github") {
      return await handleGithubWidget(req, res, url.searchParams);
    }
    if (url.pathname === "/api/widgets/reddit") {
      return await handleRedditWidget(req, res, url.searchParams);
    }
    if (url.pathname === "/api/widgets/finance") {
      return await handleFinanceWidget(req, res, url.searchParams);
    }
    if (url.pathname === "/api/widgets/social") {
      return handleSocialWidget(req, res);
    }
    if (url.pathname === "/api/widgets/team") {
      return await handleTeamWidget(req, res);
    }

    return serveStatic(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: "Internal error", detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[nexora-hub] listening on :${PORT} -> LiteLLM at ${LITELLM_BASE_URL}`);
});
