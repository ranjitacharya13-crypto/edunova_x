import React, { useEffect, useRef, useState } from "react";
import { confirmAIAction, streamAIEngine } from "../api/api";
import EduNovaAIAvatar from "./EduNovaAIAvatar";
import useAIStatus from "../hooks/useAIStatus";
import AIAction from "./AIAction";

const ASSISTANT_NAME = "EduNova AI";
const ASSISTANT_SUBTITLE = "Unified Data-Aware Learning & Academic Assistant";
const PANEL_SESSION_KEY = "eduNova_ai_panel_v1";

const QUICK_PROMPTS = [
  "What classes do I have today?",
  "What should I study today?",
  "Analyze my last quiz.",
  "Create a 5-day exam study plan.",
];

function panelStorageKey(feature) {
  if (typeof window === "undefined") return `${PANEL_SESSION_KEY}:${feature}`;
  try {
    const token = localStorage.getItem("token") || "";
    const suffix = token ? token.slice(-16) : "anon";
    return `${PANEL_SESSION_KEY}:${feature}:${suffix}`;
  } catch {
    return `${PANEL_SESSION_KEY}:${feature}`;
  }
}

function loadPanelSession(feature) {
  if (typeof window === "undefined") return { history: [], conversationId: null };
  try {
    const raw = sessionStorage.getItem(panelStorageKey(feature));
    if (!raw) return { history: [], conversationId: null };
    const parsed = JSON.parse(raw);
    return {
      history: Array.isArray(parsed?.history) ? parsed.history.slice(-20) : [],
      conversationId: typeof parsed?.conversationId === "string" ? parsed.conversationId : null,
    };
  } catch {
    return { history: [], conversationId: null };
  }
}

function savePanelSession(feature, history, conversationId) {
  if (typeof window === "undefined") return;
  try {
    const key = panelStorageKey(feature);
    if (!history || history.length === 0) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(
      key,
      JSON.stringify({
        history: history.slice(-20),
        conversationId: conversationId || null,
      })
    );
  } catch {
    // sessionStorage may be unavailable
  }
}

export default function AIChatAssistant({ feature = "ai", initialPrompt = "", applicationContext = {} }) {
  const initialSession = useRef(null);
  if (!initialSession.current) {
    initialSession.current = loadPanelSession(feature);
  }
  const [message, setMessage] = useState(initialPrompt);
  const abortRef = useRef(null);
  const submittingRef = useRef(false);
  useEffect(() => {
    if (initialPrompt) setMessage(initialPrompt);
  }, [initialPrompt]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const [loading, setLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState(() => initialSession.current.history);
  const conversationIdRef = useRef(initialSession.current.conversationId);
  const scrollContainerRef = useRef(null);
  const modelStatus = useAIStatus();

  useEffect(() => {
    savePanelSession(feature, history, conversationIdRef.current);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [feature, history]);

  const handleSubmit = async (event, promptOverride = "") => {
    event?.preventDefault?.();
    const cleanMessage = String(promptOverride || message || "").trim();
    if (!cleanMessage || loading || submittingRef.current) return;

    submittingRef.current = true;
    setLoading(true);
    setAgentStatus("Thinking...");
    setStreamingText("");
    setError("");
    if (!promptOverride) setMessage("");

    const turnId = `turn_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    try {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await streamAIEngine({
        signal: controller.signal,
        message: cleanMessage,
        conversationId: conversationIdRef.current,
        applicationContext: { route: window.location.pathname, feature, context: applicationContext },
        onEvent: (eventData) => {
          if (eventData?.type === "token") {
            setStreamingText(eventData.text || "");
            setAgentStatus("Generating...");
          } else if (eventData?.type === "status" && eventData?.message) {
            setAgentStatus(eventData.message);
          }
        },
      });
      if (res?.conversationId) conversationIdRef.current = res.conversationId;
      if (res?.error || res?.success === false) {
        throw new Error(res?.error || res?.message || "EduNova AI request failed");
      }

      const reply = String(res?.reply || res?.message || res?.response || "").trim();
      if (!reply || /^AI encountered an internal error/i.test(reply)) {
        throw new Error("EduNova AI returned an empty response");
      }
      setHistory((prev) => [
        ...prev,
        {
          id: turnId,
          prompt: cleanMessage,
          reply,
          sources: Array.isArray(res?.sources) ? res.sources : [],
          internalSources: Array.isArray(res?.internalSources) ? res.internalSources : [],
          actions: Array.isArray(res?.actions) ? res.actions : [],
          intent: res?.intent || null,
          task: res?.task || null,
          confidence: typeof res?.confidence === "number" ? res.confidence : null,
        },
      ]);
      if (promptOverride) setMessage("");
    } catch (requestError) {
      if (requestError?.name === "AbortError") return;
      console.error("[EduNova AI] Query failed:", requestError);
      setError(requestError?.message || "Sorry, I couldn't reach EduNova AI right now.");
    } finally {
      submittingRef.current = false;
      setLoading(false);
      setAgentStatus("");
      setStreamingText("");
      modelStatus.refresh();
    }
  };

  const handleTextareaKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
    }
  };

  const clearHistory = () => {
    abortRef.current?.abort();
    submittingRef.current = false;
    conversationIdRef.current = null;
    setHistory([]);
    setError("");
    setStreamingText("");
    setAgentStatus("");
    setLoading(false);
    savePanelSession(feature, [], null);
  };

  const confirmAction = async (turnId, index, token) => {
    try {
      const response = await confirmAIAction(token);
      setHistory((items) =>
        items.map((entry) =>
          entry.id !== turnId
            ? entry
            : {
                ...entry,
                actions: entry.actions.map((action, actionIndex) =>
                  actionIndex === index
                    ? {
                        ...action,
                        message: response?.data?.message || "Saved to EduNova",
                        data: { ...response.data, pending: false, requiresConfirmation: false },
                      }
                    : action
                ),
              }
        )
      );
    } catch {
      setError("That action could not be saved. It may have expired.");
    }
  };

  const latestTurn = history.length > 0 ? history[history.length - 1] : null;

  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white/80 shadow-soft backdrop-blur-md dark:border-white/10 dark:bg-slate-950/60">
      <div className="border-b border-slate-200/80 bg-gradient-to-br from-white via-teal-50 to-slate-50 p-5 dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-teal-950/50">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <EduNovaAIAvatar size={58} />
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-tight text-slate-950 dark:text-white">{ASSISTANT_NAME}</h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{ASSISTANT_SUBTITLE}</p>
              <div
                className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
                  modelStatus.isUnavailable
                    ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200"
                    : modelStatus.isReady
                      ? "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200"
                      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200"
                }`}
                aria-live="polite"
                title={modelStatus.detail || modelStatus.label}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    modelStatus.isUnavailable
                      ? "bg-rose-500"
                      : modelStatus.isReady
                        ? "bg-emerald-500"
                        : "bg-amber-400"
                  }`}
                  aria-hidden="true"
                />
                {loading && agentStatus ? agentStatus : modelStatus.label}
              </div>
            </div>
          </div>

          {history.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              disabled={loading}
              className="shrink-0 rounded-full border border-slate-200 bg-white/85 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-teal-200 hover:text-teal-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-300 dark:hover:text-white"
            >
              Clear chat
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Ask EduNova AI</label>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {modelStatus.connectionSummary}
            </p>
          </div>

          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleTextareaKeyDown}
            rows={6}
            placeholder="Example: What classes do I have today and what weak topics should I revise?"
            className="w-full resize-none rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm leading-6 text-slate-900 shadow-inner transition placeholder:text-slate-400 focus:outline-none focus:ring-4 focus:ring-teal-400/15 dark:border-white/10 dark:bg-slate-900/80 dark:text-white dark:placeholder:text-slate-500"
          />

          <button
            type="submit"
            disabled={loading || !message.trim() || modelStatus.isUnavailable}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-500 px-4 py-3 text-sm font-bold text-white shadow-[0_12px_24px_rgba(13,148,136,0.24)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_30px_rgba(13,148,136,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 disabled:translate-y-0 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none dark:disabled:from-slate-700 dark:disabled:to-slate-700 dark:disabled:text-slate-400"
          >
            {loading
              ? "Reasoning across sources..."
              : modelStatus.isStarting
                ? "Ask EduNova AI (model still starting)"
                : "Ask EduNova AI"}
          </button>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={(event) => handleSubmit(event, prompt)}
                disabled={loading || modelStatus.isUnavailable}
                className="rounded-2xl border border-slate-200 bg-white/75 px-3 py-2.5 text-left text-xs font-semibold text-slate-600 transition hover:border-teal-200 hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.055] dark:text-slate-300 dark:hover:border-teal-300/30 dark:hover:text-teal-100"
              >
                {prompt}
              </button>
            ))}
          </div>
        </form>

        <div
          ref={scrollContainerRef}
          className="max-h-[34rem] min-h-[20rem] space-y-4 overflow-y-auto rounded-[1.5rem] border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-slate-900/55"
        >
          {history.length === 0 && !error && !loading && (
            <div className="flex h-full min-h-[18rem] flex-col items-center justify-center text-center">
              <EduNovaAIAvatar size={62} decorative />
              <h3 className="mt-4 text-lg font-bold text-slate-900 dark:text-white">How can I help you today?</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
                {modelStatus.connectionSummary}
              </p>
            </div>
          )}

          {history.map((entry) => (
            <div key={entry.id} className="space-y-3">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-teal-500 to-cyan-500 px-4 py-2.5 text-sm leading-6 text-white shadow-sm">
                  {entry.prompt}
                </div>
              </div>

              <div className="flex items-start gap-3">
                <EduNovaAIAvatar size={36} decorative />
                <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-slate-100">
                  <p className="whitespace-pre-wrap break-words">{entry.reply}</p>

                  {Array.isArray(entry.internalSources) && entry.internalSources.length > 0 && (
                    <div className="mt-4 border-t border-slate-200 pt-3 dark:border-white/10">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-teal-600 dark:text-teal-300">
                        EduNova Data Consulted
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {entry.internalSources.map((src, i) => (
                          <span
                            key={`int-src-${entry.id}-${i}`}
                            className="inline-flex items-center gap-1 rounded-md bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-200"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
                            {src.title || src.source}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {Array.isArray(entry.actions) && entry.actions.length > 0 && (
                    <div className="mt-3 border-t border-slate-200 pt-3 dark:border-white/10">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-300">
                        Application actions
                      </p>
                      <div className="space-y-1">
                        {entry.actions.map((act, i) => (
                          <div
                            key={`act-${entry.id}-${i}`}
                            className="rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
                          >
                            <AIAction action={act} onConfirm={(token) => confirmAction(entry.id, i, token)} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {Array.isArray(entry.sources) && entry.sources.length > 0 && (
                    <div className="mt-3 border-t border-slate-200 pt-3 dark:border-white/10">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                        External Verified Sources
                      </p>
                      <div className="space-y-1.5">
                        {entry.sources.slice(0, 6).map((source) => (
                          <a
                            key={`${source.id}-${source.url}`}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="block truncate rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-50 dark:bg-white/[0.05] dark:text-teal-200"
                          >
                            {source.id ? `${source.id} · ` : ""}
                            {source.title || source.domain || source.url}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-start gap-3">
              <EduNovaAIAvatar size={36} decorative />
              <div className="max-w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/[0.07]">
                {streamingText ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-100">{streamingText}</p>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="edunova-ai-typing-dot" />
                    <span className="edunova-ai-typing-dot [animation-delay:120ms]" />
                    <span className="edunova-ai-typing-dot [animation-delay:240ms]" />
                  </div>
                )}
                <p className="mt-2 text-xs font-medium text-slate-500 dark:text-slate-300">{agentStatus || "Generating..."}</p>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-100">
              {error}
            </div>
          )}

          {latestTurn && (latestTurn.intent || latestTurn.task || typeof latestTurn.confidence === "number") && (
            <details className="rounded-2xl border border-slate-200 bg-white/70 p-3 text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.045] dark:text-slate-400">
              <summary className="cursor-pointer font-semibold text-slate-600 dark:text-slate-300">Response details</summary>
              <div className="mt-3 space-y-1">
                {latestTurn.intent && <div>Intent: {latestTurn.intent}</div>}
                {latestTurn.task && <div>Task: {latestTurn.task}</div>}
                {typeof latestTurn.confidence === "number" && <div>Confidence: {latestTurn.confidence.toFixed(4)}</div>}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
