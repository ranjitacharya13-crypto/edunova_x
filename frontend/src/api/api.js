import axios from "axios";
import { mapLoginError } from "./authErrors.mjs";
import {
  clearStoredToken,
  getStoredToken,
  isJwtExpired,
  validateLoginResponse,
} from "./authSession.mjs";

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
// Cloudflare build ran without dashboard env vars), fall back directly to the
// deployed Render API over HTTPS. Talking directly to Render ensures Render's
// Cloudflare edge receives each visitor's true IP rather than collapsing all
// traffic behind a shared Worker egress IP. Local development is unaffected:
// in dev mode it still defaults to "/api", proxied by Vite to port 4000.
const DEFAULT_PROD_API_URL = "https://edunova-api-y3rx.onrender.com/api";

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

// Timeout is REQUIRED: without it a hung request (Render free-tier cold
// start, stalled proxy) leaves the login button on "Signing in..." forever.
const API = axios.create({
  baseURL,
  withCredentials: false,
  timeout: 30_000,
});

const SESSION_TERMINAL_CODES = new Set([
  "TOKEN_EXPIRED",
  "INVALID_TOKEN",
  "USER_NOT_FOUND",
  "ACCOUNT_BLOCKED",
]);

function notifySessionInvalidated(status, data) {
  clearStoredToken();
  if (typeof window === "undefined") return;
  const code = String(data?.code || "");
  const message =
    code === "ACCOUNT_BLOCKED" || status === 403
      ? "Your account has been suspended. Please contact an administrator."
      : "Your session has expired. Please sign in again.";
  window.dispatchEvent(
    new CustomEvent("edunova:auth-expired", {
      detail: { status, code, message },
    })
  );
}

function maybeInvalidateSession(config, status, data) {
  const url = String(config?.url || "");
  if (/\/auth\/(login|register)\b/i.test(url)) return;
  const authHeader =
    config?.headers?.Authorization ||
    config?.headers?.authorization ||
    (typeof config?.headers?.get === "function" && config.headers.get("Authorization")) ||
    "";
  if (!authHeader) return;

  const code = String(data?.code || "");
  const rawToken = String(authHeader).replace(/^Bearer\s+/i, "").trim();
  if (
    SESSION_TERMINAL_CODES.has(code) ||
    (status === 401 && rawToken && isJwtExpired(rawToken))
  ) {
    notifySessionInvalidated(status, data);
  }
}

API.interceptors.response.use(
  (response) => {
    if (response.status === 401 || response.status === 403) {
      maybeInvalidateSession(response.config, response.status, response.data);
    }
    return response;
  },
  (error) => {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      maybeInvalidateSession(error.config, status, error.response?.data);
    }
    return Promise.reject(error);
  }
);

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
    const payload = {
      ...formData,
      email: String(formData?.email || "").trim(),
      username: String(formData?.username || "").trim(),
    };
    const res = await API.post("/auth/register", payload, { timeout: 30_000 });
    return res.data;
  } catch (err) {
    return mapLoginError(err);
  }
};

// Returns { token, user } on success or { error, status, retryAfterSeconds, bucket }
// on failure. Never throws, never retries automatically, and validates that a
// 200 response actually carries a valid session payload.
export const loginUser = async (formData) => {
  try {
    const payload = {
      email: String(formData?.email || "").trim(),
      password: String(formData?.password || ""),
    };
    const res = await API.post("/auth/login", payload, { timeout: 30_000 });
    const checked = validateLoginResponse(res.data);
    if (!checked.ok) {
      return {
        error: checked.error,
        status: checked.status ?? res.status,
        retryAfterSeconds: checked.retryAfterSeconds || 0,
        bucket: checked.bucket || null,
      };
    }
    return { token: checked.token, user: checked.user };
  } catch (err) {
    return mapLoginError(err);
  }
};

// Verify a stored JWT against GET /api/auth/me on boot. Never throws.
export const getCurrentUser = async (tokenOverride) => {
  const token = String(tokenOverride || getStoredToken() || "").trim();
  if (!token) {
    return { user: null, status: 401, code: "NO_TOKEN" };
  }
  if (isJwtExpired(token)) {
    clearStoredToken();
    return {
      user: null,
      status: 401,
      code: "TOKEN_EXPIRED",
      error: "Your session has expired. Please sign in again.",
    };
  }
  try {
    const res = await API.get("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    if (res.data?.user && typeof res.data.user === "object") {
      return { user: res.data.user, status: 200, code: null };
    }
    return { user: null, status: res.status, code: "INVALID_RESPONSE" };
  } catch (err) {
    const status = err?.response?.status ?? null;
    const code = err?.response?.data?.code || null;
    const error = err?.response?.data?.error || "";
    if (status === 401 || status === 403) {
      clearStoredToken();
    }
    return { user: null, status, code, error };
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
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  const token = getStoredToken();
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
  MODEL_STORAGE_NOT_WRITABLE: "EduNova AI is unavailable: the AI server cannot write to its model storage directory (LOCAL_MODEL_DIR). An administrator must point it at a writable path — on Render free instances that is the source-tree cache (./models_cache); /var/data only works with a paid persistent disk.",
  MODEL_STORAGE_INSUFFICIENT_DISK: "EduNova AI is unavailable: the AI server does not have enough free disk space to store its model. An administrator needs to free space at the model cache directory or attach a larger disk.",
  MODEL_CHECKSUM_FAILED: "EduNova AI is unavailable: the downloaded model failed its checksum verification on the AI server. An administrator should clear the model cache so it re-downloads the verified artifact.",
  MODEL_PARTIAL_DOWNLOAD: "EduNova AI is unavailable: the model download on the AI server ended early (partial file). The cache was cleaned automatically; an administrator should check the AI service network and restart it.",
  MODEL_DOWNLOAD_TIMEOUT: "EduNova AI is unavailable: downloading the model took too long on the AI server. An administrator should increase LOCAL_MODEL_DOWNLOAD_TIMEOUT or use a smaller model quantization.",
  MODEL_NETWORK_FAILED: "EduNova AI is unavailable: the AI server could not reach the model host (network/DNS/TLS). An administrator needs to check the AI service's outbound network access.",
  MODEL_NOT_FOUND: "EduNova AI is unavailable: the configured model file does not exist at the model repository. An administrator needs to verify LOCAL_MODEL_REPO / LOCAL_MODEL_FILE.",
  MODEL_INVALID: "EduNova AI is unavailable: the model file on the AI server failed validation. An administrator needs to check the AI service.",
  MODEL_LOAD_FAILED: "EduNova AI is unavailable: the model could not be loaded into memory on the AI server.",
  WARMUP_FAILED: "EduNova AI is unavailable: the model loaded but failed its startup test on the AI server.",
  OUT_OF_MEMORY: "EduNova AI ran out of memory on the AI server. This is a deployment resource issue that an administrator must fix.",
  DEPENDENCY_FAILED: "EduNova AI is unavailable: the AI server is missing its inference runtime. An administrator needs to check the deployment build.",
  CONFIG_FAILED: "EduNova AI is not configured correctly on the server (AI service endpoint or model settings). An administrator needs to fix the configuration.",
  AUTH_FAILED: "EduNova AI authentication failed. Please sign in again; if it continues, the AI service's internal authentication needs attention.",
  AI_SERVICE_UNREACHABLE: "AI service is temporarily unavailable: the server could not reach the AI engine.",
  AI_SERVICE_UNAVAILABLE: "AI service is temporarily unavailable. Please wait a moment and try again.",
  INVALID_STATUS_RESPONSE: "Unable to verify AI service status.",
  INVALID_UPSTREAM: "Unable to verify AI service status.",
  PROVIDER_AUTH_FAILED: "AI provider authentication failed on the server. An administrator needs to verify the configured API key.",
  PROVIDER_UNAVAILABLE: "AI service is temporarily unavailable. Please try again shortly.",
  NOT_CONFIGURED: "AI service is not configured on the server.",
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
  DEGRADED: "degraded",
  BUSY: "busy",
  NOT_CONFIGURED: "not_configured",
  RESOURCE_INSUFFICIENT: "resource_insufficient",
  UNAVAILABLE: "unavailable",
  INVALID_RESPONSE: "invalid_response",
  NETWORK_FAILURE: "network_failure",
};

const EMPTY_AI_CAPABILITIES = Object.freeze({
  chat: false,
  timetable: false,
  subjects: false,
  quizAnalysis: false,
  studyPlanning: false,
  research: false,
});

// "AI assistant is ready" is shown ONLY when the model can genuinely answer
// and student capabilities are verified. Every other state reflects actual
// backend health honestly.
const AI_STATUS_LABELS = {
  [AI_STATUS.UNKNOWN]: "Checking AI service status...",
  [AI_STATUS.STARTING]: "AI assistant is starting up...",
  [AI_STATUS.LOADING]: "AI assistant is loading its model...",
  [AI_STATUS.READY]: "AI assistant is ready",
  [AI_STATUS.DEGRADED]: "AI assistant is running with limited capabilities",
  [AI_STATUS.BUSY]: "AI assistant is answering...",
  [AI_STATUS.NOT_CONFIGURED]: "AI service is not configured",
  [AI_STATUS.RESOURCE_INSUFFICIENT]: "AI server has insufficient memory for the configured model",
  [AI_STATUS.UNAVAILABLE]: "AI service is temporarily unavailable",
  [AI_STATUS.INVALID_RESPONSE]: "Unable to verify AI service status",
  [AI_STATUS.NETWORK_FAILURE]: "Unable to reach AI service",
};

export const aiStatusLabel = (status) =>
  AI_STATUS_LABELS[status] || AI_STATUS_LABELS[AI_STATUS.UNKNOWN];

export function normalizeAICapabilities(body, status) {
  if (![AI_STATUS.READY, AI_STATUS.DEGRADED, AI_STATUS.BUSY].includes(status)) {
    return { ...EMPTY_AI_CAPABILITIES };
  }
  const raw = body?.capabilities;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      chat: Boolean(raw.chat),
      timetable: Boolean(raw.timetable),
      subjects: Boolean(raw.subjects),
      quizAnalysis: Boolean(raw.quizAnalysis),
      studyPlanning: Boolean(raw.studyPlanning ?? raw.timetable),
      research: Boolean(raw.research),
    };
  }
  // Legacy ready payloads without explicit `capabilities` object.
  if (status === AI_STATUS.READY) {
    return {
      chat: true,
      timetable: true,
      subjects: true,
      quizAnalysis: true,
      studyPlanning: true,
      research: body?.searchConfigured !== false,
    };
  }
  return { ...EMPTY_AI_CAPABILITIES, chat: status === AI_STATUS.DEGRADED };
}

export function describeAICapabilities(modelStatus) {
  const status = modelStatus?.status || AI_STATUS.UNKNOWN;
  const caps = modelStatus?.capabilities || EMPTY_AI_CAPABILITIES;

  if (status === AI_STATUS.READY || status === AI_STATUS.DEGRADED || status === AI_STATUS.BUSY) {
    if (caps.timetable && caps.subjects && caps.quizAnalysis && caps.research) {
      return "Connected to your timetable, subjects, quiz scores, and verified research.";
    }
    const active = [];
    if (caps.timetable) active.push("timetable");
    if (caps.subjects) active.push("subjects");
    if (caps.quizAnalysis) active.push("quiz scores");
    if (caps.research) active.push("verified research");
    if (active.length > 0) {
      const joined =
        active.length === 1
          ? active[0]
          : `${active.slice(0, -1).join(", ")}, and ${active[active.length - 1]}`;
      return `Connected to your ${joined}.`;
    }
    if (caps.chat) {
      return "AI chat is active with limited student record integrations.";
    }
  }
  if (status === AI_STATUS.STARTING || status === AI_STATUS.LOADING) {
    return "AI assistant is warming up — student tools will connect once ready.";
  }
  if (status === AI_STATUS.NOT_CONFIGURED) {
    return "AI service is not configured on this server yet.";
  }
  if (status === AI_STATUS.INVALID_RESPONSE) {
    return "Unable to verify AI service status right now.";
  }
  if (status === AI_STATUS.NETWORK_FAILURE) {
    return "Network error while checking EduNova AI status. Check your connection.";
  }
  if (status === AI_STATUS.UNAVAILABLE || status === AI_STATUS.RESOURCE_INSUFFICIENT) {
    return "AI service is temporarily unavailable. Student integrations will resume when online.";
  }
  return "Verifying AI service and student data connections...";
}

export function classifyAIHealth(body, httpStatus) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return httpStatus >= 500 && httpStatus !== 502
      ? AI_STATUS.UNAVAILABLE
      : AI_STATUS.INVALID_RESPONSE;
  }

  // Permanent/resource failures always take precedence over optimistic fields.
  if (body.permanentFailure || body.model?.permanentFailure) {
    const permCode = String(body.errorCode || body.errorStage || body.error?.code || "").toUpperCase();
    if (permCode === "MODEL_RESOURCE_INSUFFICIENT" || permCode === "OUT_OF_MEMORY") {
      return AI_STATUS.RESOURCE_INSUFFICIENT;
    }
    if (["CONFIG_FAILED", "NOT_CONFIGURED", "AUTH_NOT_CONFIGURED"].includes(permCode) || body.configured === false) {
      return AI_STATUS.NOT_CONFIGURED;
    }
    return AI_STATUS.UNAVAILABLE;
  }

  const normalizedStatus = String(body.status || "").toLowerCase();
  const code = String(body.errorCode || body.errorStage || body.error?.code || "").toUpperCase();
  const state = String(body.modelState || body.lifecycle || body.status || "").toLowerCase();

  if (code === "INVALID_STATUS_RESPONSE" || code === "INVALID_UPSTREAM" || normalizedStatus === "invalid_response") {
    return AI_STATUS.INVALID_RESPONSE;
  }

  if (body.modelReady === true && httpStatus < 400) {
    if (normalizedStatus === "degraded") return AI_STATUS.DEGRADED;
    return AI_STATUS.READY;
  }

  if (
    body.configured === false ||
    normalizedStatus === "not_configured" ||
    ["CONFIG_FAILED", "NOT_CONFIGURED", "AUTH_NOT_CONFIGURED"].includes(code) ||
    ["config_failed", "missing_config", "not_configured"].includes(state)
  ) {
    return AI_STATUS.NOT_CONFIGURED;
  }

  if (code === "MODEL_RESOURCE_INSUFFICIENT" || code === "OUT_OF_MEMORY") {
    return AI_STATUS.RESOURCE_INSUFFICIENT;
  }

  if (["not_started", "starting", "cold", "model_not_ready", "boot"].includes(state) || code === "MODEL_NOT_READY") {
    return AI_STATUS.STARTING;
  }
  if (["downloading", "loading", "warming", "model_loading"].includes(state) || code === "MODEL_LOADING") {
    return AI_STATUS.LOADING;
  }
  if (["busy"].includes(state) || code === "MODEL_BUSY") {
    return AI_STATUS.BUSY;
  }
  if (normalizedStatus === "degraded" && httpStatus < 400) {
    return AI_STATUS.DEGRADED;
  }
  if (
    ["AI_SERVICE_UNREACHABLE", "AI_SERVICE_UNAVAILABLE", "UPSTREAM_TIMEOUT", "AUTH_FAILED", "PROVIDER_UNAVAILABLE", "PROVIDER_AUTH_FAILED"].includes(code) ||
    ["error", "failed", "model_failed", "model_unavailable", "unreachable", "unavailable"].includes(state)
  ) {
    return AI_STATUS.UNAVAILABLE;
  }

  // Reject unverified 2xx payloads missing all recognized status indicators.
  const hasKnownIndicator =
    typeof body.modelReady === "boolean" ||
    Boolean(body.modelState) ||
    Boolean(body.status) ||
    Boolean(body.error);
  if (!hasKnownIndicator) {
    return AI_STATUS.INVALID_RESPONSE;
  }

  if (httpStatus === 401 || httpStatus === 403) return AI_STATUS.UNAVAILABLE;
  if (state) return AI_STATUS.UNAVAILABLE;
  return AI_STATUS.INVALID_RESPONSE;
}

// Returns { status, label, detail, capabilities, provider, configured } — never throws.
export const getAIStatus = async () => {
  try {
    const res = await API.get("/ai/health", {
      headers: aiAuthHeaders(),
      timeout: 12_000,
      validateStatus: () => true,
    });
    const data = res.data && typeof res.data === "object" && !Array.isArray(res.data) ? res.data : null;
    const status = classifyAIHealth(data, res.status);
    const code = data?.errorCode || data?.errorStage || data?.error?.code || (data ? null : "INVALID_STATUS_RESPONSE");
    const capabilities = normalizeAICapabilities(data, status);
    const rawDetail =
      describeModelProgress(data?.model) ||
      safeAIErrorDetail(data?.degradedReason) ||
      (status === AI_STATUS.INVALID_RESPONSE
        ? ""
        : aiErrorCodeMessage(code, data?.errorMessage || data?.error?.message));

    return {
      status,
      label: aiStatusLabel(status),
      configured: data?.configured ?? status !== AI_STATUS.NOT_CONFIGURED,
      provider: typeof data?.provider === "string" ? data.provider : null,
      capabilities,
      terminal: Boolean(data?.permanentFailure || data?.model?.permanentFailure),
      code,
      detail: rawDetail && rawDetail !== aiStatusLabel(status) ? rawDetail : "",
    };
  } catch {
    return {
      status: AI_STATUS.NETWORK_FAILURE,
      label: aiStatusLabel(AI_STATUS.NETWORK_FAILURE),
      configured: null,
      provider: null,
      capabilities: { ...EMPTY_AI_CAPABILITIES },
      terminal: false,
      code: "NETWORK_ERROR",
      detail: AI_ERROR_MESSAGES.NETWORK_ERROR,
    };
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
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    cleanup();
    let data = null;
    try {
      data = await response.json();
    } catch {
      throw Object.assign(new Error(AI_ERROR_MESSAGES.INVALID_MODEL_OUTPUT), { code: "INVALID_MODEL_OUTPUT" });
    }
    const text = String(data?.message || data?.reply || data?.response || "").trim();
    if (!data || data.success === false || !text) {
      const { code, message: detail } = extractAIError(data);
      throw Object.assign(new Error(aiRequestErrorMessage(502, detail, code || "INVALID_MODEL_OUTPUT")), {
        code: code || "INVALID_MODEL_OUTPUT",
      });
    }
    const normalized = { ...data, type: "answer", message: text, reply: text };
    onEvent?.(normalized);
    return normalized;
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
