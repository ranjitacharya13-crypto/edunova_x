#!/usr/bin/env node
/**
 * EduNova_X — production verification script.
 *
 * Checks the full production chain with zero dependencies (Node 18+ global
 * fetch):
 *
 *   Cloudflare frontend  →  Render Node API  →  MongoDB  →  AI engine
 *
 * Usage:
 *   node scripts/verify-production.js
 *   node scripts/verify-production.js --ai-url https://edunova-ai.onrender.com
 *
 * Overrides (env vars):
 *   PROD_FRONTEND_URL  (default https://edunova-x.ranjitacharya13.workers.dev)
 *   PROD_API_URL       (default https://edunova-api-y3rx.onrender.com)
 *   PROD_AI_URL        (default https://edunova-ai-o2vy.onrender.com)
 *   PROD_AUTH_TOKEN     (optional JWT; enables a real end-to-end AI response)
 *
 * Without PROD_AUTH_TOKEN the script still proves that POST /api/ai/chat is
 * mounted by requiring an authentication response instead of a 404.
 * Exit code 0 = every check passed. Non-zero = at least one check failed.
 * TURN is a browser-side ICE configuration: this script verifies the app
 * source wires VITE_TURN_URL correctly, but real TURN connectivity still
 * requires a two-peer browser test (see DEPLOYMENT.md §4).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FRONTEND_URL = (
  process.env.PROD_FRONTEND_URL || "https://edunova-x.ranjitacharya13.workers.dev"
).replace(/\/+$/, "");
const API_URL = (process.env.PROD_API_URL || "https://edunova-api-y3rx.onrender.com").replace(/\/+$/, "");
const AI_URL = (
  process.env.PROD_AI_URL ||
  process.argv.find((a, i) => a === "--ai-url" && process.argv[i + 1]) ||
  "https://edunova-ai-o2vy.onrender.com"
).replace(/\/+$/, "");
const AUTH_TOKEN = String(process.env.PROD_AUTH_TOKEN || "").trim();

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, err.message || String(err));
  }
}

const timeout = (ms, label) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms));

async function getJson(url, label) {
  const res = await Promise.race([fetch(url, { redirect: "follow" }), timeout(20000, label)]);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep null
  }
  if (!res.ok) {
    throw new Error(`${label} -> HTTP ${res.status}${json && json.error ? `: ${json.error}` : ""}`);
  }
  return { res, json, text };
}

(async () => {
  console.log(`\nEduNova_X production verification`);
  console.log(`  Frontend: ${FRONTEND_URL}`);
  console.log(`  API:      ${API_URL}`);
  console.log(`  AI:       ${AI_URL || "(not provided — AI checks will be skipped)"}\n`);

  // 1. Frontend (Cloudflare Workers)
  await check("Frontend loads", async () => {
    const res = await Promise.race([fetch(FRONTEND_URL, { redirect: "follow" }), timeout(20000, "frontend")]);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/<html/i.test(text)) throw new Error("response is not HTML");
    return `HTTP ${res.status}, HTML served`;
  });

  for (const expectedSize of [192, 512]) {
    await check(`PWA icon ${expectedSize}x${expectedSize}`, async () => {
      const res = await Promise.race([
        fetch(`${FRONTEND_URL}/icon-${expectedSize}.png`),
        timeout(20000, `icon-${expectedSize}`),
      ]);
      const bytes = Buffer.from(await res.arrayBuffer());
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!contentType.toLowerCase().startsWith("image/png")) {
        throw new Error(`content-type=${contentType || "(missing)"}`);
      }
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
        throw new Error("response is not a PNG image");
      }
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width !== expectedSize || height !== expectedSize) {
        throw new Error(`actual dimensions=${width}x${height}`);
      }
      return `HTTP ${res.status}, image/png, ${width}x${height}`;
    });
  }

  // 2. Backend health
  await check("API /health", async () => {
    const { json } = await getJson(`${API_URL}/health`, "api health");
    if (json?.status !== "ok") throw new Error(`status=${json?.status || "(missing)"}`);
    return JSON.stringify(json);
  });

  // 3. Backend smoke endpoints
  await check("GET /api/test", async () => {
    const { json, text } = await getJson(`${API_URL}/api/test`, "api test");
    if (json?.status !== "OK") {
      throw new Error(`expected current JSON health contract, got: ${text.slice(0, 80)}`);
    }
    return JSON.stringify(json);
  });
  await check("GET /api/syllabus", async () => {
    const { json } = await getJson(`${API_URL}/api/syllabus`, "syllabus");
    if (!Array.isArray(json)) throw new Error("expected an array");
    return `${json.length} items`;
  });
  await check("GET /api/study", async () => {
    const { json } = await getJson(`${API_URL}/api/study`, "study");
    if (!Array.isArray(json)) throw new Error("expected an array");
    return `${json.length} items`;
  });
  await check("GET /api/timetable/today", async () => {
    const { json } = await getJson(`${API_URL}/api/timetable/today`, "timetable");
    if (!("day" in json)) throw new Error("missing 'day' field");
    return `day=${json.day}`;
  });

  // 4. CORS preflight from the production frontend origin
  await check("CORS preflight (workers.dev origin)", async () => {
    const res = await Promise.race([
      fetch(`${API_URL}/api/auth/login`, {
        method: "OPTIONS",
        headers: {
          Origin: FRONTEND_URL,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      timeout(20000, "cors preflight"),
    ]);
    const allowOrigin = res.headers.get("access-control-allow-origin") || "";
    if (!allowOrigin.includes(FRONTEND_URL)) {
      throw new Error(`access-control-allow-origin=${allowOrigin || "(missing)"}`);
    }
    return `HTTP ${res.status}, allow-origin=${allowOrigin}`;
  });

  await check("Socket.IO polling handshake", async () => {
    const res = await Promise.race([
      fetch(`${API_URL}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`, {
        headers: { Origin: FRONTEND_URL },
      }),
      timeout(20000, "Socket.IO handshake"),
    ]);
    const text = await res.text();
    const allowOrigin = res.headers.get("access-control-allow-origin") || "";
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
    if (!allowOrigin.includes(FRONTEND_URL)) {
      throw new Error(`access-control-allow-origin=${allowOrigin || "(missing)"}`);
    }
    if (!/^0\{/.test(text)) throw new Error(`invalid Engine.IO handshake: ${text.slice(0, 100)}`);
    const handshake = JSON.parse(text.slice(1));
    if (!handshake.sid || !Array.isArray(handshake.upgrades)) {
      throw new Error("Engine.IO handshake is missing sid/upgrades");
    }
    return `connected; upgrades=${handshake.upgrades.join(",") || "none"}`;
  });

  // 5. AI engine health (only when an AI URL was provided)
  if (AI_URL) {
    await check("AI /health", async () => {
      const { json } = await getJson(`${AI_URL}/health`, "ai health");
      if (json.status !== "live" && json.status !== "ok") throw new Error(`status=${json.status}`);
      return JSON.stringify(json);
    });
  }

  // 6. Exact browser-facing AI route. Authentication is intentionally required.
  await check("POST /api/ai/chat route", async () => {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
    const res = await Promise.race([
      fetch(`${API_URL}/api/ai/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "What is machine learning?" }),
      }),
      timeout(AUTH_TOKEN ? 240000 : 30000, "api AI chat"),
    ]);
    const json = await res.json().catch(() => ({}));

    if (!AUTH_TOKEN) {
      if (res.status === 404) throw new Error("HTTP 404: AI router is not deployed");
      if (res.status !== 401 && res.status !== 403) {
        throw new Error(`expected auth protection, got HTTP ${res.status}`);
      }
      return `HTTP ${res.status}; route is mounted and authentication is enforced`;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error || json.detail || "request failed"}`);
    const reply = String(json.reply || json.message || json.response || "").trim();
    if (!reply) throw new Error("response missing reply/message/response");
    const preview = reply.replace(/\s+/g, " ").slice(0, 80);
    return `HTTP ${res.status}, reply="${preview}${reply.length > 80 ? "…" : ""}"`;
  });

  // 7. Static audit: production config must not point at localhost; TURN wiring present
  await check("No localhost in production config", () => {
    const root = path.join(__dirname, "..");
    const targets = [
      "render.yaml",
      "server/server.js",
      "server/routes/ai.js",
      "frontend/src/api/api.js",
      "frontend/src/Components/Views/LiveView.jsx",
      "frontend/.env.example",
    ];
    const offenders = [];
    for (const rel of targets) {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) {
        offenders.push(`${rel} (missing)`);
        continue;
      }
      const content = fs.readFileSync(full, "utf8");
      // Allow explicit localhost-only DEV fallbacks, but flag any production
      // URL constant that would bake localhost into a bundle.
      if (/https?:\/\/(localhost|127\.0\.0\.1)/i.test(content) && !/development only|dev/i.test(content)) {
        offenders.push(rel);
      }
    }
    if (offenders.length) throw new Error(`found: ${offenders.join(", ")}`);
    return "clean";
  });

  await check("TURN wired in LiveView (VITE_TURN_URL)", () => {
    const live = path.join(__dirname, "..", "frontend", "src", "Components", "Views", "LiveView.jsx");
    const src = fs.readFileSync(live, "utf8");
    if (!/VITE_TURN_URL/.test(src)) throw new Error("VITE_TURN_URL not consumed");
    if (!/iceServers:\s*getIceServers\(\)/.test(src)) throw new Error("RTCPeerConnection does not use getIceServers()");
    return "STUN + TURN ready (browser-side two-peer test still required)";
  });

  // ---- report ----
  console.log(`\n${"─".repeat(60)}`);
  let failures = 0;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failures += 1;
    console.log(`  [${mark}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`${"─".repeat(60)}`);
  const summary = failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`;
  console.log(`\n${summary}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("Verification aborted:", err.message);
  process.exit(2);
});
