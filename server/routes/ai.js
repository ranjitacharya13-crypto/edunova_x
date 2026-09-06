const express = require("express");
const axios = require("axios");
const auth = require("../middleware/auth");
const { executeApplicationTool, confirmApplicationTool } = require("../services/applicationTools");

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
  const message = typeof detail === "object" ? detail?.message : detail;
  if (typeof message === "string" && message.length < 500) return message;
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(error.code)) {
    return "AI service is temporarily unavailable. It may be starting up—please try again shortly.";
  }
  return "EduNova AI could not complete this request. Please try again.";
}

// ---------------------------------------------------------------------------
// Cold-start aware upstream handling.
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
    return null;
  }
}

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
    return "EduNova AI is temporarily unavailable. Please try again.";
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

async function waitForAiReady(aiBaseUrl, headers, signal) {
  // Poll the AI service's REAL readiness gate (GET /api/ai/ready → 200 only
  // when the model is loaded AND warm-up inference succeeded). While waiting we
  // keep the client's SSE stream alive with status events + keep-alives, so
  // the student sees "EduNova AI is preparing…" and their message stays queued.
  const AI_WARM_QUEUE_MAX_MS = Math.max(
    30_000,
    Math.min(900_000, Number(process.env.AI_WARM_QUEUE_MAX_MS) || 600_000)
  );
  const AI_READY_POLL_MS = 2_000;
  const queueStarted = Date.now();
  const deadline = queueStarted + AI_WARM_QUEUE_MAX_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const response = await axios.get(`${aiBaseUrl}/api/ai/ready`, {
        headers,
        timeout: 8_000,
        signal,
        validateStatus: () => true,
      });
      if (response.status === 200 && response.data?.modelReady === true) {
        return { waitedMs: Date.now() - queueStarted };
      }
      // A permanently failed model (missing/gated repo, incompatible runtime)
      // will NEVER become ready. Queueing the student for ten minutes and then
      // telling them to "try again in a minute" hides a real outage — fail fast
      // and honestly instead.
      if (response.data?.permanentFailure === true) {
        const failure = new Error(
          String(response.data?.lastError || "model startup failed permanently").slice(0, 300)
        );
        failure.code = "AI_MODEL_STARTUP_FAILED";
        failure.stage = String(response.data?.errorStage || "load_failed");
        throw failure;
      }
      const state = String(response.data?.modelState || response.data?.lifecycle || "starting");
      console.log(`[agent] warm queue: model ${state}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`[agent] readiness poll failed code=${error.code || error.message}`);
    }
    await sleep(AI_READY_POLL_MS);
  }
  const error = new Error("AI service model did not become ready within the queue window");
  error.code = "AI_MODEL_QUEUE_TIMEOUT";
  throw error;
}

async function handleAgentChat(req, res) {
  const message = String(req.body?.message || "").trim();
  const conversationId = String(req.body?.conversationId || "").trim() || undefined;
  const rawContext = req.body?.applicationContext;
  const applicationContext = rawContext && typeof rawContext === "object"
    ? {
        route: String(rawContext.route || "").slice(0, 200),
        feature: String(rawContext.feature || "").slice(0, 80),
        context: rawContext.context && typeof rawContext.context === "object" ? rawContext.context : {},
      }
    : {};
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
    console.error("[agent] AI_ENGINE_URL is not configured on the API service.");
    return res.status(503).json({
      success: false,
      error: "AI provider is not configured.",
      agentStatus: "unavailable",
    });
  }

  const wantsStream = req.path === "/chat" && /text\/event-stream/i.test(req.headers.accept || "");
  const requestId = String(req.headers["x-request-id"] || "") ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    message,
    conversationId,
    ownerId: String(req.user?.id || req.user?.email || "authenticated-user"),
    userRole: String(req.user?.role || "student"),
    userName: String(req.user?.name || "Student"),
    userEmail: String(req.user?.email || ""),
    applicationContext,
    stream: wantsStream,
  };
  const headers = {
    "Content-Type": "application/json",
    Accept: wantsStream ? "text/event-stream" : "application/json",
    "X-Request-Id": requestId,
  };
  if (process.env.AI_INTERNAL_TOKEN) {
    headers["X-AI-Internal-Token"] = process.env.AI_INTERNAL_TOKEN;
  }

  // Network backstop only. This is intentionally much longer than the normal
  // 10-20s performance target and never controls answer length. For SSE, the
  // upstream sends headers immediately and streams genuine model tokens.
  const timeout = Math.max(60_000, Number(process.env.AGENT_REQUEST_TIMEOUT) || 600_000);
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const startedAt = Date.now();

  // -------------------------------------------------------------------------
  // STREAMING PATH — never drop the message while the model warms.
  //
  // The connection is answered immediately (200 + SSE). While the model is
  // still preparing (cold boot / deploy), the client receives an honest
  // "preparing" status and keep-alives; the request is forwarded upstream the
  // moment the model reports READY. The user is never told to "try again
  // shortly" and their message is never lost to a race.
  // -------------------------------------------------------------------------
  if (wantsStream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders?.();

    const sendEvent = (event) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const sendPreparing = () => sendEvent({
      type: "status",
      event: "model.preparing",
      status: "preparing",
      message: "EduNova AI is preparing its model — your question is queued. You don't need to do anything.",
      requestId,
    });

    try {
      sendPreparing();
      // Wait for the model to be genuinely ready (loaded + warmed).
      await waitForAiReady(aiBaseUrl, headers, controller.signal);
      const waitedMs = Date.now() - startedAt;
      console.log(`[agent] model ready after warm queue waitedMs=${waitedMs} forwarding request`);

      // Forward the queued request. Transient 502/503/504 from the upstream are
      // retried on the same backoff schedule as the non-streaming path — the
      // response body has not started streaming yet, so retrying is safe.
      const attempts = UPSTREAM_RETRY_DELAYS_MS.length + 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const result = await postUpstream(`${aiBaseUrl}/api/ai/chat`, payload, headers, timeout, controller.signal);
        if (result.ok && result.stream) {
          console.log(`[agent] forwarding SSE stream (attempt ${attempt})`);
          return pipeAgentStream(res, result.stream);
        }
        const status = result.status || 502;
        const retryable = RETRYABLE_UPSTREAM_STATUSES.has(status);
        if (retryable && attempt < attempts) {
          const delay = UPSTREAM_RETRY_DELAYS_MS[attempt - 1];
          console.warn(`[agent] upstream chat HTTP ${status} (attempt ${attempt}/${attempts}) retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        const bodyDetail = typeof result.body === "object" ? result.body.detail || result.body.error : undefined;
        const detail = typeof bodyDetail === "object" ? bodyDetail?.message : bodyDetail;
        console.warn(`[agent] upstream rejected chat HTTP ${status} after warm queue`);
        sendEvent({
          type: "error",
          success: false,
          status,
          message: detail || upstreamStatusMessage(status),
          error: { code: "AI_UPSTREAM_REJECTED", message: detail || upstreamStatusMessage(status) },
          agentStatus: agentStatusFor(status),
          requestId,
        });
        res.end();
        return;
      }
    } catch (error) {
      if (res.writableEnded) return;
      console.error(`[agent] streaming chat failed code=${error.code || error.message}`);
      const startupFailed = error.code === "AI_MODEL_STARTUP_FAILED";
      const queuedTooLong = error.code === "AI_MODEL_QUEUE_TIMEOUT";

      // Report the ACTUAL condition. A permanently broken model service is an
      // outage, not a "try again in a minute" — telling a student to retry
      // forever is what hid this failure in production.
      let message = "EduNova AI could not complete this request. Please try again.";
      if (startupFailed) {
        message =
          "EduNova AI is temporarily unavailable — the AI model service failed to start. " +
          "This is a server-side problem and retrying will not help; it has been logged for the administrator.";
      } else if (queuedTooLong) {
        message =
          "EduNova AI is temporarily unavailable — the model did not finish starting in time. " +
          "This has been logged for the administrator.";
      }
      if (startupFailed) {
        console.error(`[agent] MODEL STARTUP FAILED stage=${error.stage || "unknown"} reason=${error.message}`);
      }
      sendEvent({
        type: "error",
        success: false,
        status: 503,
        message,
        error: {
          code: startupFailed
            ? "AI_MODEL_STARTUP_FAILED"
            : queuedTooLong
              ? "AI_MODEL_QUEUE_TIMEOUT"
              : "AI_UPSTREAM_FAILED",
          message: error.message,
          stage: error.stage,
        },
        agentStatus: startupFailed ? "unavailable" : "failed",
        requestId,
      });
      res.end();
      return;
    }
  }

  // -------------------------------------------------------------------------
  // NON-STREAMING PATH (legacy /query and JSON callers): bounded retry.
  // -------------------------------------------------------------------------
  const attempts = UPSTREAM_RETRY_DELAYS_MS.length + 1;
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await postUpstream(`${aiBaseUrl}/api/ai/chat`, payload, headers, timeout, controller.signal);

      if (result.ok) {
        const elapsed = Date.now() - startedAt;
        console.log(
          `[agent] upstream ok after ${attempt} attempt(s) stream=${wantsStream} elapsed=${elapsed}ms`
        );
        const raw = await readLimitedStream(result.stream, 2_097_152);
        const parsed = parseJsonBody(raw);
        if (parsed) return res.status(result.status).json(parsed);
        return res.status(result.status).type("text/plain").send(raw);
      }

      lastFailure = { kind: "status", status: result.status, body: result.body };
      const retryable = RETRYABLE_UPSTREAM_STATUSES.has(result.status);
      console.warn(
        `[agent] upstream attempt ${attempt}/${attempts} returned HTTP ${result.status} retryable=${retryable}`
      );
      if (!retryable) break;
    } catch (error) {
      if (controller.signal.aborted || res.writableEnded) return;
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
  const errorCode = typeof bodyDetail === "object" ? bodyDetail?.code : undefined;
  const bodyMessage = typeof bodyDetail === "object" ? bodyDetail?.message : bodyDetail;
  const detail = typeof bodyMessage === "string" && bodyMessage.length > 0 && bodyMessage.length < 500
    ? bodyMessage : upstreamStatusMessage(status);
  return res.status(status).json({
    success: false,
    error: { code: errorCode || "LLM_PROVIDER_UNAVAILABLE", message: detail },
    message: detail,
    sources: [],
    usedWeb: false,
    agentStatus: agentStatusFor(status),
  });
}

function pipeAgentStream(res, upstreamStream) {
  // Headers may already be sent when the streaming path answered early with a
  // "preparing" status while the model was warming.
  if (!res.headersSent) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  }

  // Idle watchdog, not an overall response deadline. Every keep-alive or real
  // token resets it, so a healthy long answer can finish naturally. It fires
  // only when the upstream has stopped sending data altogether.
  const STREAM_IDLE_TIMEOUT_MS = Math.max(
    30_000,
    Number(process.env.AGENT_STREAM_IDLE_TIMEOUT_MS) || 90_000
  );
  let streamTimer;
  const resetIdleTimer = () => {
    clearTimeout(streamTimer);
    streamTimer = setTimeout(() => {
      console.warn(`[agent] upstream stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          type: "error",
          success: false,
          status: 503,
          message: "EduNova AI is temporarily unavailable. Please try again.",
          error: {
            code: "AI_STREAM_STALLED",
            message: "EduNova AI is temporarily unavailable. Please try again.",
          },
          agentStatus: "failed",
        })}\n\n`);
        res.end();
      }
      upstreamStream.destroy();
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();
  upstreamStream.on("data", resetIdleTimer);

  upstreamStream.on("error", (error) => {
    console.error("[agent] upstream stream error:", error.message);
    clearTimeout(streamTimer);
    if (!res.writableEnded) res.end();
  });
  upstreamStream.on("end", () => clearTimeout(streamTimer));
  upstreamStream.on("close", () => clearTimeout(streamTimer));
  upstreamStream.pipe(res);
}

// ---------------------------------------------------------------------------
// Secure Internal Tool Execution Endpoint for AI Agent
// ---------------------------------------------------------------------------
function authorizeInternal(req, res, next) {
  const configured = String(process.env.AI_INTERNAL_TOKEN || "");
  const supplied = String(req.headers["x-ai-internal-token"] || "");
  if (!configured) {
    return res.status(503).json({ success: false, error: "AI internal authentication is not configured" });
  }
  if (supplied !== configured) {
    return res.status(401).json({ success: false, error: "Unauthorized internal request" });
  }
  return next();
}

async function executeInternalTool(req, res) {
  const toolName = String(req.body?.tool || req.body?.name || "").trim();
  const toolArgs = typeof req.body?.arguments === "object" && req.body.arguments !== null ? req.body.arguments : {};
  // Identity is accepted only from the trusted FastAPI service header. The model
  // cannot select a user ID through tool arguments or request JSON.
  const userId = String(req.headers["x-user-id"] || "");
  const conversationId = String(req.body?.conversationId || "").slice(0, 100);
  if (!toolName) return res.status(400).json({ success: false, error: "tool name is required" });
  if (!userId) return res.status(400).json({ success: false, error: "authenticated user identity is required" });
  try {
    const result = await executeApplicationTool(toolName, toolArgs, userId, conversationId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error("[internal-tools] Execution failed:", err.message);
    return res.status(500).json({ success: false, error: "Internal tool execution failed" });
  }
}

router.post("/actions/:token/confirm", auth, async (req, res) => {
  const result = await confirmApplicationTool(req.params.token, String(req.user?.id || ""));
  return res.status(result.success ? 200 : 400).json(result);
});

router.post("/internal/tools", authorizeInternal, executeInternalTool);
router.post("/tools/execute", authorizeInternal, executeInternalTool);

router.get("/health", auth, async (req, res) => {
  const aiBaseUrl = getAiBaseUrl();
  if (!aiBaseUrl) return res.status(503).json({ success: false, status: "missing_config", serviceAvailable: false });
  const headers = process.env.AI_INTERNAL_TOKEN ? { "X-AI-Internal-Token": process.env.AI_INTERNAL_TOKEN } : {};
  try {
    const response = await axios.get(`${aiBaseUrl}/api/ai/health`, { headers, timeout: 15_000, validateStatus: () => true });
    const body = response.data && typeof response.data === "object" ? response.data : {};
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(503).json({ success: false, status: "provider_unavailable", serviceAvailable: false });
  }
});

router.post("/chat", auth, aiRateLimit, handleAgentChat);
router.post("/query", auth, aiRateLimit, handleAgentChat);

// Diagnostic endpoint: directly test the local model through the AI service.
// Bypasses AgentEngine, tools, MongoDB, web search.  Returns timing data.
router.get("/diagnose", auth, async (req, res) => {
  const aiBaseUrl = getAiBaseUrl();
  if (!aiBaseUrl) return res.status(503).json({ success: false, error: "AI_ENGINE_URL not configured" });
  const headers = process.env.AI_INTERNAL_TOKEN ? { "X-AI-Internal-Token": process.env.AI_INTERNAL_TOKEN } : {};
  try {
    const response = await axios.get(`${aiBaseUrl}/api/ai/diagnose`, { headers, timeout: 120_000, validateStatus: () => true });
    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error("[diagnose] AI engine unreachable:", error.code || error.message);
    return res.status(503).json({ success: false, error: "AI service unreachable", detail: error.code });
  }
});

module.exports = router;
