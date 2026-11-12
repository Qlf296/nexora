#!/usr/bin/env node
/**
 * NEXORA Hub — LLM Router Test Script
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests each configured provider with a real API call and prints a status
 * dashboard showing latency, model, and pass/fail.
 *
 * Usage:
 *   # With .env file (recommended):
 *   node test_router.js
 *
 *   # Or inline:
 *   GROQ_API_KEY=gsk_... node test_router.js
 *
 *   # Test only specific providers:
 *   node test_router.js groq cohere
 *
 * Requirements: Node >= 18 (uses native fetch, no npm install needed)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env if present ────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const eq = stripped.indexOf("=");
    if (eq < 1) continue;
    const key = stripped.slice(0, eq).trim();
    const val = stripped
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && val && !process.env[key]) process.env[key] = val;
  }
  console.log("✅ Loaded .env\n");
}

// ── Provider definitions ────────────────────────────────────────────────────
const PROVIDERS = [
  {
    id: "groq",
    name: "Groq — Qwen 3.8 27B",
    envKey: "GROQ_API_KEY",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    enabled: true,
  },
  {
    id: "gemini",
    // gemini-3.5-flash-lite confirmed working for new API accounts (Nov 2026).
    // gemini-2.x-flash → "not available to new users"; gemini-3.8-flash → timeout (doesn't exist).
    // Authorization: Bearer is required — x-goog-api-key is rejected on the OpenAI-compat path.
    name: "Gemini 3.5 Flash Lite",
    envKey: "GEMINI_API_KEY",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    enabled: true,
  },
  {
    id: "openrouter",
    // All OpenRouter free-tier models as of Nov 2026 are reasoning-only.
    // content=null + reasoning="..." is expected and handled by the server's SSE transformer.
    // In this test script, reasoning replies are shown with a [reasoning] prefix.
    name: "OpenRouter (Nemotron 550B free)",
    envKey: "OPENROUTER_API_KEY",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
    authHeader: (k) => ({
      Authorization: `Bearer ${k}`,
      "HTTP-Referer": "https://nexora.local",
      "X-Title": "NEXORA Hub",
    }),
    enabled: true,
    reasoningFallback: true,
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM — Nemotron 70B",
    envKey: "NVIDIA_API_KEY",
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: process.env.NVIDIA_MODEL || "nvidia/llama-3.1-nemotron-70b-instruct",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    // STANDBY by default — requires model activation at build.nvidia.com
    enabled: process.env.NEXORA_ENABLE_NVIDIA === "true",
    standby: true,
  },
  {
    id: "cohere",
    name: "Cohere Command R+",
    envKey: "COHERE_API_KEY",
    endpoint: "https://api.cohere.com/compatibility/v1/chat/completions",
    model: process.env.COHERE_MODEL || "command-r-plus-08-2024",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    enabled: true,
  },
];

// ── Test prompt ─────────────────────────────────────────────────────────────
const TEST_MESSAGES = [{ role: "user", content: "Reply with exactly one word: NEXORA" }];

// ── Single provider test ────────────────────────────────────────────────────
async function testProvider(p) {
  const key = process.env[p.envKey];

  if (!key) {
    return {
      id: p.id,
      status: "NO_KEY",
      latency: null,
      model: p.model,
      detail: `${p.envKey} not set`,
    };
  }
  if (!p.enabled) {
    return {
      id: p.id,
      status: "STANDBY",
      latency: null,
      model: p.model,
      detail: "Disabled by default — set NEXORA_ENABLE_NVIDIA=true to test",
    };
  }

  const t0 = Date.now();
  try {
    const r = await fetch(p.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...p.authHeader(key) },
      body: JSON.stringify({
        model: p.model,
        messages: TEST_MESSAGES,
        max_tokens: 10,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const latency = Date.now() - t0;

    const json = await r.json().catch(() => null);

    if (!r.ok) {
      const errMsg = json?.error?.message || json?.detail || `HTTP ${r.status}`;
      return {
        id: p.id,
        status: "HTTP_ERROR",
        latency,
        model: p.model,
        detail: errMsg,
        httpStatus: r.status,
      };
    }

    // Extract content — handle reasoning-only models
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    const rawContent = msg?.content;
    const reasoningText = msg?.reasoning || msg?.reasoning_content;
    const content =
      rawContent !== null && rawContent !== undefined
        ? String(rawContent).trim()
        : reasoningText
          ? `[reasoning] ${String(reasoningText).slice(0, 80).trim()}…`
          : null;

    if (content === null) {
      return {
        id: p.id,
        status: "EMPTY_RESPONSE",
        latency,
        model: json?.model || p.model,
        detail: "Response had no content and no reasoning",
      };
    }

    return {
      id: p.id,
      status: "OK",
      latency,
      model: json?.model || p.model,
      content,
      detail: null,
    };
  } catch (err) {
    const latency = Date.now() - t0;
    if (err.name === "TimeoutError") {
      return {
        id: p.id,
        status: "TIMEOUT",
        latency,
        model: p.model,
        detail: "Request timed out after 15s",
      };
    }
    return { id: p.id, status: "ERROR", latency, model: p.model, detail: err.message };
  }
}

// ── Dashboard renderer ───────────────────────────────────────────────────────
const BADGE = {
  OK: "\x1b[32m✅ OK            \x1b[0m",
  STANDBY: "\x1b[33m⏸  STANDBY       \x1b[0m",
  NO_KEY: "\x1b[90m🔑 NO KEY        \x1b[0m",
  HTTP_ERROR: "\x1b[31m❌ HTTP ERROR    \x1b[0m",
  TIMEOUT: "\x1b[31m⌛ TIMEOUT       \x1b[0m",
  EMPTY_RESPONSE: "\x1b[33m⚠️  EMPTY RESP    \x1b[0m",
  ERROR: "\x1b[31m💥 ERROR         \x1b[0m",
};

function pad(str, n) {
  const s = String(str ?? "");
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function renderDashboard(results) {
  const W = 90;
  const HR = "─".repeat(W);
  console.log("\n" + "═".repeat(W));
  console.log("  NEXORA Hub — LLM Router Status Dashboard");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(W));
  console.log(
    `  ${pad("Provider", 32)} ${pad("Status", 20)} ${pad("Latency", 10)} ${pad("Model used", 42)}`,
  );
  console.log("  " + HR);

  for (const r of results) {
    const badge = BADGE[r.status] ?? r.status;
    const lat = r.latency !== null ? `${r.latency}ms` : "—";
    const model = r.model || "—";
    console.log(`  ${pad(r.id, 32)} ${badge} ${pad(lat, 10)} ${pad(model, 42)}`);
    if (r.status === "OK" && r.content) {
      console.log(`  ${"".padEnd(32)}   └─ reply: "${r.content}"`);
    } else if (r.detail) {
      console.log(`  ${"".padEnd(32)}   └─ ${r.detail}`);
    }
  }

  console.log("  " + HR);

  const ok = results.filter((r) => r.status === "OK").length;
  const standby = results.filter((r) => r.status === "STANDBY").length;
  const noKey = results.filter((r) => r.status === "NO_KEY").length;
  const failed = results.length - ok - standby - noKey;

  console.log(
    `  Summary: \x1b[32m${ok} OK\x1b[0m  ` +
      `\x1b[33m${standby} STANDBY\x1b[0m  ` +
      `\x1b[90m${noKey} NO_KEY\x1b[0m  ` +
      `\x1b[31m${failed} FAILED\x1b[0m`,
  );
  console.log("═".repeat(W) + "\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2);
const toTest = wanted.length > 0 ? PROVIDERS.filter((p) => wanted.includes(p.id)) : PROVIDERS;

console.log(`Testing ${toTest.length} provider(s): ${toTest.map((p) => p.id).join(", ")}`);
console.log("(non-streaming, max_tokens=10, timeout=15s)\n");

const results = await Promise.all(toTest.map(testProvider));
renderDashboard(results);

// Exit non-zero if any active provider failed
const activeFailed = results.some((r) => !["OK", "STANDBY", "NO_KEY"].includes(r.status));
process.exit(activeFailed ? 1 : 0);
