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
  } else if (baseURL === "/api") {
    console.error(
      "[EduNova] VITE_API_URL was not set at build time. The app will call the " +
        "site's own origin for /api, which has no backend. Set VITE_API_URL in " +
        "the Cloudflare dashboard and redeploy."
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
    const res = await API.get("/timetable/today");
    return res.data;
  } catch {
    return { timetable: [] };
  }
};

// ==========================
// TEACHER TIMETABLE
// ==========================

export const getTodayTeacherTimetable = async () => {
  try {
    const res = await API.get("/teacher-timetable/today");
    return res.data;
  } catch {
    return { timetable: [] };
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

export function aiRequestErrorMessage(status, detail) {
  const safeDetail = safeAIErrorDetail(detail);
  // Preserve the backend's precise classification when available.
  // The FastAPI AI service now returns distinct messages:
  //  - 503 + "configuration requires attention" => LLM credentials/model/endpoint misconfig
  //  - 502 / 503 + "temporarily unavailable" => transient provider outage
  //  - 429 => rate limit, 401/403 => auth
  // If the backend supplied a safe, specific detail, surface it instead of a generic fallback.
  const isConfigMessage = /configuration requires attention/i.test(safeDetail);
  if (status === 404) {
    return safeDetail || "The EduNova AI endpoint is unavailable. Please try again after the service is redeployed.";
  }
  if (status === 401 || status === 403) {
    return safeDetail || "EduNova AI authentication failed. Please sign in again; if it continues, the AI service configuration needs attention.";
  }
  if (status === 429) {
    return safeDetail || "EduNova AI is busy right now. Please try again shortly.";
  }
  if (status === 503) {
    // 503 from the AI service is either a config problem or a cold-start/wake-up.
    // Prefer the backend's specific message when present; otherwise distinguish by intent.
    if (safeDetail) return safeDetail;
    return "EduNova AI configuration requires attention. The AI provider is not configured or is starting up. Please try again shortly.";
  }
  if (status === 502) {
    return safeDetail || "The AI model provider is temporarily unavailable. Please try again.";
  }
  if (status === 504) {
    return safeDetail || "EduNova AI took too long to respond. Please try again.";
  }
  if (status >= 500) {
    // Generic fallback for other 5xx, but still honor a safe config hint if present
    if (isConfigMessage) return safeDetail;
    return safeDetail || "The EduNova AI backend or model provider is temporarily unavailable. Please try again shortly.";
  }
  return safeDetail || "EduNova AI could not complete this request. Please try again.";
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
  READY: "ready",
  UNAVAILABLE: "unavailable",
};

const AI_STATUS_LABELS = {
  [AI_STATUS.UNKNOWN]: "Checking AI model...",
  [AI_STATUS.STARTING]: "AI model starting...",
  [AI_STATUS.READY]: "Ready to help",
  [AI_STATUS.UNAVAILABLE]: "AI model unavailable",
};

export const aiStatusLabel = (status) =>
  AI_STATUS_LABELS[status] || AI_STATUS_LABELS[AI_STATUS.UNKNOWN];

function classifyAIHealth(body, httpStatus) {
  if (!body || typeof body !== "object") {
    return httpStatus === 503 ? AI_STATUS.STARTING : AI_STATUS.UNKNOWN;
  }
  if (body.modelReady === true || body.success === true) return AI_STATUS.READY;
  const state = String(body.modelState || body.status || "").toLowerCase();
  if (["not_started", "downloading", "loading", "model_loading", "cold"].includes(state)) {
    return AI_STATUS.STARTING;
  }
  if (["ready", "model_ready"].includes(state)) return AI_STATUS.READY;
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
      // Progress detail (e.g. "downloading 42%") for the starting state only.
      detail: describeModelProgress(res.data?.model),
    };
  } catch {
    return { status: AI_STATUS.UNKNOWN, label: aiStatusLabel(AI_STATUS.UNKNOWN), detail: "" };
  }
};

function describeModelProgress(model) {
  if (!model || typeof model !== "object") return "";
  if (model.state === "downloading") {
    const done = Number(model.downloadedBytes) || 0;
    const total = Number(model.expectedSizeBytes) || 0;
    if (total > 0 && done > 0) {
      return `Downloading model ${Math.min(99, Math.floor((done / total) * 100))}%`;
    }
    return "Downloading model";
  }
  if (model.state === "loading") return "Loading model into memory";
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
    const rawDetail = err.response?.data?.error || err.response?.data?.detail;
    const detail = typeof rawDetail === "object" ? rawDetail?.message : rawDetail;
    return {
      success: false,
      status,
      error: err.response
        ? aiRequestErrorMessage(status, detail)
        : "The EduNova AI backend is unreachable. Check your connection and try again.",
    };
  }
};

// Consume the safe high-level SSE event stream from the autonomous agent. Tool
// observations and private model reasoning never reach this browser API.
export const streamAIEngine = async ({ message, conversationId, applicationContext, onEvent }) => {
  let response;
  try {
    response = await fetch(apiUrl("/ai/chat"), {
      method: "POST",
      headers: aiAuthHeaders({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      body: JSON.stringify({ message, conversationId, applicationContext }),
    });
  } catch (error) {
    console.error("[EduNova AI] Backend request failed:", error);
    throw new Error("The EduNova AI backend is unreachable. Check your connection and try again.");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      const rawDetail = body.error || body.detail || "";
      detail = typeof rawDetail === "object" ? rawDetail?.message || "" : rawDetail;
    } catch {
      // Use the status-specific, user-safe fallback for non-JSON proxy errors.
    }
    throw new Error(aiRequestErrorMessage(response.status, detail));
  }
  if (!response.body) throw new Error("This browser cannot receive the AI response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalAnswer = null;

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
      throw new Error("EduNova AI returned a malformed update. Please try again.");
    }
    onEvent?.(event);
    if (event.type === "answer") finalAnswer = event;
    if (event.type === "error") throw new Error(event.message || "EduNova AI request failed");
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) consumeBlock(block);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!finalAnswer) throw new Error("EduNova AI ended without an answer");
  return finalAnswer;
};
