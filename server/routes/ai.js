const express = require("express");
const axios = require("axios");
const auth = require("../middleware/auth");

const router = express.Router();

// Small in-memory limiter. It is intentionally scoped to authenticated user IDs,
// not proxy IPs, so a Render/Cloudflare address cannot throttle every student.
const rateBuckets = new Map();
const RATE_WINDOW_MS = Math.max(10_000, Number(process.env.AI_RATE_LIMIT_WINDOW_MS) || 60_000);
const RATE_MAX_REQUESTS = Math.max(1, Number(process.env.AI_RATE_LIMIT_MAX_REQUESTS) || 20);

function aiRateLimit(req, res, next) {
  const key = String(req.user?.id || req.ip || "anonymous");
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      success: false,
      error: "Too many AI requests. Please wait a moment and try again.",
      agentStatus: "rate_limited",
    });
  }
  recent.push(now);
  rateBuckets.set(key, recent);

  // Bound stale memory without adding a process-wide timer.
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, timestamps] of rateBuckets) {
      if (!timestamps.some((timestamp) => now - timestamp < RATE_WINDOW_MS)) {
        rateBuckets.delete(bucketKey);
      }
    }
  }
  return next();
}

function getAiBaseUrl() {
  const configured = String(process.env.AI_ENGINE_URL || "").trim();
  if (!configured && process.env.NODE_ENV === "production") return "";
  // Development-only fallback; production never calls localhost.
  let url = configured || "http://localhost:8001";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

function safeUpstreamError(error) {
  const upstream = error.response?.data;
  const detail = upstream?.detail || upstream?.error;
  if (typeof detail === "string" && detail.length < 500) return detail;
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(error.code)) {
    return "AI service is temporarily unavailable. It may be starting up—please try again shortly.";
  }
  return "EduNova AI could not complete this request. Please try again.";
}

// ---------------------------------------------------------------------------
// Cold-start aware upstream handling.
//
// The Render free-tier AI service spins down after idle. While it wakes, the
// Render router answers with an HTML 503 "Application loading" page (or the
// connection fails outright). A single doomed attempt used to surface the
// generic "EduNova AI could not start this request." even though the service
// becomes healthy seconds later. We therefore retry bounded, fast-failing
// upstream errors (proxy 502/503/504 pages and connect-level failures) before
// reporting an error to the student.
// ---------------------------------------------------------------------------
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
]);

function parseDelayList(raw, fallback) {
  if (!raw) return fallback;
  const values = String(raw)
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 120_000);
  return values.length ? values.slice(0, 6) : fallback;
}

const UPSTREAM_RETRY_DELAYS_MS = parseDelayList(process.env.AI_UPSTREAM_RETRY_DELAYS_MS, [
  3_000,
  8_000,
  15_000,
  30_000,
]);
const UPSTREAM_RETRY_WINDOW_MS = Math.min(
  300_000,
  Math.max(0, Number(process.env.AI_UPSTREAM_RETRY_WINDOW_MS) || 90_000)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJsonBody(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    // HTML proxy pages (e.g. Render's loading screen) are expected here.
    return null;
  }
}

// User-safe message for upstream failures whose body is not our JSON (proxy
// HTML pages, empty bodies). Never include the raw body: it may contain
// provider/proxy internals.
function upstreamStatusMessage(status) {
  if (status === 401 || status === 403) {
    return "EduNova AI authentication failed. Please sign in again; if it continues, the AI service configuration needs attention.";
  }
  if (status === 404) {
    return "The EduNova AI endpoint is unavailable. Please try again after the service is redeployed.";
  }
  if (status === 429) {
    return "EduNova AI is receiving too many requests. Please wait a moment and try again.";
  }
  if (status === 502 || status === 503) {
    return "The EduNova AI service is starting up or temporarily unavailable. Please try again in a few seconds.";
  }
  if (status === 504) {
    return "EduNova AI took too long to respond. Please try again.";
  }
  return "EduNova AI could not complete this request. Please try again.";
}

function agentStatusFor(status) {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "failed";
}

async function readLimitedStream(stream, maximum = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// One upstream POST attempt. Resolves with { ok, status, stream, body }
// (body only populated for non-2xx so the success stream stays untouched) or
// rejects with the axios error for non-response failures.
async function postUpstream(url, payload, headers, timeout, signal) {
  const response = await axios.post(url, payload, {
    headers,
    timeout,
    responseType: "stream",
    signal,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    const raw = await readLimitedStream(response.data);
    return { ok: false, status: response.status, body: parseJsonBody(raw) };
  }
  return { ok: true, status: response.status, stream: response.data };
}

async function handleAgentChat(req, res) {
  const message = String(req.body?.message || "").trim();
  const conversationId = String(req.body?.conversationId || "").trim() || undefined;
  if (!message) {
    return res.status(400).json({ success: false, error: "message is required" });
  }
  if (message.length > 12_000) {
    return res.status(413).json({ success: false, error: "message is too long" });
  }
  if (conversationId && !/^[A-Za-z0-9_-]{16,100}$/.test(conversationId)) {
    return res.status(400).json({ success: false, error: "conversationId is invalid" });
  }

  const aiBaseUrl = getAiBaseUrl();
  if (!aiBaseUrl) {
    // Keep the deployment detail in Render logs; students only need the stable
    // public error and must never receive provider credentials or stack traces.
    console.error("[agent] AI_ENGINE_URL is not configured on the API service.");
    return res.status(503).json({
      success: false,
      error: "AI provider is not configured.",
      agentStatus: "unavailable",
    });
  }

  const wantsStream = req.path === "/chat" && /text\/event-stream/i.test(req.headers.accept || "");
  const payload = {
    message,
    conversationId,
    ownerId: String(req.user?.id || req.user?.email || "authenticated-user"),
    stream: wantsStream,
  };
  const headers = {
    "Content-Type": "application/json",
    Accept: wantsStream ? "text/event-stream" : "application/json",
  };
  if (process.env.AI_INTERNAL_TOKEN) {
    headers["X-AI-Internal-Token"] = process.env.AI_INTERNAL_TOKEN;
  }

  const timeout = Math.max(15_000, Number(process.env.AGENT_REQUEST_TIMEOUT) || 210_000);
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const startedAt = Date.now();
  const attempts = UPSTREAM_RETRY_DELAYS_MS.length + 1;
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await postUpstream(`${aiBaseUrl}/api/ai/chat`, payload, headers, timeout, controller.signal);

      if (result.ok) {
        console.log(
          `[agent] upstream ok after ${attempt} attempt(s) stream=${wantsStream} elapsed=${Date.now() - startedAt}ms`
        );
        if (wantsStream) return pipeAgentStream(res, result.stream);
        const raw = await readLimitedStream(result.stream, 2_097_152);
        const parsed = parseJsonBody(raw);
        if (parsed) return res.status(result.status).json(parsed);
        // Non-JSON success body should never happen with our FastAPI service;
        // forward it as text rather than failing the whole request.
        return res.status(result.status).type("text/plain").send(raw);
      }

      lastFailure = { kind: "status", status: result.status, body: result.body };
      const retryable = RETRYABLE_UPSTREAM_STATUSES.has(result.status);
      console.warn(
        `[agent] upstream attempt ${attempt}/${attempts} returned HTTP ${result.status} retryable=${retryable}`
      );
      if (!retryable) break;
    } catch (error) {
      if (controller.signal.aborted || res.writableEnded) return; // client disconnected
      lastFailure = { kind: "network", error };
      const retryable = RETRYABLE_NETWORK_CODES.has(error.code);
      console.warn(
        `[agent] upstream attempt ${attempt}/${attempts} failed code=${error.code || "unknown"} retryable=${retryable}`
      );
      if (!retryable) break;
    }

    if (attempt >= attempts) break;
    const delay = UPSTREAM_RETRY_DELAYS_MS[attempt - 1];
    if (UPSTREAM_RETRY_WINDOW_MS && Date.now() - startedAt + delay > UPSTREAM_RETRY_WINDOW_MS) {
      console.warn("[agent] upstream retry window exhausted before final attempt");
      break;
    }
    await sleep(delay);
  }

  // Every attempt failed: return an accurate, user-safe error. The deployment
  // detail stays in Render logs; students never see provider secrets, stack
  // traces, or raw proxy/HTML bodies.
  if (lastFailure?.kind === "network") {
    const status = lastFailure.error.response?.status || 503;
    console.error(
      "[agent] AI engine unreachable:",
      lastFailure.error.code || status,
      lastFailure.error.message
    );
    return res.status(status).json({
      success: false,
      error: safeUpstreamError(lastFailure.error),
      sources: [],
      usedWeb: false,
      agentStatus: "failed",
    });
  }

  const status = lastFailure?.status ?? 502;
  const bodyDetail = lastFailure?.body?.detail || lastFailure?.body?.error;
  const detail =
    typeof bodyDetail === "string" && bodyDetail.length > 0 && bodyDetail.length < 500
      ? bodyDetail
      : upstreamStatusMessage(status);
  return res.status(status).json({
    success: false,
    error: detail,
    sources: [],
    usedWeb: false,
    agentStatus: agentStatusFor(status),
  });
}

// Forward the FastAPI SSE stream to the browser untouched. Status events and
// the final answer/error event are produced by the AI service; no secrets or
// private agent state are included in that stream.
function pipeAgentStream(res, upstreamStream) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  upstreamStream.on("error", (error) => {
    console.error("[agent] upstream stream error:", error.message);
    if (!res.writableEnded) res.end();
  });
  upstreamStream.pipe(res);
}

// /chat is the v2 agent API. /query remains as a non-streaming compatibility
// alias for already-deployed clients; both invoke the same autonomous engine.
router.post("/chat", auth, aiRateLimit, handleAgentChat);
router.post("/query", auth, aiRateLimit, handleAgentChat);

module.exports = router;
