import React, { useMemo, useState } from "react";
import { queryAIEngine } from "../api/api";

export default function AIChatAssistant({ user }) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const email = useMemo(() => String(user?.email || "").trim(), [user]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) return;
    if (!email) {
      setError("Logged in user email is required for AI queries.");
      return;
    }

    setLoading(true);
    setError("");
    const res = await queryAIEngine({ message: cleanMessage, email });
    setLoading(false);

    if (res?.error) {
      setError(res.error);
      return;
    }

    setResult(res);
  };

  return (
    <div className="glass-card p-5 sm:p-6 space-y-5">
      <div>
        <h2 className="text-xl sm:text-2xl font-semibold text-slate-800">AI Chat Assistant</h2>
        <p className="text-sm text-slate-600 mt-1">
          HRM AI engine powered by internal ML intent detection.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-sm font-medium text-slate-700">Ask a question</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Example: Show my next class"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium disabled:opacity-60"
        >
          {loading ? "Processing..." : "Ask AI"}
        </button>
      </form>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-sm">
          <div>
            <span className="font-semibold">Intent:</span> {result.intent || "-"}
          </div>
          <div>
            <span className="font-semibold">Task:</span> {result.task || "-"}
          </div>
          <div>
            <span className="font-semibold">Confidence:</span>{" "}
            {typeof result.confidence === "number" ? result.confidence.toFixed(4) : "-"}
          </div>
          <div>
            <span className="font-semibold">Response:</span>
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-white p-3 border border-slate-200 text-xs">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
