import { apiUrl } from "./api";
export async function learningRequest(path, { signal, ...options } = {}) {
  const token = localStorage.getItem("token");
  const response = await fetch(apiUrl(path), { ...options, signal,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const detail = data.error;
    throw new Error(typeof detail === "object" ? `${detail.code || "REQUEST_FAILED"}: ${detail.message || "Request failed"}` : detail || `Request failed (${response.status})`);
  }
  return data;
}
