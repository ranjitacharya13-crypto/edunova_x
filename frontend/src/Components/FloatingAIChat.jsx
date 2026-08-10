import React, { useCallback, useEffect, useRef, useState } from "react";
import { queryAIEngine } from "../api/api";

// ─────────────────────────────────────────────────────────────────────────────
// EduNova AI — Floating Assistant
// ─────────────────────────────────────────────────────────────────────────────
// Modern, professional floating AI chat for the EduNova_X education platform.
// Uses inline SVGs (no external images), respects dark mode, and works on both
// desktop and mobile viewports.
// ─────────────────────────────────────────────────────────────────────────────

const QUICK_PROMPTS = [
  "Explain today's topic",
  "Help me study for exams",
  "Summarize my syllabus",
  "Give me practice questions",
];

// ── SVG Icons (inline, no external deps) ──────────────────────────────────

function AIIcon({ className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Central brain/neural node */}
      <circle cx="12" cy="12" r="3.5" fill="currentColor" opacity="0.9" />
      {/* Orbital connections */}
      <circle cx="12" cy="4.5" r="1.5" fill="currentColor" opacity="0.7" />
      <circle cx="18.5" cy="8" r="1.5" fill="currentColor" opacity="0.7" />
      <circle cx="18.5" cy="16" r="1.5" fill="currentColor" opacity="0.7" />
      <circle cx="12" cy="19.5" r="1.5" fill="currentColor" opacity="0.7" />
      <circle cx="5.5" cy="16" r="1.5" fill="currentColor" opacity="0.7" />
      <circle cx="5.5" cy="8" r="1.5" fill="currentColor" opacity="0.7" />
      {/* Neural connection lines */}
      <line x1="12" y1="8.5" x2="12" y2="6" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <line x1="15" y1="10.5" x2="17" y2="8.8" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <line x1="15" y1="13.5" x2="17" y2="15.2" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <line x1="12" y1="15.5" x2="12" y2="18" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <line x1="9" y1="13.5" x2="7" y2="15.2" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <line x1="9" y1="10.5" x2="7" y2="8.8" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      {/* Sparkle accent */}
      <path
        d="M19.5 3.5L20 5L21.5 5.5L20 6L19.5 7.5L19 6L17.5 5.5L19 5Z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}

function SendIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 12L3 20L12 16L21 20L19 12M5 12L12 4L19 12M5 12H19"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="currentColor"
        opacity="0.1"
      />
      <path
        d="M22 2L11 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 2L15 22L11 13L2 9L22 2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M18 6L6 18M6 6L18 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MinimizeIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 12H19"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Typing Indicator ──────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2.5 animate-fadeIn">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center flex-shrink-0">
        <AIIcon className="w-4 h-4 text-primary" />
      </div>
      <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border border-slate-200/60 dark:border-slate-700/60 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounceDot1" />
          <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounceDot2" />
          <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounceDot3" />
        </div>
      </div>
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────────────────

function MessageBubble({ message }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end animate-fadeIn">
        <div className="max-w-[82%] bg-gradient-to-br from-primary to-primary/90 text-white px-4 py-2.5 rounded-2xl rounded-tr-md shadow-sm text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 animate-fadeIn">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <AIIcon className="w-4 h-4 text-primary" />
      </div>
      <div className="max-w-[82%] bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border border-slate-200/60 dark:border-slate-700/60 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm text-sm leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────

function EmptyState({ onPromptClick }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-4">
        <AIIcon className="w-8 h-8 text-primary" />
      </div>
      <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100 mb-1">
        EduNova AI
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-6 max-w-[260px]">
        Ask me anything about your studies. I'm here to help you learn.
      </p>
      <div className="w-full space-y-2">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPromptClick(prompt)}
            className="w-full text-left text-sm px-4 py-2.5 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-slate-200/50 dark:border-slate-700/50 text-slate-700 dark:text-slate-300 hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-all duration-200"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Error Banner ──────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="mx-3 mb-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200/60 dark:border-red-800/40 text-red-700 dark:text-red-300 text-xs flex items-center justify-between gap-2 animate-fadeIn">
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-red-400 hover:text-red-600 dark:hover:text-red-200 flex-shrink-0"
        aria-label="Dismiss error"
      >
        <CloseIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export default function FloatingAIChat({ user }) {
  const displayName = String(user?.name || "Student").trim() || "Student";
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  const sendMessage = useCallback(
    async (text) => {
      const userMessage = String(text || input || "").trim();
      if (!userMessage || loading) return;

      setError("");
      setMessages((prev) => [
        ...prev,
        { id: `user_${Date.now()}`, role: "user", content: userMessage },
      ]);
      setInput("");
      setLoading(true);

      try {
        const data = await queryAIEngine({
          message: userMessage,
          email: user?.email || "guest@edunova.com",
        });

        if (data?.error) {
          setError(
            data.error === "AI service is not configured. Set AI_ENGINE_URL on the API service to the public URL of the deployed FastAPI AI engine."
              ? "EduNova AI is being set up. Please try again shortly."
              : data.error
          );
          // Still add an error message in chat
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant_err_${Date.now()}`,
              role: "assistant",
              content:
                "I'm sorry, I'm having trouble connecting right now. Please try again in a moment.",
              isError: true,
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              role: "assistant",
              content: data?.reply || data?.response || "I processed your request but have no response to show.",
            },
          ]);
        }
      } catch {
        setError("EduNova AI is temporarily unavailable. Please try again.");
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant_err_${Date.now()}`,
            role: "assistant",
            content:
              "I'm sorry, I'm unable to reach the AI service right now. Please try again shortly.",
            isError: true,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, user]
  );

  const onKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const handlePromptClick = (prompt) => {
    setInput(prompt);
    sendMessage(prompt);
  };

  const isEmpty = messages.length === 0;

  return (
    <>
      {/* ── CSS Animations ────────────────────────────────────────────── */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes bounceDot1 {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }
        @keyframes bounceDot2 {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }
        @keyframes bounceDot3 {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }
        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 4px 20px rgba(46,196,182,0.3), 0 0 0 0 rgba(46,196,182,0.15); }
          50% { box-shadow: 0 4px 24px rgba(46,196,182,0.45), 0 0 0 8px rgba(46,196,182,0); }
        }
        .animate-float { animation: float 3s ease-in-out infinite; }
        .animate-fadeIn { animation: fadeIn 0.3s ease-out; }
        .animate-slideUp { animation: slideUp 0.35s cubic-bezier(0.16,1,0.3,1); }
        .animate-bounceDot1 { animation: bounceDot1 1.2s ease-in-out infinite; }
        .animate-bounceDot2 { animation: bounceDot2 1.2s ease-in-out 0.15s infinite; }
        .animate-bounceDot3 { animation: bounceDot3 1.2s ease-in-out 0.3s infinite; }
        .animate-pulseGlow { animation: pulseGlow 3s ease-in-out infinite; }
        .edunova-chat-panel {
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
        }
      `}</style>

      {/* ── Floating Action Button ──────────────────────────────────── */}
      <div className="fixed bottom-5 right-5 z-[9998] md:bottom-6 md:right-6">
        {!isOpen && (
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className={`
              group relative w-14 h-14 md:w-16 md:h-16 rounded-full
              bg-gradient-to-br from-primary to-teal-600
              text-white shadow-lg
              hover:shadow-xl hover:scale-105
              active:scale-95
              transition-all duration-300 ease-out
              focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/40
              animate-pulseGlow
            `}
            aria-label="Open EduNova AI assistant"
          >
            <span className="flex items-center justify-center w-full h-full animate-float">
              <AIIcon className="w-7 h-7 md:w-8 md:h-8" />
            </span>
            {/* Notification dot */}
            {isEmpty && (
              <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 bg-secondary rounded-full border-2 border-white dark:border-slate-900 animate-fadeIn" />
            )}
          </button>
        )}

        {/* ── Chat Panel ──────────────────────────────────────────── */}
        {isOpen && (
          <div
            className="
              edunova-chat-panel
              fixed bottom-0 right-0 left-0
              md:bottom-20 md:right-0 md:left-auto
              w-full md:w-[400px]
              h-[85dvh] md:h-[580px]
              bg-white/95 dark:bg-slate-900/95
              md:rounded-2xl
              border-0 md:border border-slate-200/60 dark:border-slate-700/60
              shadow-2xl
              flex flex-col
              animate-slideUp
              overflow-hidden
            "
            role="dialog"
            aria-label="EduNova AI chat"
            aria-modal="false"
          >
            {/* ── Header ────────────────────────────────────────── */}
            <div className="flex-shrink-0 h-16 px-4 flex items-center justify-between border-b border-slate-200/60 dark:border-slate-700/60 bg-white/80 dark:bg-slate-900/80">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative w-10 h-10 rounded-full bg-gradient-to-br from-primary/20 to-teal-100 dark:from-primary/20 dark:to-slate-800 flex items-center justify-center flex-shrink-0">
                  <AIIcon className="w-5 h-5 text-primary" />
                  {/* Online indicator */}
                  <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-400 rounded-full border-2 border-white dark:border-slate-900" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                    EduNova AI
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    Your learning assistant
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="
                  w-8 h-8 rounded-lg
                  flex items-center justify-center
                  text-slate-400 hover:text-slate-600 dark:hover:text-slate-200
                  hover:bg-slate-100 dark:hover:bg-slate-800
                  transition-colors duration-200
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                "
                aria-label="Close chat"
              >
                <MinimizeIcon className="w-5 h-5 md:hidden" />
                <CloseIcon className="w-5 h-5 hidden md:block" />
              </button>
            </div>

            {/* ── Messages Area ─────────────────────────────────── */}
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3 scroll-smooth"
            >
              {isEmpty && !loading ? (
                <EmptyState onPromptClick={handlePromptClick} />
              ) : (
                <>
                  {/* Welcome message when chat has started */}
                  {messages.length > 0 && messages[0]?.role !== "assistant" && (
                    <div className="flex items-start gap-2.5 animate-fadeIn">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <AIIcon className="w-4 h-4 text-primary" />
                      </div>
                      <div className="max-w-[82%] bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border border-slate-200/60 dark:border-slate-700/60 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm text-sm leading-relaxed text-slate-800 dark:text-slate-200">
                        Hi {displayName}! 👋 I'm EduNova AI, your learning assistant. How can I help you today?
                      </div>
                    </div>
                  )}

                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                  ))}

                  {loading && <TypingIndicator />}
                </>
              )}
            </div>

            {/* ── Error Banner ──────────────────────────────────── */}
            <ErrorBanner message={error} onDismiss={() => setError("")} />

            {/* ── Input Area ────────────────────────────────────── */}
            <div className="flex-shrink-0 border-t border-slate-200/60 dark:border-slate-700/60 bg-white/80 dark:bg-slate-900/80 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="flex items-end gap-2">
                <div className="flex-1 relative">
                  <label htmlFor="edunova-ai-input" className="sr-only">
                    Type your message to EduNova AI
                  </label>
                  <textarea
                    ref={inputRef}
                    id="edunova-ai-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Ask me anything..."
                    rows={1}
                    disabled={loading}
                    className="
                      w-full resize-none
                      rounded-xl
                      bg-slate-100/80 dark:bg-slate-800/80
                      text-slate-800 dark:text-slate-200
                      placeholder:text-slate-400 dark:placeholder:text-slate-500
                      px-4 py-2.5 pr-12
                      text-sm
                      border border-slate-200/60 dark:border-slate-700/60
                      focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40
                      transition-all duration-200
                      disabled:opacity-60
                      max-h-24
                      overflow-y-auto
                    "
                    style={{ minHeight: "40px" }}
                    aria-label="Message input for EduNova AI"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => sendMessage()}
                  disabled={loading || !input.trim()}
                  className="
                    flex-shrink-0
                    w-10 h-10 rounded-xl
                    bg-gradient-to-br from-primary to-teal-600
                    text-white
                    flex items-center justify-center
                    hover:shadow-md hover:scale-105
                    active:scale-95
                    transition-all duration-200
                    disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none
                    focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/40
                  "
                  aria-label="Send message"
                >
                  <SendIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
