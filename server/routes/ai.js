const express = require("express");
const axios = require("axios");
const crypto = require("node:crypto");
const auth = require("../middleware/auth");
const { executeApplicationTool, confirmApplicationTool } = require("../services/applicationTools");
const { educationalContext } = require("../services/arLessons");
const {
  resolveDirectProviderConfig,
  normalizeUpstreamStatusPayload,
  buildDirectProviderHealth,
  buildCapabilities,
  isDatabaseReady,
  executeDirectAssistantQuery,
} = require("../services/aiAssistantService");
const router = express.Router();
const buckets = new Map();
router.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

function aiRateLimit(req, res, next) {
  const key = String(req.user.id), now = Date.now();
  const windowMs = Math.max(10000, Number(process.env.AI_RATE_LIMIT_WINDOW_MS) || 60000);
  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= (Number(process.env.AI_RATE_LIMIT_MAX_REQUESTS) || 20)) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000))));
    return res.status(429).json({ success: false, requestId: req.requestId, error: { code: "RATE_LIMITED", message: "Too many AI requests" } });
  }
  buckets.set(key, [...recent, now]);
  if (buckets.size > 1000) for (const [id, times] of buckets) if (now - times.at(-1) > windowMs) buckets.delete(id);
  next();
}
function getAiBaseUrl() {
  if ("AI_ENGINE_URL" in process.env) {
    return String(process.env.AI_ENGINE_URL || "").trim().replace(/\/+$/, "");
  }
  if (resolveDirectProviderConfig()?.configured) {
    return "";
  }
  return process.env.NODE_ENV !== "production" ? "http://127.0.0.1:8001" : "";
}
// Logged once at boot so a missing AI gateway target is visible in the deploy
// log instead of only in a student's 503.
//
// Deliberately NOT a hard exit: this process also serves auth, timetables,
// courses, AR and Socket.IO. Taking the whole product down because the AI URL
// is unset would be worse than degrading AI to an explicit CONFIG_FAILED 503.
// edunova-ai is the service that owns the model (loaded in-process through its
// own supervised runtime), so it fail-fasts on a broken MODEL configuration.
function logAiGatewayConfig() {
  const configured = Boolean(getAiBaseUrl());
  const token = Boolean(process.env.AI_INTERNAL_TOKEN);
  if (process.env.NODE_ENV === "production" && (!configured || !token)) {
    console.error(JSON.stringify({
      event: "ai.gateway.config_failed",
      code: !configured ? "AI_ENGINE_URL_MISSING" : "AI_INTERNAL_TOKEN_MISSING",
      message: !configured
        ? "AI_ENGINE_URL is not configured; /api/ai/* will return 503 CONFIG_FAILED. Set it to the public HTTPS URL of edunova-ai."
        : "AI_INTERNAL_TOKEN is not configured; /api/ai/* will return 503 AUTH_FAILED. Use the same value as on edunova-ai and edunova-inference.",
      aiRoutesDegraded: true,
      restOfApiAvailable: true,
    }));
    return;
  }
  console.info(JSON.stringify({ event: "ai.gateway.config_ok", aiEngineConfigured: configured, internalTokenConfigured: token }));
}
logAiGatewayConfig();

function internalHeaders(requestId) {
  return { "Content-Type": "application/json", "X-Request-Id": requestId,
    ...(process.env.AI_INTERNAL_TOKEN ? { "X-AI-Internal-Token": process.env.AI_INTERNAL_TOKEN } : {}) };
}
function fail(res, status, code, message, requestId) {
  return res.status(status).json({ success: false, error: { code, message }, message, requestId: requestId || res.getHeader("X-Request-Id"), agentStatus: "failed" });
}
function networkCode(error) {
  return ["ETIMEDOUT", "ECONNABORTED"].includes(error.code) ? "UPSTREAM_TIMEOUT" : "AI_SERVICE_UNREACHABLE";
}
async function applicationContext(user, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (JSON.stringify(raw).length > 8000) throw Object.assign(new Error("Application context is too large"), { status: 413, code: "INVALID_INPUT" });
  const result = { feature: String(raw.feature || "").slice(0, 80), route: String(raw.route || "").slice(0, 200) };
  const lessonId = raw.context?.lessonId;
  if (lessonId) {
    if (typeof lessonId !== "string" || typeof (raw.context.hotspotId || "") !== "string") throw Object.assign(new Error("Invalid AR context"), { status: 400, code: "INVALID_INPUT" });
    // Only identifiers come from the browser. Descriptions/objectives are read
    // from the published, authorized lesson. Never accept camera frames or IDs
    // identifying another student, even if a prompt asks for them.
    result.context = await educationalContext(user, { lessonId, hotspotId: raw.context.hotspotId });
  }
  return result;
}
async function readLimited(stream, max = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) { stream.destroy(); throw new Error("Upstream response exceeded maximum size"); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function runDirectProviderChat({ req, res, directConfig, message, conversationId, context, stream, requestId }) {
  if (!stream) {
    const answer = await executeDirectAssistantQuery({
      providerConfig: directConfig,
      user: req.user,
      message,
      conversationId,
      applicationContext: context,
    });
    return res.status(200).json({ ...answer, requestId });
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const writeSse = (event) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  try {
    const finalEvent = await executeDirectAssistantQuery({
      providerConfig: directConfig,
      user: req.user,
      message,
      conversationId,
      applicationContext: context,
      onEvent: async (evt) => writeSse(evt),
    });
    writeSse({ ...finalEvent, requestId });
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (err) {
    writeSse({
      type: "error",
      success: false,
      error: {
        code: err.code || "INFERENCE_FAILED",
        message: err.message || "AI service is temporarily unavailable",
      },
      message: err.message || "AI service is temporarily unavailable",
      requestId,
    });
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

async function handleAgentChat(req, res) {
  const requestId = req.requestId;
  res.setHeader("X-Request-Id", requestId);
  const message = req.body?.message;
  const conversationId = req.body?.conversationId;
  if (typeof message !== "string" || !message.trim()) return fail(res, 400, "INVALID_INPUT", "message is required", requestId);
  if (message.length > 12000) return fail(res, 413, "INVALID_INPUT", "message is too long", requestId);
  if (conversationId && (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(conversationId))) return fail(res, 400, "INVALID_INPUT", "conversationId is invalid", requestId);

  const base = getAiBaseUrl();
  const directConfig = resolveDirectProviderConfig();
  const stream = req.path === "/stream" || (req.path === "/chat" && /text\/event-stream/i.test(req.headers.accept || ""));

  if (directConfig?.invalidConfig && !base) {
    return fail(res, 503, "CONFIG_FAILED", directConfig.error, requestId);
  }
  if (!base && !directConfig?.configured) {
    return fail(res, 503, "CONFIG_FAILED", "AI service endpoint is not configured", requestId);
  }
  if (base && process.env.NODE_ENV === "production" && !process.env.AI_INTERNAL_TOKEN && !directConfig?.configured) {
    return fail(res, 503, "AUTH_FAILED", "Internal AI authentication is not configured", requestId);
  }

  const controller = new AbortController();
  const started = Date.now();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  console.info(JSON.stringify({ event: "ai.request", requestId, userId: String(req.user.id), stream }));
  try {
    const context = await applicationContext(req.user, req.body?.applicationContext);

    // If AI_ENGINE_URL is unset (or internal auth is unconfigured in prod), use
    // the configured direct OpenAI-compatible provider directly.
    if (!base || (process.env.NODE_ENV === "production" && !process.env.AI_INTERNAL_TOKEN)) {
      return await runDirectProviderChat({
        req,
        res,
        directConfig,
        message: message.trim(),
        conversationId,
        context,
        stream,
        requestId,
      });
    }

    // One observational probe. A permanently failed or starting service is NOT
    // a request queue, and chat must not wake/reload it. No blind POST retries:
    // replaying a tool-bearing request could duplicate writes.
    const probeStarted = Date.now();
    let ready;
    try {
      ready = await axios.get(`${base}/api/ai/ready`, { headers: internalHeaders(requestId), timeout: 8000, signal: controller.signal, validateStatus: () => true });
    } catch (probeErr) {
      if (directConfig?.configured) {
        return await runDirectProviderChat({
          req,
          res,
          directConfig,
          message: message.trim(),
          conversationId,
          context,
          stream,
          requestId,
        });
      }
      throw probeErr;
    }

    // Hop 1->2 of the request path (Express gateway -> AI orchestrator).
    console.info(JSON.stringify({ event: "ai.hop.gateway_to_ai", requestId, readyStatus: ready.status, probeMs: Date.now() - probeStarted, modelReady: ready.data?.modelReady === true, errorStage: ready.data?.errorStage || null }));
    if (ready.status !== 200 || ready.data?.modelReady !== true) {
      if (directConfig?.configured) {
        return await runDirectProviderChat({
          req,
          res,
          directConfig,
          message: message.trim(),
          conversationId,
          context,
          stream,
          requestId,
        });
      }
      const isNonJsonReady = !ready.data || typeof ready.data !== "object" || Array.isArray(ready.data);
      const code = (!isNonJsonReady && ready.data?.errorStage) ||
        (ready.status === 401 ? "AUTH_FAILED" :
          ready.status === 404 ? "CONFIG_FAILED" :
          ready.status === 502 || ready.status >= 520 ? "AI_SERVICE_UNAVAILABLE" :
          (!isNonJsonReady && ready.data?.permanentFailure) ? "MODEL_STARTUP_FAILED" : "MODEL_NOT_READY");
      const safeMsg = (!isNonJsonReady && (ready.data?.lastError || ready.data?.error?.message)) ||
        (ready.status === 503 ? "AI assistant is starting up. Please try again in a moment." :
          ready.status === 404 ? "AI service endpoint is not configured properly." :
          "AI service is temporarily unavailable.");
      return fail(res, ready.status === 401 || ready.status === 502 || ready.status === 404 ? 503 : ready.status >= 400 ? ready.status : 503, code, safeMsg, requestId);
    }
    const payload = { requestId, message: message.trim(), conversationId, ownerId: String(req.user.id),
      userRole: req.user.role, userName: req.user.name, userEmail: req.user.email,
      applicationContext: context, stream };
    const upstreamStarted = Date.now();
    const upstream = await axios.post(`${base}/api/ai/chat`, payload, {
      headers: { ...internalHeaders(requestId), Accept: stream ? "text/event-stream" : "application/json" },
      responseType: "stream", signal: controller.signal, timeout: Math.max(15000, Number(process.env.AGENT_REQUEST_TIMEOUT) || 120000), validateStatus: () => true,
    });
    console.info(JSON.stringify({ event: "ai.hop.ai_response_headers", requestId, upstreamStatus: upstream.status, connectMs: Date.now() - upstreamStarted }));
    if (upstream.status >= 400) {
      let data;
      try { data = await readLimited(upstream.data); }
      catch { return fail(res, upstream.status, `UPSTREAM_HTTP_${upstream.status}`, `AI service returned HTTP ${upstream.status} without a diagnostic body`, requestId); }
      const detail = data.detail || data.error || {};
      return fail(res, upstream.status, detail.code || (upstream.status === 401 ? "AUTH_FAILED" : "INFERENCE_FAILED"), typeof detail === "string" ? detail : detail.message || "AI rejected the request", requestId);
    }
    if (!stream) {
      const body = await readLimited(upstream.data);
      console.info(JSON.stringify({ event: "ai.hop.browser_to_api_complete", requestId, totalMs: Date.now() - started, upstreamStatus: upstream.status }));
      return res.status(upstream.status).json({ ...body, requestId });
    }
    if (!String(upstream.headers["content-type"]).includes("text/event-stream")) {
      upstream.data.destroy();
      return fail(res, 502, "INVALID_STREAM", "AI did not return an event stream", requestId);
    }
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders();
    let idle;
    const endWithError = (code, message) => {
      if (!res.writableEnded && !res.destroyed) res.end(`data: ${JSON.stringify({ type: "error", success: false, error: { code, message }, message, requestId })}\n\n`);
      upstream.data.destroy();
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => endWithError("UPSTREAM_TIMEOUT", "AI stream stopped sending data"), Number(process.env.AGENT_STREAM_IDLE_TIMEOUT_MS) || 90000);
    };
    arm();
    upstream.data.on("data", arm);
    upstream.data.on("error", () => endWithError("STREAM_INTERRUPTED", "The AI stream was interrupted; the answer is incomplete"));
    upstream.data.on("end", () => console.info(JSON.stringify({ event: "ai.stream.end", requestId, totalMs: Date.now() - started })));
    const cleanup = () => { clearTimeout(idle); upstream.data.destroy(); };
    upstream.data.on("close", () => clearTimeout(idle));
    res.on("close", cleanup);
    upstream.data.pipe(res); // Node pipe handles downstream backpressure.
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    const code = error.code && error.status ? error.code : networkCode(error);
    console.error(JSON.stringify({ event: "ai.failure", requestId, code, failureStage: "gateway", totalMs: Date.now() - started }));
    if (!res.headersSent) return fail(res, error.status || 503, code, error.status ? error.message : "The AI service could not be reached", requestId);
    res.end();
  }
}
function authorizeInternal(req, res, next) {
  const configured = Buffer.from(String(process.env.AI_INTERNAL_TOKEN || ""));
  const supplied = Buffer.from(String(req.headers["x-ai-internal-token"] || ""));
  if (!configured.length) return fail(res, 503, "AUTH_FAILED", "AI internal authentication is not configured");
  if (configured.length !== supplied.length || !crypto.timingSafeEqual(configured, supplied)) return fail(res, 401, "AUTH_FAILED", "Unauthorized internal request");
  next();
}
async function executeInternalTool(req, res) {
  const userId = String(req.headers["x-user-id"] || "");
  if (!userId) return fail(res, 401, "AUTH_FAILED", "Authenticated identity is required");
  try {
    const result = await executeApplicationTool(String(req.body?.tool || req.body?.name || ""), req.body?.arguments || {}, userId, String(req.body?.conversationId || "").slice(0, 100));
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) { fail(res, 500, "DATABASE_FAILED", "Internal tool execution failed"); }
}
router.post("/internal/tools", authorizeInternal, executeInternalTool);
router.post("/tools/execute", authorizeInternal, executeInternalTool);
router.post("/actions/:token/confirm", auth, aiRateLimit, async (req, res) => {
  try {
    const result = await confirmApplicationTool(req.params.token, String(req.user.id));
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch { fail(res, 500, "DATABASE_FAILED", "Action could not be saved"); }
});

// Observational status proxies with unified, honest status normalization.
function proxyStatus(path, timeout = 10000) {
  const isHealthOrReady = path === "/api/ai/health" || path === "/api/ai/ready";

  return async (req, res) => {
    const base = getAiBaseUrl();
    const directConfig = resolveDirectProviderConfig();
    const dbReady = isDatabaseReady();
    const internalAuthReady = !(process.env.NODE_ENV === "production" && !process.env.AI_INTERNAL_TOKEN);
    const offlineCaps = buildCapabilities({ chatReady: false, dbReady: false, researchReady: false });

    if (!base) {
      const directHealth = buildDirectProviderHealth(directConfig);
      return res.status(directHealth.httpStatus).json(directHealth.payload);
    }

    if (!internalAuthReady && !directConfig?.configured && isHealthOrReady) {
      return res.status(503).json({
        success: false,
        status: "not_configured",
        configured: false,
        provider: "edunova-ai",
        database: dbReady ? "connected" : "disconnected",
        modelReady: false,
        modelState: "CONFIG_FAILED",
        capabilities: offlineCaps,
        errorCode: "CONFIG_FAILED",
        error: {
          code: "CONFIG_FAILED",
          message: "Internal AI service authentication is not configured",
        },
        message: "Internal AI service authentication is not configured",
      });
    }

    try {
      const response = await axios.get(`${base}${path}`, { headers: internalHeaders(crypto.randomUUID()), timeout, validateStatus: () => true });

      // Non-JSON upstream bodies occur when Render/Cloudflare returns an HTML
      // loading page (503), Bad Gateway page (502), 404 page, timeout (504),
      // or when AI_ENGINE_URL points to a static HTML host (200).
      if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
        if (directConfig?.configured && isHealthOrReady) {
          const directHealth = buildDirectProviderHealth(directConfig);
          return res.status(directHealth.httpStatus).json(directHealth.payload);
        }
        if (response.status === 503) {
          return res.status(503).json({
            success: false,
            status: "degraded",
            configured: true,
            provider: "edunova-ai",
            database: dbReady ? "connected" : "disconnected",
            modelReady: false,
            modelState: "starting",
            capabilities: buildCapabilities({ chatReady: false, dbReady, researchReady: false }),
            errorCode: "MODEL_NOT_READY",
            error: {
              code: "MODEL_NOT_READY",
              message: "The AI service is starting up. Please try again in a moment.",
            },
            message: "The AI service is starting up. Please try again in a moment.",
          });
        }
        if (response.status === 404) {
          return res.status(503).json({
            success: false,
            status: "not_configured",
            configured: false,
            provider: "edunova-ai",
            database: dbReady ? "connected" : "disconnected",
            modelReady: false,
            modelState: "CONFIG_FAILED",
            capabilities: offlineCaps,
            errorCode: "CONFIG_FAILED",
            error: {
              code: "CONFIG_FAILED",
              message: "The AI service URL is wrong or the service is not deployed (upstream 404). Check AI_ENGINE_URL.",
            },
            message: "The AI service URL is wrong or the service is not deployed (upstream 404). Check AI_ENGINE_URL.",
          });
        }
        if (response.status === 401 || response.status === 403) {
          return res.status(503).json({
            success: false,
            status: "not_configured",
            configured: false,
            provider: "edunova-ai",
            database: dbReady ? "connected" : "disconnected",
            modelReady: false,
            modelState: "CONFIG_FAILED",
            capabilities: offlineCaps,
            errorCode: "AUTH_FAILED",
            error: {
              code: "AUTH_FAILED",
              message: "Internal AI authentication was rejected by the upstream AI service.",
            },
            message: "Internal AI authentication was rejected by the upstream AI service.",
          });
        }
        if (response.status === 504) {
          return res.status(504).json({
            success: false,
            status: "unavailable",
            configured: true,
            provider: "edunova-ai",
            database: dbReady ? "connected" : "disconnected",
            modelReady: false,
            modelState: "UPSTREAM_TIMEOUT",
            capabilities: offlineCaps,
            errorCode: "UPSTREAM_TIMEOUT",
            error: {
              code: "UPSTREAM_TIMEOUT",
              message: "AI service is temporarily unavailable (upstream timed out).",
            },
            message: "AI service is temporarily unavailable (upstream timed out).",
          });
        }
        if (response.status === 429 || response.status >= 500) {
          return res.status(503).json({
            success: false,
            status: "unavailable",
            configured: true,
            provider: "edunova-ai",
            database: dbReady ? "connected" : "disconnected",
            modelReady: false,
            modelState: "UNAVAILABLE",
            capabilities: offlineCaps,
            errorCode: "AI_SERVICE_UNAVAILABLE",
            error: {
              code: "AI_SERVICE_UNAVAILABLE",
              message: "AI service is temporarily unavailable",
            },
            message: "AI service is temporarily unavailable",
          });
        }
        return res.status(502).json({
          success: false,
          status: "invalid_response",
          configured: true,
          provider: "edunova-ai",
          database: dbReady ? "connected" : "disconnected",
          modelReady: false,
          modelState: "INVALID_RESPONSE",
          capabilities: offlineCaps,
          errorCode: "INVALID_STATUS_RESPONSE",
          error: {
            code: "INVALID_STATUS_RESPONSE",
            message: "Unable to verify AI service status",
          },
          message: "Unable to verify AI service status",
        });
      }

      const data = response.data;
      const code = data.errorCode || data.errorStage || (response.status === 401 ? "AUTH_FAILED" : null);
      if (code && !data.error) data.error = { code, message: data.errorMessage || data.lastError || null };

      if (isHealthOrReady) {
        if (response.status >= 400 && directConfig?.configured) {
          const directHealth = buildDirectProviderHealth(directConfig);
          return res.status(directHealth.httpStatus).json(directHealth.payload);
        }
        const normalized = normalizeUpstreamStatusPayload(data, response.status, { internalAuthReady });
        return res.status(normalized.httpStatus).json(normalized.payload);
      }

      return res.status(response.status).json(data);
    } catch (error) {
      if (directConfig?.configured && isHealthOrReady) {
        const directHealth = buildDirectProviderHealth(directConfig);
        return res.status(directHealth.httpStatus).json(directHealth.payload);
      }
      const code = networkCode(error);
      const message =
        code === "UPSTREAM_TIMEOUT"
          ? "AI service did not respond in time"
          : "AI service is temporarily unavailable";
      return res.status(503).json({
        success: false,
        status: "unavailable",
        configured: true,
        provider: "edunova-ai",
        database: dbReady ? "connected" : "disconnected",
        modelReady: false,
        modelState: "UNREACHABLE",
        capabilities: offlineCaps,
        error: { code, message },
        message,
      });
    }
  };
}
router.get("/health", auth, proxyStatus("/api/ai/health"));
router.get("/ready", auth, proxyStatus("/api/ai/ready"));
router.get("/model/status", auth, proxyStatus("/model/status"));
router.get("/system/resources", auth, async (req, res) => {
  if (req.user.role !== "admin") return fail(res, 403, "PERMISSION_DENIED", "Admin diagnostics only");
  return proxyStatus("/system/resources")(req, res);
});
router.get("/diagnose", auth, aiRateLimit, async (req, res) => {
  if (req.user.role !== "admin") return fail(res, 403, "PERMISSION_DENIED", "Admin diagnostics only");
  try {
    const response = await axios.get(`${getAiBaseUrl()}/api/ai/diagnose`, { headers: internalHeaders(crypto.randomUUID()), timeout: 90000 });
    res.json(response.data);
  } catch (error) { fail(res, 503, networkCode(error), "Model diagnostic failed"); }
});
router.post("/chat", auth, aiRateLimit, handleAgentChat);
router.post("/stream", auth, aiRateLimit, handleAgentChat);
router.post("/query", auth, aiRateLimit, handleAgentChat);
module.exports = router;
