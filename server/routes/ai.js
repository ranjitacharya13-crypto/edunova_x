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
  try {
    if (wantsStream) {
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const upstream = await axios.post(`${aiBaseUrl}/api/ai/chat`, payload, {
        headers,
        timeout,
        responseType: "stream",
        signal: controller.signal,
        validateStatus: () => true,
      });
      if (upstream.status >= 400) {
        const raw = await readLimitedStream(upstream.data);
        let detail = "EduNova AI could not start this request.";
        try {
          const parsed = JSON.parse(raw);
          detail = parsed.detail || parsed.error || detail;
        } catch {
          // Keep the safe generic detail.
        }
        return res.status(upstream.status).json({ success: false, error: detail });
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      upstream.data.on("error", (error) => {
        console.error("[agent] upstream stream error:", error.message);
        if (!res.writableEnded) res.end();
      });
      return upstream.data.pipe(res);
    }

    const upstream = await axios.post(`${aiBaseUrl}/api/ai/chat`, payload, {
      headers,
      timeout,
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    const status = error.response?.status || 503;
    console.error("[agent] AI engine error:", error.code || status, error.message);
    return res.status(status).json({
      success: false,
      error: safeUpstreamError(error),
      sources: [],
      usedWeb: false,
      agentStatus: "failed",
    });
  }
}

// /chat is the v2 agent API. /query remains as a non-streaming compatibility
// alias for already-deployed clients; both invoke the same autonomous engine.
router.post("/chat", auth, aiRateLimit, handleAgentChat);
router.post("/query", auth, aiRateLimit, handleAgentChat);

module.exports = router;
