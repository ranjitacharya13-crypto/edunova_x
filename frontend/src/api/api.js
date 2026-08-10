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

export const queryAIEngine = async ({ message, email }) => {
  try {
    const res = await API.post("/ai/query", { message, email });
    return res.data;
  } catch (err) {
    return { error: err.response?.data?.error || "EduNova AI query failed" };
  }
};
