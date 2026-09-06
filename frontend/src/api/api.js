import axios from "axios";

// ==========================
// API CLIENT (dev proxy + prod)
// ==========================
// DEV:  baseURL defaults to "/api" and the Vite dev proxy forwards it to the
//       local backend on port 4000 (see frontend/vite.config.mjs). Works on
//       desktop, mobile, ngrok — any device.
// PROD: VITE_API_URL is inlined at BUILD time. Set it in the Cloudflare
//       dashboard (Workers & Pages -> edunova-x -> Settings -> Variables) to
//       the Render API URL, including the /api suffix.
//
// The production frontend must NEVER call localhost/127.0.0.1: on Cloudflare
// that resolves to the visitor's own machine, not the backend.

// Normalize the base URL: all REST routes are mounted under /api on the
// backend. Accepts either "https://<api-host>" or "https://<api-host>/api" —
// a missing /api suffix is appended, otherwise requests 404
// ("Cannot GET /auth/login").
//
// PRODUCTION FALLBACK: If VITE_API_URL was not set at build time (e.g. the
// Cloudflare build ran without dashboard env vars), fall back to the deployed
// Render API. This keeps the committed production bundle self-sufficient and
// never lets a Cloudflare build silently dial the visitor's own origin for
// /api. Local development is unaffected: in dev mode it still defaults to
// "/api", which the Vite dev proxy forwards to the local backend on port 4000.
const DEFAULT_PROD_API_URL = "/api";

let baseURL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? DEFAULT_PROD_API_URL : "/api");
if (baseURL !== "/api" && !baseURL.replace(/\/+$/, "").endsWith("/api")) {
  baseURL = baseURL.replace(/\/+$/, "") + "/api";
}

// Guard: a production bundle that points at localhost is broken by definition
// (the browser would dial the visitor's own machine). Surface it loudly rather
// than failing with opaque network errors in the console.
if (import.meta.env.PROD) {
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseURL)) {
    console.error(
      `[EduNova] VITE_API_URL points at ${baseURL} in a production build. ` +
        "It must be the public HTTPS URL of the Render API."
    );
  }
}

const API = axios.create({
  baseURL,
  withCredentials: false,
});

// Resolve a relative API path ("/study", "/assignments/x/preview") against the
// configured base URL. Absolute URLs (https://...) pass through untouched.
// Use this everywhere a URL is rendered (previews, recordings, downloads) —
// plain "/api/..." strings break on static hosts (Render Static Site).
export const apiUrl = (path) => {
  const p = String(path || "");
  if (/^https?:\/\//i.test(p)) return p;
  if (!p) return baseURL;
  return `${baseURL}${p.startsWith("/") ? p : `/${p}`}`;
};

export { API };

// The API origin WITHOUT the trailing /api suffix (e.g.
// "https://edunova-api-y3rx.onrender.com"). The Express server hosts Socket.IO
// signaling + live-class chat on this same origin, so the Socket.IO clients use
// it to derive their endpoint. Empty in local development ("/api" is proxied by
// the Vite dev server and the browser connects same-origin instead).
export const API_ORIGIN =
  baseURL === "/api"
    ? ""
    : baseURL.replace(/\/api\/?$/, "").replace(/\/+$/, "");

// ==========================
// AUTH APIs
// ==========================

export const registerUser = async (formData) => {
  try {
    const res = await API.post("/auth/register", formData);
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Registration failed" };
  }
};

export const loginUser = async (formData) => {
  try {
    const res = await API.post("/auth/login", formData);
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Invalid credentials" };
  }
};

// ==========================
// STUDENT TIMETABLE
// ==========================

export const getTodayTimetable = async () => {
  try {
    const res = await API.get("/timetable/today", { headers: aiAuthHeaders() });
    return res.data;
  } catch (error) {
    return { timetable: [], error: error.response?.data?.error || "Timetable could not be loaded" };
  }
};

// ==========================
// TEACHER TIMETABLE
// ==========================

export const getTodayTeacherTimetable = async () => {
  try {
    const res = await API.get("/teacher-timetable/today", { headers: aiAuthHeaders() });
    return res.data;
  } catch (error) {
    return { timetable: [], error: error.response?.data?.error || "Timetable could not be loaded" };
  }
};

export const getAdminDashboard = async (token) => {
  try {
    const res = await API.get("/admin/dashboard", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Failed to load admin dashboard" };
  }
};

function adminAuthHeaders() {
  const token = localStorage.getItem("token");
  return {
    Authorization: `Bearer ${token}`,
  };
}

export const getAdminUsers = async (role = "") => {
  const res = await API.get("/admin/users", {
    params: role ? { role } : {},
    headers: adminAuthHeaders(),
  });
  return res.data;
};

export const deleteAdminUser = async (id) => {
  try {
    const res = await API.delete(`/admin/users/${id}`, {
      headers: adminAuthHeaders(),
    });
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Failed to delete user" };
  }
};

export const toggleAdminUserBlock = async (id, blocked) => {
  try {
    const res = await API.patch(
      `/admin/users/${id}/block`,
      { blocked },
      { headers: adminAuthHeaders() }
    );
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Failed to update user status" };
  }
};

export const getAdminTimetables = async (teacher = "") => {
  const res = await API.get("/admin/timetables", {
    params: teacher ? { teacher } : {},
    headers: adminAuthHeaders(),
  });
  return res.data;
};

export const deleteAdminTimetable = async (type, id) => {
  try {
    const res = await API.delete(`/admin/timetables/${type}/${id}`, {
      headers: adminAuthHeaders(),
    });
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Failed to delete timetable" };
  }
};

export const getAdminLiveClasses = async () => {
  const res = await API.get("/admin/liveclasses", {
    headers: adminAuthHeaders(),
  });
  return res.data;
};

export const getAdminVideos = async () => {
  const res = await API.get("/admin/videos", {
    headers: adminAuthHeaders(),
  });
  return res.data;
};

export const deleteAdminVideo = async (id) => {
  try {
    const res = await API.delete(`/admin/videos/${id}`, {
      headers: adminAuthHeaders(),
    });
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Failed to delete video" };
  }
};

export const getAdminAssignments = async () => {
  const res = await API.get("/admin/assignments", {
    headers: adminAuthHeaders(),
  });
  return res.data;
};

export const getAdminMessages = async () => {
  const res = await API.get("/admin/messages", {
    headers: adminAuthHeaders(),
  });
  return res.data;
};

export const deleteAdminMessage = async (id) => {
  try {
    const res = await API.delete(`/admin/messages/${id}`, {
      headers: adminAuthHeaders(),
    });
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "Failed to delete message" };
  }
};

export const getAdminAnalytics = async () => {
  const res = await API.get("/admin/analytics", {
    headers: adminAuthHeaders(),
  });
  return res.data;
};

function aiAuthHeaders(extra = {}) {
  const token = localStorage.getItem("token");
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function safeAIErrorDetail(detail) {
  const text = String(detail || "").trim();
  // The API only returns user-safe errors, but reject obvious HTML/proxy pages
  // so a Cloudflare or Render stack page is never rendered inside the chat UI.
  if (!text || text.length > 500 || /<\/?(?:html|body|pre|script)\b/i.test(text)) return "";
  return text;
}

// Precise, user-facing messages per backend error code. The backend (API
// gateway -> AI orchestrator -> inference service) always classifies failures;
// the UI never collapses them into a generic "Try again".
const AI_ERROR_MESSAGES = {
  MODEL_LOADING: "EduNova AI is starting — the model is loading on the AI server. This usually takes under a minute after a deploy or restart.",
  MODEL_NOT_READY: "EduNova AI is starting — the model is not ready yet. Please wait a moment; your message was not sent.",
  MODEL_RESOURCE_INSUFFICIENT: "EduNova AI cannot run right now: the AI server does not have enough memory for the model. This is a deployment resource issue that an administrator must fix — sending the question again will not help.",
  MODEL_STARTUP_FAILED: "EduNova AI is unavailable because the model failed to start on the AI server. An administrator has the exact failure stage in the model status page.",
  MODEL_FAILED: "EduNova AI is unavailable because the model failed on the AI server. An administrator needs to check the AI service.",
  MODEL_DOWNLOAD_FAILED: "EduNova AI is unavailable: the AI server could not download its model. An administrator needs to check the AI service network/model settings.",
  MODEL_INVALID: "EduNova AI is unavailable: the model file on the AI server failed validation. An administrator needs to check the AI service.",
  MODEL_LOAD_FAILED: "EduNova AI is unavailable: the model could not be loaded into memory on the AI server.",
  WARMUP_FAILED: "EduNova AI is unavailable: the model loaded but failed its startup test on the AI server.",
  OUT_OF_MEMORY: "EduNova AI ran out of memory on the AI server. This is a deployment resource issue that an administrator must fix.",
  DEPENDENCY_FAILED: "EduNova AI is unavailable: the AI server is missing its inference runtime. An administrator needs to check the deployment build.",
  CONFIG_FAILED: "EduNova AI is not configured correctly on the server (AI service endpoint or model settings). An administrator needs to fix the configuration.",
  AUTH_FAILED: "EduNova AI authentication failed. Please sign in again; if it continues, the AI service's internal authentication needs attention.",
  AI_SERVICE_UNREACHABLE: "EduNova AI service is unavailable: the API could not reach the AI server. If this persists, the AI service may be down or still deploying.",
  UPSTREAM_TIMEOUT: "The AI server did not respond in time. It may be overloaded — wait a moment before asking again.",
  MODEL_BUSY: "EduNova AI is answering another request right now. Wait a few seconds and send your message again — it was not lost.",
  RATE_LIMITED: "You are sending AI requests too quickly. Wait a few seconds and send your message again.",
  INFERENCE_FAILED: "EduNova AI hit an inference error while generating this answer. The model is running, so asking again is reasonable; if it repeats, an administrator should check the AI service logs.",
  OUTPUT_LIMIT_REACHED: "EduNova AI reached its maximum answer length before finishing and did not return a partial answer. Try a narrower question.",
  INVALID_MODEL_OUTPUT: "EduNova AI produced an invalid response for this question. Rephrasing the question usually helps.",
  STREAM_INTERRUPTED: "The connection to EduNova AI was interrupted before the answer finished. Check your network connection and ask again.",
  INVALID_STREAM: "EduNova AI did not return a valid response stream. If this repeats, the AI service needs attention.",
  DATABASE_FAILED: "EduNova could not read your data from the database for this request. This is a server-side database issue, not an AI problem.",
  PERMISSION_DENIED: "You do not have permission for this AI action.",
  INVALID_INPUT: "This message could not be processed. Shorten or rephrase it and send it again.",
  NETWORK_ERROR: "EduNova could not reach the API. Check your internet connection.",
};

export function aiErrorCodeMessage(code, detail) {
  const key = String(code || "").toUpperCase();
  return AI_ERROR_MESSAGES[key] || safeAIErrorDetail(detail) || "";
}

export function aiRequestErrorMessage(status, detail, code) {
  const safeDetail = safeAIErrorDetail(detail);
  const fromCode = aiErrorCodeMessage(code);
  if (fromCode) {
    // Append the backend's specific numbers (e.g. required/available MiB) when present.
    const numbers = /\d+\s*MiB/.test(safeDetail) ? ` (${safeDetail})` : "";
    return fromCode + numbers;
  }
  if (status === 404) return safeDetail || "The EduNova AI endpoint was not found. The API deployment may be missing the AI routes.";
  if (status === 401 || status === 403) return safeDetail || AI_ERROR_MESSAGES.AUTH_FAILED;
  if (status === 429) return safeDetail || AI_ERROR_MESSAGES.RATE_LIMITED;
  if (status === 503) return safeDetail || AI_ERROR_MESSAGES.AI_SERVICE_UNREACHABLE;
  if (status === 502) return safeDetail || AI_ERROR_MESSAGES.INFERENCE_FAILED;
  if (status === 504) return safeDetail || AI_ERROR_MESSAGES.UPSTREAM_TIMEOUT;
  if (status >= 500) return safeDetail || "The EduNova API hit a server error while handling this AI request.";
  return safeDetail || "EduNova AI could not complete this request.";
}

function extractAIError(body) {
  const raw = body?.error || body?.detail || "";
  if (typeof raw === "object" && raw) return { code: raw.code || body?.errorStage || "", message: raw.message || "" };
  return { code: body?.errorStage || body?.code || "", message: String(raw || "") };
}

export const confirmAIAction = async (confirmationToken) => {
  const token = encodeURIComponent(String(confirmationToken || ""));
  const res = await API.post(`/ai/actions/${token}/confirm`, {}, { headers: aiAuthHeaders() });
  return res.data;
};

// ---------------------------------------------------------------------------
// AI readiness.
// ---------------------------------------------------------------------------
// The self-hosted model is downloaded and loaded in the background after the
// AI service boots, so "the service answers" and "the model can answer" are
// two different facts. The UI must never advertise "Ready to help" while the
// model is still starting, so it reads the real model state from the backend
// health endpoint (which itself reads the llama.cpp lifecycle state machine).
export const AI_STATUS = {
  UNKNOWN: "unknown",
  STARTING: "starting",
  LOADING: "loading",
  READY: "ready",
  BUSY: "busy",
  RESOURCE_INSUFFICIENT: "resource_insufficient",
  UNAVAILABLE: "unavailable",
};

// "Ready to help" is shown ONLY when the model can genuinely answer. Every
// other state says what is actually happening — never an optimistic label over
// a model that is still loading or has failed.
const AI_STATUS_LABELS = {
  [AI_STATUS.UNKNOWN]: "Checking AI model...",
  [AI_STATUS.STARTING]: "EduNova AI is starting...",
  [AI_STATUS.LOADING]: "EduNova AI is loading its model...",
  [AI_STATUS.READY]: "Ready to help",
  [AI_STATUS.BUSY]: "EduNova AI is answering...",
  [AI_STATUS.RESOURCE_INSUFFICIENT]: "EduNova AI cannot run: the AI server has too little memory for the model.",
  [AI_STATUS.UNAVAILABLE]: "EduNova AI service is unavailable.",
};

export const aiStatusLabel = (status) =>
  AI_STATUS_LABELS[status] || AI_STATUS_LABELS[AI_STATUS.UNKNOWN];

export function classifyAIHealth(body, httpStatus) {
  if (!body || typeof body !== "object") {
    return AI_STATUS.UNAVAILABLE;
  }
  // modelReady is the authoritative signal (model + tokenizer + warm-up all OK).
  // `success` alone is NOT sufficient: the health endpoint answers success for a
  // live *process* whose model may still be loading or may have failed.
  if (body.modelReady === true && httpStatus < 400) return AI_STATUS.READY;
  if (body.permanentFailure || body.model?.permanentFailure) return AI_STATUS.UNAVAILABLE;

  const code = String(body.errorCode || body.errorStage || body.error?.code || "").toUpperCase();
  if (code === "MODEL_RESOURCE_INSUFFICIENT" || code === "OUT_OF_MEMORY") return AI_STATUS.RESOURCE_INSUFFICIENT;
  if (code === "AI_SERVICE_UNREACHABLE" || code === "UPSTREAM_TIMEOUT" || code === "CONFIG_FAILED") return AI_STATUS.UNAVAILABLE;
  const state = String(body.modelState || body.lifecycle || body.status || "").toLowerCase();
  if (["error", "failed", "model_failed", "model_unavailable", "missing_config", "unreachable"].includes(state)) {
    return AI_STATUS.UNAVAILABLE;
  }
  if (["not_started", "starting", "cold", "model_not_ready", "boot"].includes(state)) return AI_STATUS.STARTING;
  if (["downloading", "loading", "warming", "model_loading"].includes(state)) {
    return AI_STATUS.LOADING;
  }
  if (["busy"].includes(state)) return AI_STATUS.BUSY;
  if (["ready", "model_ready", "degraded"].includes(state)) return AI_STATUS.UNAVAILABLE;
  if (state) return AI_STATUS.UNAVAILABLE;
  return AI_STATUS.UNKNOWN;
}

// Returns { status, label, detail } — never throws, so a health blip cannot
// break the chat UI.
export const getAIStatus = async () => {
  try {
    const res = await API.get("/ai/health", {
      headers: aiAuthHeaders(),
      timeout: 12_000,
      validateStatus: () => true,
    });
    const status = classifyAIHealth(res.data, res.status);
    return {
      status,
      label: aiStatusLabel(status),
      terminal: Boolean(res.data?.permanentFailure || res.data?.model?.permanentFailure),
      // Progress detail (e.g. "downloading 42%") for the starting state only.
      code: res.data?.errorCode || res.data?.errorStage || res.data?.error?.code || null,
      detail: describeModelProgress(res.data?.model) || safeAIErrorDetail(res.data?.errorMessage || res.data?.error?.message),
    };
  } catch {
    return { status: AI_STATUS.UNAVAILABLE, label: AI_ERROR_MESSAGES.NETWORK_ERROR, code: "NETWORK_ERROR", detail: "" };
  }
};

function describeModelProgress(model) {
  if (!model || typeof model !== "object") return "";
  if (model.resource && model.resource.required_mb) {
    return `Model needs ${model.resource.required_mb} MiB; server has ${model.resource.available_mb} MiB (recommended ${model.resource.recommended_mb} MiB)`;
  }
  if (model.state === "MODEL_LOADING" || model.lifecycle === "MODEL_LOADING") return "Loading model into memory";
  if (model.state === "downloading") {
    const done = Number(model.downloadedBytes) || 0;
    const total = Number(model.expectedSizeBytes) || 0;
    if (total > 0 && done > 0) {
      return `Downloading model ${Math.min(99, Math.floor((done / total) * 100))}%`;
    }
    return "Downloading model";
  }
  if (model.state === "loading") return "Loading model into memory";
  if (model.state === "warming") return "Warming up the model";
  if (model.state === "error") {
    // Surface the real stage so an operator can act instead of guessing.
    const stage = String(model.errorDetail || "").replace(/_/g, " ").trim();
    return stage ? `Model startup failed (${stage})` : "Model startup failed";
  }
  return "";
}

export const queryAIEngine = async ({ message, conversationId, applicationContext }) => {
  try {
    const res = await API.post(
      "/ai/chat",
      { message, conversationId, applicationContext },
      { headers: aiAuthHeaders() }
    );
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const { code, message } = extractAIError(err.response?.data);
    return {
      success: false,
      status,
      code: err.response ? code || null : "NETWORK_ERROR",
      error: err.response ? aiRequestErrorMessage(status, message, code) : AI_ERROR_MESSAGES.NETWORK_ERROR,
    };
  }
};

// Consume the safe high-level SSE event stream from the autonomous agent. Tool
// observations and private model reasoning never reach this browser API. There
// is deliberately no wall-clock answer timer: live tokens/keep-alives prove the
// request is healthy, and the terminal answer event must contain the full text.

export const streamAIEngine = async ({
  message,
  conversationId,
  applicationContext,
  onEvent,
  signal: callerSignal,
}) => {
  // Abort only when the caller explicitly cancels (navigation, unmount, or a
  // newer question). Normal generation is allowed to finish.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const cleanup = () => {
    callerSignal?.removeEventListener("abort", forwardAbort);
  };

  let response;
  try {
    response = await fetch(apiUrl("/ai/chat"), {
      method: "POST",
      headers: aiAuthHeaders({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      body: JSON.stringify({ message, conversationId, applicationContext }),
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    if (callerSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    console.error("[EduNova AI] Backend request failed:", error);
    throw Object.assign(new Error(AI_ERROR_MESSAGES.NETWORK_ERROR), { code: "NETWORK_ERROR" });
  }

  if (!response.ok) {
    cleanup();
    let code = "";
    let detail = "";
    try {
      ({ code, message: detail } = extractAIError(await response.json()));
    } catch {
      // Use the status-specific, user-safe fallback for non-JSON proxy errors.
    }
    throw Object.assign(new Error(aiRequestErrorMessage(response.status, detail, code)), { code: code || null, status: response.status });
  }
  if (!response.body) {
    cleanup();
    throw new Error("This browser cannot receive the AI response stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalAnswer = null;
  let streamedText = "";

  const consumeBlock = (block) => {
    const dataText = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!dataText) return;
    let event;
    try {
      event = JSON.parse(dataText);
    } catch {
      // A truncated or malformed event must never surface as a raw parser
      // error; treat it like any other recoverable stream failure.
      throw Object.assign(new Error(AI_ERROR_MESSAGES.INVALID_STREAM), { code: "INVALID_STREAM" });
    }
    // Real generated tokens, emitted by llama.cpp as it decodes. Accumulate
    // them so the caller can render the answer progressively, and so a stream
    // that dies after partial output still has something to show.
    if (event.type === "token" && typeof event.delta === "string") {
      streamedText += event.delta;
      onEvent?.({ type: "token", delta: event.delta, text: streamedText });
      return;
    }
    onEvent?.(event);
    if (event.type === "answer") finalAnswer = event;
    if (event.type === "error") {
      const code = event.error?.code || "INFERENCE_FAILED";
      throw Object.assign(new Error(aiRequestErrorMessage(502, event.error?.message || event.message, code)), { code });
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (buffer.length > 1000000 || streamedText.length > 100000) throw new Error("AI response exceeds safe client capacity");
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) consumeBlock(block);
      if (done) break;
    }
    if (buffer.trim()) consumeBlock(buffer);
  } catch (error) {
    if (callerSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  } finally {
    cleanup();
    // Release the connection promptly; a lingering reader keeps the HTTP/2
    // stream (and the server-side generation) alive after the user moved on.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  if (!finalAnswer) {
    // Partial tokens are never promoted to a successful answer. A healthy
    // stream always ends with the authoritative, complete answer event.
    throw Object.assign(new Error(AI_ERROR_MESSAGES.STREAM_INTERRUPTED), { code: "STREAM_INTERRUPTED" });
  }
  return finalAnswer;
};
