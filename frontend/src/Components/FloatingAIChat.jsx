import React, { useEffect, useRef, useState } from "react";
import { queryAIEngine } from "../api/api";

function NovaAIIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="nova-ai-gradient" x1="7" y1="6" x2="42" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2dd4bf" /><stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="15" fill="url(#nova-ai-gradient)" />
      <path d="M15 29.5c2.2-7.2 6.2-11.7 12.1-13.6M18 18.2l6.4 2.1 3.7 6.6M16 31l8.2-4.1 7.5 2.3" fill="none" stroke="white" strokeLinecap="round" strokeWidth="1.5" opacity=".9" />
      <circle cx="15.2" cy="30.5" r="3" fill="#d1fae5" /><circle cx="18" cy="18" r="2.7" fill="#f0fdfa" /><circle cx="24.3" cy="20.2" r="3.2" fill="white" /><circle cx="27.9" cy="27.1" r="3.1" fill="#d1fae5" /><circle cx="35" cy="29.2" r="2.8" fill="white" />
      <path d="m35.2 9 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" fill="#fef3c7" />
    </svg>
  );
}

const QUICK_PROMPTS = ["Explain today's topic", "Help me study", "Summarize this", "Give me practice questions"];

export default function FloatingAIChat({ user }) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) window.setTimeout(() => inputRef.current?.focus(), 180);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [isOpen, messages, loading]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && isOpen) setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  const sendMessage = async (submittedMessage = input) => {
    const text = String(submittedMessage || "").trim();
    if (!text || loading) return;

    setMessages((previous) => [...previous, { id: `user-${Date.now()}`, role: "user", content: text }]);
    setInput("");
    setLoading(true);
    try {
      const data = await queryAIEngine({ message: text, email: user?.email || "" });
      if (data?.error || data?.success === false || !String(data?.reply || "").trim()) {
        const errorText = data?.error || "EduNova AI could not complete that request. Please try again shortly.";
        setMessages((previous) => [...previous, { id: `error-${Date.now()}`, role: "error", content: errorText }]);
      } else {
        setMessages((previous) => [...previous, { id: `ai-${Date.now()}`, role: "assistant", content: data.reply }]);
      }
    } catch {
      setMessages((previous) => [...previous, { id: `error-${Date.now()}`, role: "error", content: "EduNova AI is temporarily unavailable. Please try again shortly." }]);
    } finally {
      setLoading(false);
    }
  };

  const onInputKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="fixed bottom-24 right-4 z-[60] md:bottom-5 md:right-5">
      <div
        id="edunova-ai-chat"
        role="dialog"
        aria-modal="false"
        aria-labelledby="edunova-ai-title"
        className={`absolute bottom-[4.75rem] right-0 flex h-[min(620px,calc(100dvh-8.75rem))] w-[min(400px,calc(100vw-2rem))] origin-bottom-right flex-col overflow-hidden rounded-[24px] border border-white/60 bg-white/95 shadow-[0_25px_80px_rgba(2,6,23,0.28)] backdrop-blur-2xl transition duration-200 dark:border-white/10 dark:bg-slate-950/95 ${isOpen ? "pointer-events-auto translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-3 scale-95 opacity-0"}`}
        aria-hidden={!isOpen}
      >
        <header className="relative overflow-hidden border-b border-slate-100 bg-gradient-to-r from-teal-800 via-teal-700 to-cyan-700 px-4 py-4 text-white dark:border-white/10">
          <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <NovaAIIcon className="h-11 w-11 shrink-0 rounded-xl shadow-[0_10px_22px_rgba(0,0,0,.18)]" />
              <div className="min-w-0">
                <h2 id="edunova-ai-title" className="truncate text-sm font-bold">EduNova AI</h2>
                <p className="mt-0.5 truncate text-xs text-teal-50">Your learning assistant</p>
                <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-teal-100"><span className="h-1.5 w-1.5 rounded-full bg-teal-200 shadow-[0_0_8px_#99f6e4]" />Ready to help</span>
              </div>
            </div>
            <button type="button" onClick={() => setIsOpen(false)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-white transition hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label="Close EduNova AI chat">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
          {messages.length === 0 && !loading && (
            <div className="grid min-h-full place-items-center py-5 text-center">
              <div className="max-w-[290px]">
                <NovaAIIcon className="mx-auto h-14 w-14" />
                <p className="mt-4 text-sm font-bold text-slate-800 dark:text-white">Ask me anything about your studies.</p>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-300">I can help with the timetable and study planning available in EduNova.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => sendMessage(prompt)} className="rounded-full border border-teal-100 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-800 transition hover:-translate-y-0.5 hover:bg-teal-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200 dark:hover:bg-teal-400/15">
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {messages.map((message) => {
            if (message.role === "user") return <div key={message.id} className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-teal-700 to-teal-600 px-3.5 py-2.5 text-sm leading-5 text-white shadow-sm">{message.content}</div></div>;
            if (message.role === "error") return <div key={message.id} role="status" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm leading-5 text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200">{message.content}</div>;
            return <div key={message.id} className="flex items-start gap-2.5"><NovaAIIcon className="mt-0.5 h-8 w-8 shrink-0" /><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tl-md border border-slate-100 bg-slate-50 px-3.5 py-2.5 text-sm leading-5 text-slate-700 dark:border-white/10 dark:bg-white/7 dark:text-slate-100">{message.content}</div></div>;
          })}
          {loading && <div className="flex items-center gap-2.5"><NovaAIIcon className="h-8 w-8 shrink-0" /><div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-slate-100 bg-slate-50 px-3.5 py-3 dark:border-white/10 dark:bg-white/7"><span className="ai-dot" /><span className="ai-dot [animation-delay:120ms]" /><span className="ai-dot [animation-delay:240ms]" /><span className="sr-only">EduNova AI is thinking</span></div></div>}
        </div>

        <form onSubmit={(event) => { event.preventDefault(); sendMessage(); }} className="border-t border-slate-100 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-950/80">
          <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white px-2 py-1.5 transition focus-within:border-teal-500 focus-within:ring-4 focus-within:ring-teal-400/10 dark:border-white/10 dark:bg-white/5">
            <textarea ref={inputRef} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onInputKeyDown} disabled={loading} placeholder="Ask a study question…" aria-label="Message EduNova AI" className="max-h-24 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-5 text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed dark:text-white" />
            <button type="submit" disabled={loading || !input.trim()} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-teal-700 text-white transition hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500" aria-label="Send message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="m22 2-11 11" /></svg>
            </button>
          </div>
          <p className="mt-1.5 px-2 text-[10px] text-slate-400 dark:text-slate-500">Enter to send · Shift + Enter for a new line</p>
        </form>
      </div>

      <button type="button" onClick={() => setIsOpen((open) => !open)} className="ai-fab group relative grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-teal-600 via-teal-600 to-cyan-600 text-white shadow-[0_15px_30px_rgba(13,148,136,0.34)] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950" aria-label={isOpen ? "Close EduNova AI chat" : "Open EduNova AI chat"} aria-expanded={isOpen} aria-controls="edunova-ai-chat">
        <span className="absolute inset-0 rounded-2xl bg-teal-300/20 opacity-0 blur-lg transition group-hover:opacity-100" aria-hidden="true" />
        <NovaAIIcon className="relative h-10 w-10 rounded-xl" />
        {!isOpen && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-teal-300" aria-label="AI ready" />}
      </button>
    </div>
  );
}
