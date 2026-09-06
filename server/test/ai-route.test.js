// Integration tests for the authenticated Express -> FastAPI AI proxy
// (server/routes/ai.js), run with Node's built-in test runner: `npm test`.
//
// These tests exercise the real route module — authentication, per-user rate
// limiting, cold-start retries, SSE passthrough, and error mapping — against a
// scripted in-process upstream. No MongoDB or network access is required: the
// only replaced piece is the mongoose user lookup inside the auth middleware.
//
// Secrets are never asserted or logged here; the tests only verify routing
// behaviour, status codes, and the user-safe response contract.

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// Fast retries so the cold-start tests stay quick.
process.env.AI_UPSTREAM_RETRY_DELAYS_MS = "10,20,30";
process.env.AI_UPSTREAM_RETRY_WINDOW_MS = "2000";
process.env.AGENT_REQUEST_TIMEOUT = "15000";
process.env.JWT_SECRET = process.env.JWT_SECRET || "ai-route-test-secret";

const auth = require("../middleware/auth");
const aiRoutes = require("../routes/ai");

// Replace only the MongoDB user lookup: echo the requested id so each test
// can authenticate as a distinct user (isolating the rate-limit buckets).
const makeUserLookupStub = () => {
  mongoose.Model.findById = (id) => ({
    select: () =>
      Promise.resolve({ _id: String(id), email: "student@edunova.test", role: "student", name: "Test Student" }),
  });
};

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET);
}

// A scripted FastAPI stand-in. `behavior` is a function(request, response,
// state) that decides each response; `state` persists per upstream instance.
function startUpstream(behavior) {
  return new Promise((resolve) => {
    const state = { requests: [], internalTokens: [] };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        state.requests.push({ path: req.url, method: req.method, body: raw });
        state.internalTokens.push(req.headers["x-ai-internal-token"] || null);
        // The gateway polls the real readiness gate before forwarding SSE
        // chat. A healthy AI service answers 200 + modelReady:true.
        if (req.method === "GET" && req.url === "/api/ai/ready") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, modelReady: true, modelState: "ready" }));
          return;
        }
        behavior(req, res, state, raw);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}


async function startUpstreamAt(behavior) {
  const upstream = await startUpstream(behavior);
  const previous = process.env.AI_ENGINE_URL;
  process.env.AI_ENGINE_URL = `http://127.0.0.1:${upstream.port}`;
  return { ...upstream, restoreEnv: () => { if (previous === undefined) delete process.env.AI_ENGINE_URL; else process.env.AI_ENGINE_URL = previous; } };
}

function sseBlock(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function makeApp() {
  makeUserLookupStub();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/ai", aiRoutes);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function postChat(server, { token, message = "what is ml", accept = "text/event-stream" } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body (e.g. proxied SSE) — callers assert on raw text.
  }
  return { status: response.status, json, text };
}

async function readSseFinalAnswer(responseText) {
  const events = responseText
    .split(/\r?\n\r?\n/)
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.slice(5).trim()));
  return { events, final: events.find((event) => event.type === "answer") };
}

describe("Express AI route -> FastAPI integration", () => {
  before(() => makeUserLookupStub());

  test("healthy upstream: SSE question streams statuses then the final answer", async () => {
    const upstream = await startUpstreamAt((req, res, state, raw) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseBlock({ type: "status", event: "agent.started", message: "Understanding your question..." }));
      res.write(sseBlock({ type: "status", event: "agent.planning", message: "Deciding the best next step..." }));
      res.write(
        sseBlock({
          type: "answer",
          success: true,
          message: "ML stands for Machine Learning.",
          reply: "ML stands for Machine Learning.",
          sources: [],
          usedWeb: false,
          agentStatus: "completed",
          conversationId: "conversation1234567890",
          limitReached: false,
        })
      );
      res.end();
    });
    const app = await listen(makeApp());
    try {
      const { status, text } = await postChat(app, { token: signToken("sse-user-0000000001") });
      assert.strictEqual(status, 200);
      const { events, final } = await readSseFinalAnswer(text);
      assert.ok(events.length >= 2);
      assert.strictEqual(final.success, true);
      assert.strictEqual(final.agentStatus, "completed");
      assert.strictEqual(final.reply, "ML stands for Machine Learning.");
      // The internal token must be forwarded when configured on the API service.
      process.env.AI_INTERNAL_TOKEN = "route-test-internal-token";
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
      delete process.env.AI_INTERNAL_TOKEN;
    }
  });

  test("healthy upstream: JSON request returns the full response contract", async () => {
    const upstream = await startUpstreamAt((req, res) => {
      const body = {
        success: true,
        message: "A binary tree is a tree where each node has at most two children.",
        reply: "A binary tree is a tree where each node has at most two children.",
        sources: [],
        usedWeb: false,
        agentStatus: "completed",
        conversationId: "conversation1234567890",
        limitReached: false,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    const app = await listen(makeApp());
    try {
      const { status, json } = await postChat(app, {
        token: signToken("json-user-0000000001"),
        message: "what is a binary tree",
        accept: "application/json",
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentStatus, "completed");
      assert.strictEqual(typeof json.message, "string");
      assert.strictEqual(typeof json.reply, "string"); // backward-compatible alias
      assert.strictEqual(json.usedWeb, false);
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("cold upstream is reported without replaying tool-bearing chat POSTs", async () => {
    const upstream = await startUpstreamAt((req, res, state) => {
      if (req.method === "POST" && req.url === "/api/ai/chat") {
        state.chatAttempts = (state.chatAttempts || 0) + 1;
      }
      if ((state.chatAttempts || 0) <= 2) {
        // First two chat POSTs: Render free-tier "Application loading" page.
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><body>Render - Application loading</body></html>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        sseBlock({
          type: "answer",
          success: true,
          message: "Machine learning is a field of AI.",
          reply: "Machine learning is a field of AI.",
          sources: [],
          usedWeb: false,
          agentStatus: "completed",
          conversationId: "conversation1234567890",
          limitReached: false,
        })
      );
      res.end();
    });
    const app = await listen(makeApp());
    try {
      const { status, text } = await postChat(app, { token: signToken("cold-user-0000000001") });
      assert.strictEqual(status, 503);
      assert.strictEqual(JSON.parse(text).error.code, "UPSTREAM_HTTP_503");
      const chatPosts = upstream.state.requests.filter((r) => r.path === "/api/ai/chat");
      assert.strictEqual(chatPosts.length, 1, "must never replay a chat POST");
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("permanently cold upstream returns an accurate wake-up error, not a generic one", async () => {
    const upstream = await startUpstreamAt((req, res) => {
      res.writeHead(503, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body>Render - Application loading</body></html>");
    });
    const app = await listen(makeApp());
    try {
      const { status, json } = await postChat(app, {
        token: signToken("cold2-user-0000000001"),
        accept: "application/json",
      });
      assert.strictEqual(status, 503);
      assert.strictEqual(json.success, false);
      assert.strictEqual(json.error.code, "UPSTREAM_HTTP_503");
      assert.strictEqual(json.agentStatus, "failed");
      assert.ok(!/could not start this request/.test(json.error.message), "the old misleading message must be gone");
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("upstream authentication failure is forwarded as 401 without retry", async () => {
    const upstream = await startUpstreamAt((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "AI service authorization failed" }));
    });
    const app = await listen(makeApp());
    try {
      const { status, json } = await postChat(app, {
        token: signToken("authfail-user-00000001"),
        accept: "application/json",
      });
      assert.strictEqual(status, 401);
      assert.strictEqual(json.error.message, "AI service authorization failed");
      assert.strictEqual(json.agentStatus, "failed");
      assert.strictEqual(upstream.state.requests.filter((r) => r.path === "/api/ai/chat").length, 1, "4xx failures must not be retried");
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("requests without a valid JWT are rejected before any upstream call", async () => {
    const upstream = await startUpstreamAt((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    const app = await listen(makeApp());
    try {
      const anonymous = await postChat(app, { token: "" });
      assert.strictEqual(anonymous.status, 401);
      const forged = await postChat(app, { token: "not-a-real-jwt" });
      assert.strictEqual(forged.status, 401);
      assert.strictEqual(upstream.state.requests.length, 0, "unauthenticated requests must never reach the AI service");
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("missing AI_INTERNAL_TOKEN is not forwarded as a header", async () => {
    delete process.env.AI_INTERNAL_TOKEN;
    const upstream = await startUpstreamAt((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseBlock({ type: "answer", success: true, message: "ok", reply: "ok", agentStatus: "completed", sources: [], usedWeb: false, conversationId: "conversation1234567890", limitReached: false }));
      res.end();
    });
    const app = await listen(makeApp());
    try {
      await postChat(app, { token: signToken("noheader-user-000000001") });
      assert.strictEqual(upstream.state.internalTokens[0], null);
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("per-user rate limit returns 429 with a safe message", async () => {
    const upstream = await startUpstreamAt((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseBlock({ type: "answer", success: true, message: "ok", reply: "ok", agentStatus: "completed", sources: [], usedWeb: false, conversationId: "conversation1234567890", limitReached: false }));
      res.end();
    });
    const app = await listen(makeApp());
    try {
      const token = signToken("ratelimit-user-0000001");
      const results = [];
      for (let i = 0; i < 25; i++) {
        results.push(await postChat(app, { token }));
      }
      const limited = results.filter((r) => r.status === 429);
      assert.ok(limited.length > 0, "the 21st+ request should be rate limited");
      assert.match(limited[0].json.error.message, /too many AI requests/i);
      assert.strictEqual(limited[0].json.error.code, "RATE_LIMITED");
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });

  test("invalid requests are rejected locally (400/413) without an upstream call", async () => {
    const upstream = await startUpstreamAt((req, res) => res.end());
    const app = await listen(makeApp());
    const token = signToken("validation-user-0000001");
    try {
      const address = app.address();
      const base = `http://127.0.0.1:${address.port}/api/ai/chat`;
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
      const empty = await fetch(base, { method: "POST", headers, body: JSON.stringify({ message: "   " }) });
      assert.strictEqual(empty.status, 400);
      const huge = await fetch(base, { method: "POST", headers, body: JSON.stringify({ message: "x".repeat(12_500) }) });
      assert.strictEqual(huge.status, 413);
      assert.strictEqual(upstream.state.requests.length, 0);
    } finally {
      upstream.restoreEnv();
      upstream.server.close();
      app.close();
    }
  });
});

after(() => {
  // Allow open handles to settle before the test runner exits.
  setTimeout(() => process.exit(0), 250).unref();
});
