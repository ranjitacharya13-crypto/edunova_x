// Live scenario + load runner for the EduNova AI gateway (manual/demo tool).
//
// Boots the real Express AI gateway against a real running AI service and
// exercises the twelve canonical acceptance scenarios plus concurrency load
// (1/5/10/20 parallel students). Emits a machine-readable JSON report.
//
// Usage: node scripts/live-scenarios.js <aiEngineUrl> <out.json>
//
// See live-gateway.js for the database/auth note: the only stubbed piece is
// the MongoDB user lookup; the gateway, JWT auth, warm queue, retries and SSE
// streaming are the real server code.

"use strict";

const fs = require("node:fs");
const { startGateway } = require("./live-gateway");

const SCENARIOS = [
  { id: "s1-what-is-ml", message: "What is machine learning?", accept: "text/event-stream" },
  { id: "s2-binary-tree", message: "Explain binary trees with an example", accept: "text/event-stream" },
  { id: "s3-my-timetable", message: "Show me my timetable for today", accept: "text/event-stream" },
  { id: "s4-create-study-plan", message: "Create me a one-week study plan for Python", accept: "text/event-stream" },
  { id: "s5-quiz-me", message: "Quiz me on chapter 4 of maths", accept: "text/event-stream" },
  { id: "s6-follow-up", message: "What is a neural network?", accept: "text/event-stream" },
  { id: "s7-concept-depth", message: "Explain gradient descent in detail", accept: "text/event-stream" },
  { id: "s8-web-research", message: "Search the web for the latest ISRO launch", accept: "text/event-stream" },
  { id: "s9-json-nonstream", message: "What is supervised learning?", accept: "application/json" },
  { id: "s10-tamil-multilingual", message: "What is machine learning? (explain simply)", accept: "text/event-stream" },
  { id: "s11-prepare-queue", message: "Greet me", accept: "text/event-stream" },
  { id: "s12-syllabus-progress", message: "What topics are left in my syllabus?", accept: "text/event-stream" },
];

async function postChat(gateway, { message, accept }, token) {
  const startedAt = Date.now();
  const url = `http://127.0.0.1:${gateway.port}/api/ai/chat`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Accept: accept,
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });
  const text = await response.text();
  const durationMs = Date.now() - startedAt;

  if (accept.includes("text/event-stream")) {
    const events = text
      .split(/\r?\n\r?\n/)
      .filter((block) => block.startsWith("data:"))
      .map((block) => JSON.parse(block.slice(5).trim()));
    const final = events.find((e) => e.type === "answer") || events.find((e) => e.type === "error");
    const firstToken = events.find((e) => e.type === "token");
    const preparing = events.find((e) => e.event === "model.preparing");
    return {
      status: response.status,
      ok: Boolean(final && (final.type === "answer") && final.success !== false),
      eventCount: events.length,
      tokenCount: events.filter((e) => e.type === "token").length,
      firstTokenMs: firstToken ? events.indexOf(firstToken) + 1 : null,
      preparing: Boolean(preparing),
      finalType: final ? final.type : null,
      finalStatus: final ? final.agentStatus || final.error?.code || null : null,
      hasRequestId: Boolean(final?.requestId),
      durationMs,
    };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    ok: Boolean(json?.success),
    hasRequestId: Boolean(json?.requestId || json?.detail?.requestId),
    finalStatus: json?.success ? "completed" : json?.error?.code || json?.detail?.code || null,
    finalType: json?.success ? "answer" : "error",
    durationMs,
  };
}

function summarize(latencies) {
  if (latencies.length === 0) return { n: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)];
  return {
    n: latencies.length,
    meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50Ms: p(50),
    p95Ms: p(95),
    maxMs: sorted[sorted.length - 1],
  };
}

async function loadTest(gateway, token, concurrency, rounds = 3) {
  const startedAt = Date.now();
  const results = [];
  for (let round = 0; round < rounds; round++) {
    const batch = [];
    for (let i = 0; i < concurrency; i++) {
      batch.push(
        postChat(gateway, SCENARIOS[0], token)
          .then((r) => ({ ...r, ok: Boolean(r.ok) }))
          .catch((err) => ({ ok: false, error: String(err && err.message || err) }))
      );
    }
    results.push(...(await Promise.all(batch)));
  }
  const ok = results.filter((r) => r.ok).length;
  const latencies = results.filter((r) => r.ok).map((r) => r.durationMs);
  return {
    concurrency,
    rounds,
    requests: results.length,
    succeeded: ok,
    failed: results.length - ok,
    latencyMs: summarize(latencies),
    totalDurationMs: Date.now() - startedAt,
  };
}

async function main() {
  const aiEngineUrl = process.argv[2];
  const outFile = process.argv[3] || "/tmp/live-results.json";
  if (!aiEngineUrl) {
    console.error("usage: node scripts/live-scenarios.js <aiEngineUrl> [out.json]");
    process.exit(1);
  }
  const gateway = await startGateway({ aiEngineUrl });
  const token = gateway.signToken("live-user-0000000000000000");
  const startedAt = new Date().toISOString();

  const scenarioResults = [];
  for (const scenario of SCENARIOS) {
    const before = Date.now();
    try {
      const result = await postChat(gateway, scenario, token);
      scenarioResults.push({ id: scenario.id, message: scenario.message, ...result });
      console.log(
        `scenario ${scenario.id.padEnd(24)} ok=${result.ok} type=${result.finalType} status=${result.finalStatus} ` +
        `tokens=${result.tokenCount ?? "-"} first=${result.firstTokenMs ?? "-"} ms=${result.durationMs}`
      );
    } catch (err) {
      scenarioResults.push({ id: scenario.id, message: scenario.message, ok: false, error: String(err && err.message || err), durationMs: Date.now() - before });
      console.log(`scenario ${scenario.id} FAILED ${err && err.message}`);
    }
  }

  const loadResults = [];
  for (const concurrency of [1, 5, 10, 20]) {
    const report = await loadTest(gateway, token, concurrency);
    loadResults.push(report);
    console.log(
      `load c=${concurrency} ok=${report.succeeded}/${report.requests} ` +
      `mean=${report.latencyMs.meanMs}ms p50=${report.latencyMs.p50Ms}ms p95=${report.latencyMs.p95Ms}ms ` +
      `total=${report.totalDurationMs}ms`
    );
  }

  const report = {
    generatedAt: startedAt,
    gatewayPort: gateway.port,
    aiEngineUrl,
    gatewayVersion: "express-ai-routes (real code, warm-queue build)",
    scenarios: scenarioResults,
    load: loadResults,
    summary: {
      scenariosPassed: scenarioResults.filter((r) => r.ok).length,
      scenariosTotal: scenarioResults.length,
      load: loadResults.map((r) => ({ concurrency: r.concurrency, succeeded: r.succeeded, failed: r.failed, latencyMs: r.latencyMs })),
    },
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nREPORT_WRITTEN ${outFile}`);
  gateway.server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("runner failed", err);
  process.exit(1);
});
