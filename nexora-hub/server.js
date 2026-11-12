// NEXORA Hub — single-page chat + control-center dashboard server.
//
// Zero external dependencies on purpose: this runs inside a small Docker
// image and must build fast and reliably with no network access beyond
// pulling the base Node image. Uses Node's built-in http + global fetch
// (Node >= 18).
//
// Responsibilities:
//   1. Serve the static frontend (./public).
//   2. Route chat requests to the best available AI provider:
//        a) Direct call to a free provider — cascade order:
//             Groq → Gemini → OpenRouter → NVIDIA NIM → Cohere
//           Activated when the matching env var is set in .env.
//        b) Fallback to the LiteLLM proxy (nexora-free / nexora-pro alias).
//      Smart cascading: if a free provider fails, the next one is tried
//      automatically. Pro (Claude) is used for complex tasks or explicit request.
//   3. Expose lightweight read-only widget endpoints backed by free public
//      APIs where one exists (GitHub, Reddit), with a clearly-labeled demo
//      fallback (`demo: true`) when a live fetch fails or no free API
//      applies (social accounts requiring OAuth).
//   4. Mirror the Utrecht team-availability Google Sheet (owned/automated by
//      Apps Script v6.8 — that script remains the sole source of truth for
//      scheduling, locking and emails) into a read-only JSON cache at
//      public/data/team-availability.json, served by handleTeamWidget below.

import fs from "node:fs";
import http from "node:http";
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
  const chars = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
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

// ---------------------------------------------------------------------------
// Authorized free provider pool — cascade order:
//   1. Groq       (ultra-fast, simple tasks)
//   2. Gemini     (complex / analytical / long context)
//   3. OpenRouter (100+ models, free tier)
//   4. NVIDIA NIM (Llama 3.3 70B on NVIDIA Inference Microservice)
//   5. Cohere     (RAG / enterprise, 20 req/min free)
//
// All five expose an OpenAI-compatible /v1/chat/completions endpoint.
// Set the matching env var (see .env) to activate a provider;
// unset = skipped silently.
// ---------------------------------------------------------------------------
const FREE_PROVIDERS = [
  {
    id: "groq",
    // Model: qwen/qwen3.8-27b (confirmed active on Groq free tier).
    // llama-3.3-70b-versatile and llama3-70b-8192 are decommissioned.
    name: "Groq — Qwen 3.8 27B",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
    tier: "free",
    specialty: "⚡ Ultra-rapide · conversations · FR/EN/AR/Darija",
    freeLimit: "14 400 req/jour · 6 000 tokens/min",
    getKey: "https://console.groq.com/keys",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  {
    id: "gemini",
    // Model: gemini-3.8-flash (recommended by Google for new accounts).
    // Auth: Gemini OpenAI-compat endpoint uses Authorization: Bearer.
    name: "Gemini 3.8 Flash",
    envKey: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    tier: "free",
    specialty: "🧠 Multimodal · analyse · contexte 1 M tokens",
    freeLimit: "1 500 req/jour · 1 M tokens/min",
    getKey: "https://aistudio.google.com/app/apikey",
    // Google's OpenAI-compat endpoint uses Bearer, NOT x-goog-api-key.
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  {
    id: "openrouter",
    // Free tier note: free models on OpenRouter are shared-pool and may be
    // rate-limited or reasoning-only. The cascade handles both gracefully.
    name: "OpenRouter (Gemma 4 31B free)",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    model: process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free",
    tier: "free",
    specialty: "🔀 Accès +100 modèles · fallback intelligent",
    freeLimit: "20 req/min sur modèles gratuits",
    getKey: "https://openrouter.ai/keys",
    authHeader: (key) => ({
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://nexora.local",
      "X-Title": "NEXORA Hub",
    }),
  },
  {
    id: "nvidia",
    // NVIDIA NIM requires models to be activated in your account at
    // build.nvidia.com before the API will route them successfully.
    // The key is valid; activate models in the NVIDIA console if 404s occur.
    name: "NVIDIA NIM — Nemotron 70B",
    envKey: "NVIDIA_API_KEY",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_MODEL || "nvidia/llama-3.1-nemotron-70b-instruct",
    tier: "free",
    specialty: "🟢 GPU accéléré · NVIDIA Inference Microservice",
    freeLimit: "1 000 req d'essai (crédit NIM gratuit)",
    getKey: "https://build.nvidia.com/explore/discover",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  {
    id: "cohere",
    name: "Cohere Command R+",
    envKey: "COHERE_API_KEY",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    model: process.env.COHERE_MODEL || "command-r-plus-08-2024",
    tier: "free",
    specialty: "🔍 RAG · recherche · entreprise",
    freeLimit: "20 req/min (clé d'essai)",
    getKey: "https://dashboard.cohere.com/api-keys",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
];

function getConfiguredFreeProviders() {
  return FREE_PROVIDERS.filter((p) => !!process.env[p.envKey]);
}

// pickModel kept as internal LiteLLM-only helper
function pickModel(messages, tierHint) {
  if (tierHint === "pro") return { model: "nexora-pro", tier: "pro" };
  if (tierHint === "free") return { model: "nexora-free", tier: "free" };
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = (
    lastUser && typeof lastUser.content === "string" ? lastUser.content : ""
  ).toLowerCase();
  const totalLength = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  const hitsKeyword = PRO_KEYWORDS.some((kw) => text.includes(kw));
  const isLong = totalLength > PRO_LENGTH_THRESHOLD;
  if (hitsKeyword || isLong) return { model: "nexora-pro", tier: "pro" };
  return { model: "nexora-free", tier: "free" };
}

// Smart provider selection — cascades through configured free providers;
// falls back to LiteLLM. For complex tasks prefers Gemini > OpenRouter;
// for simple/fast tasks prefers Groq > Gemini.
function pickProvider(messages, tierHint) {
  const configured = getConfiguredFreeProviders();

  // Explicit "pro" → LiteLLM / Claude always
  if (tierHint === "pro") return { type: "litellm", model: "nexora-pro", tier: "pro" };

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = (
    lastUser && typeof lastUser.content === "string" ? lastUser.content : ""
  ).toLowerCase();
  const totalLength = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  const isComplex =
    PRO_KEYWORDS.some((kw) => text.includes(kw)) || totalLength > PRO_LENGTH_THRESHOLD;

  // No free keys configured → old LiteLLM heuristic
  if (configured.length === 0) return { type: "litellm", ...pickModel(messages, tierHint) };

  // Explicit "free" → first configured free provider
  if (tierHint === "free") return { type: "direct", provider: configured[0], tier: "free" };

  // Auto: prefer Gemini/OpenRouter for complex, Groq for fast/simple
  // Authorized pool: Groq · Gemini · OpenRouter · NVIDIA NIM · Cohere
  const pref = isComplex
    ? ["gemini", "openrouter", "nvidia", "groq", "cohere"]
    : ["groq", "gemini", "openrouter", "nvidia", "cohere"];
  for (const id of pref) {
    const p = configured.find((c) => c.id === id);
    if (p) return { type: "direct", provider: p, tier: "free" };
  }

  return { type: "litellm", ...pickModel(messages, tierHint) };
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
// Chat — cascade through direct free providers, then fall back to LiteLLM.
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

  const choice = pickProvider(messages, parsed.tier);

  // Build ordered attempts: direct provider first, LiteLLM as safety net
  const attempts = [];
  if (choice.type === "direct") {
    const { provider } = choice;
    const key = process.env[provider.envKey];
    attempts.push({
      name: provider.name,
      tier: "free",
      endpoint: `${provider.baseUrl}/chat/completions`,
      headers: { "Content-Type": "application/json", ...provider.authHeader(key) },
      model: provider.model,
      label: `${provider.name} (direct)`,
    });
  }
  // LiteLLM fallback — always appended
  const llmFallback = choice.type === "litellm" ? choice : { model: "nexora-free", tier: "free" };
  attempts.push({
    name: "LiteLLM",
    tier: llmFallback.tier,
    endpoint: `${LITELLM_BASE_URL}/v1/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
    model: llmFallback.model,
    label: PROVIDER_LABELS[llmFallback.model] || llmFallback.model,
  });

  let upstream = null;
  let used = null;
  let lastErr = "";
  for (const attempt of attempts) {
    try {
      const r = await fetch(attempt.endpoint, {
        method: "POST",
        headers: attempt.headers,
        body: JSON.stringify({ model: attempt.model, messages, stream: true }),
      });
      if (r.ok && r.body) {
        upstream = r;
        used = attempt;
        break;
      }
      lastErr = `${attempt.name}: HTTP ${r.status}`;
    } catch (err) {
      lastErr = `${attempt.name} unreachable: ${err.message}`;
    }
  }

  if (!upstream || !used) {
    state.lastError = lastErr || "All providers unavailable";
    return sendJSON(res, 502, {
      error:
        "No AI provider could be reached. Configure a free API key in Settings or start the LiteLLM proxy.",
      detail: lastErr,
    });
  }

  // Update in-memory state
  state.lastModel = used.model;
  state.lastTier = used.tier;
  state.lastProviderLabel = used.label;
  state.lastError = null;
  if (used.tier === "free") {
    state.requestsFree += 1;
  } else {
    state.requestsPro += 1;
    state.estimatedCostUSD += (estimateTokens(messages) / 1000) * PRO_BLENDED_RATE_PER_1K_TOKENS;
  }

  // HTTP header values must be ASCII printable — strip any non-ASCII chars
  // (e.g. em-dashes in display names) before setting the header.
  const safeProviderName = used.name.replace(/[^\x20-\x7E]/g, "-").trim();
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Nexora-Model": used.model,
    "X-Nexora-Tier": used.tier,
    "X-Nexora-Provider": safeProviderName,
  });

  // Stream through, transforming SSE events on the fly.
  // Some providers (OpenRouter reasoning models, NVIDIA Nemotron) return
  // delta.content = null with the actual text in delta.reasoning.
  // We remap reasoning → content so the frontend receives a normal stream.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? ""; // keep the incomplete last fragment
      let out = "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          out += line + "\n";
          continue;
        }
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          out += line + "\n";
          continue;
        }
        try {
          const evt = JSON.parse(payload);
          const delta = evt?.choices?.[0]?.delta;
          if (delta && delta.content === null && delta.reasoning) {
            // Promote reasoning text to content for think-only models
            delta.content = delta.reasoning;
            delete delta.reasoning;
            delete delta.reasoning_details;
            out += `data: ${JSON.stringify(evt)}\n`;
          } else {
            out += line + "\n";
          }
        } catch {
          out += line + "\n";
        }
      }
      if (out) res.write(out);
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
    const repos = await fetchJSON(
      `https://api.github.com/users/${encodeURIComponent(user)}/repos?sort=updated&per_page=6`,
      {
        headers: { "User-Agent": "nexora-hub", Accept: "application/vnd.github+json" },
      },
    );
    sendJSON(res, 200, {
      demo: false,
      user,
      repos: repos.map((r) => ({
        name: r.name,
        stars: r.stargazers_count,
        url: r.html_url,
        updatedAt: r.updated_at,
      })),
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
    const json = await fetchJSON(
      `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=5`,
      {
        headers: { "User-Agent": "nexora-hub/0.1 (dashboard widget)" },
      },
    );
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
      posts: [{ title: "(placeholder) r/" + sub + " is quiet right now", url: "#", score: 0 }],
    });
  }
}

async function handleFinanceWidget(req, res, query) {
  const symbolsParam = query.get("symbols") || "AAPL,BTC-USD";
  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  try {
    const json = await fetchJSON(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`,
      { headers: { "User-Agent": "Mozilla/5.0 (nexora-hub widget)" } },
    );
    const quotes = (json?.quoteResponse?.result || []).map((q) => ({
      symbol: q.symbol || "—",
      // Yahoo's unauthenticated endpoint can return 200 OK with individual
      // fields missing (e.g. regularMarketPrice absent for a bad symbol).
      // Coerce to null/0 here so the frontend never has to interpolate a
      // raw `undefined` into the DOM.
      price: typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null,
      changePercent:
        typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent : 0,
      currency: q.currency || "USD",
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
      {
        platform: "WhatsApp",
        connected: false,
        note: "Requires WhatsApp Business API credentials.",
      },
      { platform: "Instagram", connected: false, note: "Requires Meta Graph API token." },
      { platform: "LinkedIn", connected: false, note: "Requires LinkedIn OAuth token." },
    ],
  });
}

const TEAM_CACHE_PATH = path.join(PUBLIC_DIR, "data", "team-availability.json");
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
    return {
      status: "active",
      window: active,
      daysRemaining: Math.ceil((parseISODate(active.to) - today) / 86400000),
    };
  }
  if (next) {
    return {
      status: "upcoming",
      window: next,
      daysUntil: Math.ceil((parseISODate(next.from) - today) / 86400000),
    };
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
      ? Math.round(
          withPercent.reduce((sum, e) => sum + e.availabilityPercent, 0) / withPercent.length,
        )
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
// NS train departures widget (station ARN → Utrecht Centraal)
// ---------------------------------------------------------------------------
function generateDemoTrains() {
  const now = new Date();
  return [5, 25, 50, 75, 95].map((offsetMin) => {
    const t = new Date(now.getTime() + offsetMin * 60000);
    return {
      plannedDepartureTime: t.toISOString(),
      direction: "Utrecht Centraal",
      plannedTrack: String(Math.floor(Math.random() * 8) + 1),
      delayMinutes: 0,
    };
  });
}

async function handleNSWidget(req, res) {
  const NS_KEY = process.env.NS_API_KEY;
  if (!NS_KEY) {
    return sendJSON(res, 200, {
      demo: true,
      note: "NS API key not configured. Set NS_API_KEY env variable.",
      departures: generateDemoTrains(),
      disruptions: [],
    });
  }
  try {
    const [depResp, disResp] = await Promise.all([
      fetchJSON(
        "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/departures?station=ARN&maxJourneys=10",
        { headers: { "Ocp-Apim-Subscription-Key": NS_KEY } },
      ),
      fetchJSON(
        "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/disruptions/station/ARN",
        { headers: { "Ocp-Apim-Subscription-Key": NS_KEY } },
      ).catch(() => ({ payload: [] })),
    ]);
    const all = depResp?.payload || [];
    const utrechtBound = all.filter(
      (d) =>
        (d.direction || "").toLowerCase().includes("utrecht") ||
        (d.routeStations || []).some((s) => (s.mediumName || "").toLowerCase().includes("utrecht")),
    );
    sendJSON(res, 200, {
      demo: false,
      station: "ARN",
      departures: (utrechtBound.length ? utrechtBound : all).slice(0, 10),
      disruptions: (disResp?.payload || []).slice(0, 5),
    });
  } catch (err) {
    sendJSON(res, 200, {
      demo: true,
      note: `NS API fetch failed (${err.message}). Check your NS_API_KEY.`,
      departures: generateDemoTrains(),
      disruptions: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Open-Meteo weather widget (Arnhem)
// ---------------------------------------------------------------------------
async function handleWeatherWidget(req, res) {
  try {
    const data = await fetchJSON(
      "https://api.open-meteo.com/v1/forecast?latitude=51.9851&longitude=5.8987&current_weather=true&hourly=temperature_2m,precipitation_probability&timezone=Europe%2FAmsterdam&forecast_days=1",
    );
    sendJSON(res, 200, { demo: false, ...data });
  } catch (err) {
    sendJSON(res, 200, {
      demo: true,
      note: `Weather fetch failed (${err.message})`,
      current_weather: { temperature: null, windspeed: null, weathercode: 0 },
    });
  }
}

// ---------------------------------------------------------------------------
// Free AI providers status widget
// ---------------------------------------------------------------------------
function handleProvidersWidget(req, res) {
  sendJSON(res, 200, {
    providers: FREE_PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      configured: !!process.env[p.envKey],
      envKey: p.envKey,
      tier: p.tier,
      specialty: p.specialty,
      freeLimit: p.freeLimit,
      getKey: p.getKey,
    })),
    litellm: {
      id: "litellm",
      name: "Claude Sonnet (via LiteLLM)",
      configured: true,
      envKey: "LITELLM_MASTER_KEY",
      tier: "pro",
      specialty: "🧩 Raisonnement complexe · code · stratégie",
      freeLimit: "Selon abonnement Anthropic — console.anthropic.com",
      getKey: "https://console.anthropic.com/settings/keys",
    },
  });
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
    if (url.pathname === "/api/router/providers") {
      return handleProvidersWidget(req, res);
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
    if (url.pathname === "/api/widgets/ns") {
      return await handleNSWidget(req, res);
    }
    if (url.pathname === "/api/widgets/weather") {
      return await handleWeatherWidget(req, res);
    }

    return serveStatic(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: "Internal error", detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[nexora-hub] listening on :${PORT} -> LiteLLM at ${LITELLM_BASE_URL}`);
});
