import React, { useMemo, useState } from "react";
import { queryAIEngine } from "../api/api";
import EduNovaAIAvatar from "./EduNovaAIAvatar";

const ASSISTANT_NAME = "EduNova AI";
const ASSISTANT_SUBTITLE = "Your personal learning assistant";

const QUICK_PROMPTS = [
  "Explain today's topic",
  "Help me prepare for an exam",
  "Give me practice questions",
  "Summarize my study material",
];

export default function AIChatAssistant({ user }) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const email = useMemo(() => String(user?.email || "guest").trim(), [user]);

  const handleSubmit = async (event, promptOverride = "") => {
    event?.preventDefault?.();
    const cleanMessage = String(promptOverride || message || "").trim();
    if (!cleanMessage || loading) return;

    setLoading(true);
    setError("");
    setResult(null);

    const res = await queryAIEngine({
      message: cleanMessage,
      email,
      conversationHistory: [],
      studentContext: {
        name: user?.name || user?.firstName || user?.username || "",
        email,
        role: user?.role || "",
      },
    });
    setLoading(false);

    if (res?.error || res?.success === false) {
      console.error("[EduNova AI] Query failed:", res?.error || res?.reply);
      setError(
        "I'm having trouble connecting to my tutoring service right now. Please try again in a moment."
      );
      return;
    }

    const reply = String(res?.reply || res?.response || res?.data?.reply || "").trim();
    if (!reply || /^AI encountered an internal error/i.test(reply)) {
      setError(
        "I'm having trouble connecting to my tutoring service right now. Please try again in a moment."
      );
      return;
    }

    setResult({ ...res, reply });
    setMessage("");
  };

  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white/80 shadow-soft backdrop-blur-md dark:border-white/10 dark:bg-slate-950/60">
      <div className="border-b border-slate-200/80 bg-gradient-to-br from-white via-teal-50 to-slate-50 p-5 dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-teal-950/50">
        <div className="flex items-center gap-4">
          <EduNovaAIAvatar size={58} />
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-slate-950 dark:text-white">{ASSISTANT_NAME}</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{ASSISTANT_SUBTITLE}</p>
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-700 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200">
              <span className="edunova-ai-status-dot" aria-hidden="true" />
              Ready to help
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Ask EduNova AI</label>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Get help with lessons, revision, practice questions, and study planning.
            </p>
          </div>

          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={6}
            placeholder="Example: Explain photosynthesis in simple terms"
            className="w-full resize-none rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm leading-6 text-slate-900 shadow-inner transition placeholder:text-slate-400 focus:outline-none focus:ring-4 focus:ring-teal-400/15 dark:border-white/10 dark:bg-slate-900/80 dark:text-white dark:placeholder:text-slate-500"
          />

          <button
            type="submit"
            disabled={loading || !message.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-500 px-4 py-3 text-sm font-bold text-white shadow-[0_12px_24px_rgba(13,148,136,0.24)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_30px_rgba(13,148,136,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 disabled:translate-y-0 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none dark:disabled:from-slate-700 dark:disabled:to-slate-700 dark:disabled:text-slate-400"
          >
            {loading ? "Thinking..." : "Ask EduNova AI"}
          </button>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={(event) => handleSubmit(event, prompt)}
                disabled={loading}
                className="rounded-2xl border border-slate-200 bg-white/75 px-3 py-2.5 text-left text-xs font-semibold text-slate-600 transition hover:border-teal-200 hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.055] dark:text-slate-300 dark:hover:border-teal-300/30 dark:hover:text-teal-100"
              >
                {prompt}
              </button>
            ))}
          </div>
        </form>

        <div className="min-h-[20rem] rounded-[1.5rem] border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-slate-900/55">
          {!result && !error && !loading && (
            <div className="flex h-full min-h-[18rem] flex-col items-center justify-center text-center">
              <EduNovaAIAvatar size={62} decorative />
              <h3 className="mt-4 text-lg font-bold text-slate-900 dark:text-white">How can I help you today?</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
                Ask about your subjects, assignments, study materials, or exam preparation.
              </p>
            </div>
          )}

          {loading && (
            <div className="flex items-start gap-3">
              <EduNovaAIAvatar size={36} decorative />
              <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/[0.07]">
                <span className="edunova-ai-typing-dot" />
                <span className="edunova-ai-typing-dot [animation-delay:120ms]" />
                <span className="edunova-ai-typing-dot [animation-delay:240ms]" />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-100">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <EduNovaAIAvatar size={36} decorative />
                <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-slate-100">
                  <p className="whitespace-pre-wrap">{result.reply}</p>
                </div>
              </div>

              {(result.intent || result.task || typeof result.confidence === "number") && (
                <details className="rounded-2xl border border-slate-200 bg-white/70 p-3 text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.045] dark:text-slate-400">
                  <summary className="cursor-pointer font-semibold text-slate-600 dark:text-slate-300">Response details</summary>
                  <div className="mt-3 space-y-1">
                    {result.intent && <div>Intent: {result.intent}</div>}
                    {result.task && <div>Task: {result.task}</div>}
                    {typeof result.confidence === "number" && <div>Confidence: {result.confidence.toFixed(4)}</div>}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
