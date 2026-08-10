const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

const router = express.Router();
const UPSTREAM_TIMEOUT_MS = Number(process.env.AI_ENGINE_TIMEOUT_MS || 20000);

function publicError(res, status, code, error) {
  return res.status(status).json({ error, code });
}

function resolveAiEndpoint(rawUrl) {
  const configured = String(rawUrl || "").trim();
  if (!configured) return null;
  const withProtocol = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  const parsed = new URL(withProtocol);
  if (process.env.NODE_ENV === "production" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) {
    throw new Error("AI_ENGINE_URL cannot point to a loopback host in production");
  }
  // Deployment setting is the service origin. Tolerate an old setting with a
  // trailing route so the upgrade cannot produce a double /api/ai/query path.
  const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/(api\/ai\/query|ai\/query)$/i, "");
  return `${parsed.origin}${pathname}/api/ai/query`;
}

router.post("/query", async (req, res) => {
  const requestId = crypto.randomUUID();
  const message = String(req.body?.message || "").trim();
  const email = String(req.body?.email || "").trim();

  if (!message) return publicError(res, 400, "MISSING_MESSAGE", "A question is required.");
  if (message.length > 4000) return publicError(res, 400, "MESSAGE_TOO_LONG", "Keep your question under 4,000 characters.");

  let endpoint;
  try {
    endpoint = resolveAiEndpoint(process.env.AI_ENGINE_URL);
  } catch (error) {
    console.error(`[ai:${requestId}] invalid configuration:`, error.message);
    return publicError(res, 503, "AI_NOT_CONFIGURED", "EduNova AI is temporarily unavailable. Please try again shortly.");
  }

  if (!endpoint) {
    console.error(`[ai:${requestId}] AI_ENGINE_URL is not configured.`);
    return publicError(res, 503, "AI_NOT_CONFIGURED", "EduNova AI is temporarily unavailable. Please try again shortly.");
  }

  try {
    const upstream = await axios.post(
      endpoint,
      { message, ...(email ? { email } : {}) },
      {
        timeout: Number.isFinite(UPSTREAM_TIMEOUT_MS) ? UPSTREAM_TIMEOUT_MS : 20000,
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        validateStatus: () => true,
      }
    );

    if (upstream.status >= 200 && upstream.status < 300 && upstream.data?.success !== false && String(upstream.data?.reply || "").trim()) {
      return res.status(200).json(upstream.data);
    }

    // The API is a gateway here; an unhealthy AI service must not leak its raw
    // exception or configuration into the browser. Preserve diagnostics only in
    // server logs, keyed by a correlation id.
    console.error(`[ai:${requestId}] upstream returned ${upstream.status}:`, JSON.stringify(upstream.data).slice(0, 800));
    const status = upstream.status === 400 || upstream.status === 422 ? 400 : 502;
    return publicError(
      res,
      status,
      status === 400 ? "INVALID_AI_REQUEST" : "AI_UPSTREAM_ERROR",
      status === 400 ? "EduNova AI could not process that question." : "EduNova AI is temporarily unavailable. Please try again shortly."
    );
  } catch (error) {
    const timedOut = ["ECONNABORTED", "ETIMEDOUT"].includes(error.code);
    const unavailable = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(error.code) || timedOut;
    console.error(`[ai:${requestId}] upstream ${unavailable ? "unavailable" : "request failed"} (${error.code || "unknown"}):`, error.message);
    return publicError(
      res,
      unavailable ? 503 : 502,
      unavailable ? "AI_UPSTREAM_UNAVAILABLE" : "AI_UPSTREAM_ERROR",
      "EduNova AI is temporarily unavailable. Please try again shortly."
    );
  }
});

module.exports = router;
