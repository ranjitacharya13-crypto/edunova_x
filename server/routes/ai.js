const express = require("express");
const axios = require("axios");
const crypto = require("node:crypto");
const auth = require("../middleware/auth");
const { executeApplicationTool, confirmApplicationTool } = require("../services/applicationTools");
const { educationalContext } = require("../services/arLessons");
const router = express.Router();
const buckets = new Map();

function aiRateLimit(req, res, next) {
  const key = String(req.user.id), now = Date.now();
  const windowMs = Math.max(10000, Number(process.env.AI_RATE_LIMIT_WINDOW_MS) || 60000);
  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= (Number(process.env.AI_RATE_LIMIT_MAX_REQUESTS) || 20)) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000))));
    return res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many AI requests" } });
  }
  buckets.set(key, [...recent, now]);
  if (buckets.size > 1000) for (const [id, times] of buckets) if (now - times.at(-1) > windowMs) buckets.delete(id);
  next();
}
function getAiBaseUrl() {
  const url = String(process.env.AI_ENGINE_URL || (process.env.NODE_ENV !== "production" ? "http://127.0.0.1:8001" : "")).trim();
  return url.replace(/\/+$/, "");
}
function internalHeaders(requestId) {
  return { "Content-Type": "application/json", "X-Request-Id": requestId,
    ...(process.env.AI_INTERNAL_TOKEN ? { "X-AI-Internal-Token": process.env.AI_INTERNAL_TOKEN } : {}) };
}
function fail(res, status, code, message, requestId) {
  return res.status(status).json({ success: false, error: { code, message }, message, requestId, agentStatus: "failed" });
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
async function handleAgentChat(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const message = req.body?.message;
  const conversationId = req.body?.conversationId;
  if (typeof message !== "string" || !message.trim()) return fail(res, 400, "INVALID_INPUT", "message is required", requestId);
  if (message.length > 12000) return fail(res, 413, "INVALID_INPUT", "message is too long", requestId);
  if (conversationId && (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(conversationId))) return fail(res, 400, "INVALID_INPUT", "conversationId is invalid", requestId);
  const base = getAiBaseUrl();
  if (!base) return fail(res, 503, "CONFIG_FAILED", "AI service endpoint is not configured", requestId);
  if (process.env.NODE_ENV === "production" && !process.env.AI_INTERNAL_TOKEN) return fail(res, 503, "AUTH_FAILED", "Internal AI authentication is not configured", requestId);
  const stream = req.path === "/chat" && /text\/event-stream/i.test(req.headers.accept || "");
  const controller = new AbortController();
  const started = Date.now();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  console.info(JSON.stringify({ event: "ai.request", requestId, userId: String(req.user.id), stream }));
  try {
    const context = await applicationContext(req.user, req.body?.applicationContext);
    // One observational probe. A permanently failed or starting service is NOT
    // a request queue, and chat must not wake/reload it. No blind POST retries:
    // replaying a tool-bearing request could duplicate writes.
    const ready = await axios.get(`${base}/api/ai/ready`, { headers: internalHeaders(requestId), timeout: 8000, signal: controller.signal, validateStatus: () => true });
    if (ready.status !== 200 || ready.data?.modelReady !== true) {
      const code = ready.data?.errorStage || (ready.status === 401 ? "AUTH_FAILED" : ready.data?.permanentFailure ? "MODEL_STARTUP_FAILED" : "MODEL_NOT_READY");
      return fail(res, ready.status === 401 ? 503 : ready.status >= 400 ? ready.status : 503, code,
        ready.data?.lastError || `Self-hosted inference is not ready (${ready.data?.lifecycle || "unavailable"})`, requestId);
    }
    const payload = { requestId, message: message.trim(), conversationId, ownerId: String(req.user.id),
      userRole: req.user.role, userName: req.user.name, userEmail: req.user.email,
      applicationContext: context, stream };
    const upstream = await axios.post(`${base}/api/ai/chat`, payload, {
      headers: { ...internalHeaders(requestId), Accept: stream ? "text/event-stream" : "application/json" },
      responseType: "stream", signal: controller.signal, timeout: Math.max(15000, Number(process.env.AGENT_REQUEST_TIMEOUT) || 120000), validateStatus: () => true,
    });
    if (upstream.status >= 400) {
      let data;
      try { data = await readLimited(upstream.data); }
      catch { return fail(res, upstream.status, `UPSTREAM_HTTP_${upstream.status}`, `AI service returned HTTP ${upstream.status} without a diagnostic body`, requestId); }
      const detail = data.detail || data.error || {};
      return fail(res, upstream.status, detail.code || (upstream.status === 401 ? "AUTH_FAILED" : "INFERENCE_FAILED"), typeof detail === "string" ? detail : detail.message || "AI rejected the request", requestId);
    }
    if (!stream) {
      return res.status(upstream.status).json({ ...await readLimited(upstream.data), requestId });
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
router.get("/health", auth, async (req, res) => {
  try {
    const response = await axios.get(`${getAiBaseUrl()}/api/ai/health`, { headers: internalHeaders(crypto.randomUUID()), timeout: 10000, validateStatus: () => true });
    if (!response.data || typeof response.data !== "object") return fail(res, 502, "INVALID_UPSTREAM", "AI health response is invalid");
    res.status(response.status).json(response.data);
  } catch { res.status(503).json({ success: false, modelReady: false, status: "error", error: { code: "AI_SERVICE_UNREACHABLE" } }); }
});
router.get("/diagnose", auth, aiRateLimit, async (req, res) => {
  if (req.user.role !== "admin") return fail(res, 403, "PERMISSION_DENIED", "Admin diagnostics only");
  try {
    const response = await axios.get(`${getAiBaseUrl()}/api/ai/diagnose`, { headers: internalHeaders(crypto.randomUUID()), timeout: 90000 });
    res.json(response.data);
  } catch (error) { fail(res, 503, networkCode(error), "Model diagnostic failed"); }
});
router.post("/chat", auth, aiRateLimit, handleAgentChat);
router.post("/query", auth, aiRateLimit, handleAgentChat);
module.exports = router;
