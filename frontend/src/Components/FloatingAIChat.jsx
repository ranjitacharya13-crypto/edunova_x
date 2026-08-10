import React, { useCallback, useEffect, useRef, useState } from "react";
import { queryAIEngine } from "../api/api";
import EduNovaAIAvatar from "./EduNovaAIAvatar";

// ===========================================================================
// EduNova AI — Premium floating tutor chat
// ---------------------------------------------------------------------------
// A polished, production-ready AI tutor interface:
//   * fixed launcher (right/bottom) + chat window above it
//   * glassmorphism + teal/cyan accents in both light and dark modes
//   * Socratic tutor flow driven by a tutoringContext sent to the backend
//   * dynamic quick-action suggestions returned by the tutor engine
//   * graceful, human-friendly error handling with a real "Try again" retry
// ===========================================================================

const ASSISTANT_NAME = "EduNova AI";
const ASSISTANT_SUBTITLE = "Your personal learning assistant";
const STATUS_LABEL = "Ready to help";

// Default first-conversation subject suggestions (tutor identity greeting).
const SUBJECT_SUGGESTIONS = [
  "Mathematics",
  "Science",
  "English",
  "Computer Science",
  "Social Science",
];

const EMPTY_TUTORING_CONTEXT = {
  subject: null,
  topic: null,
  goal: null,
  level: "beginner",
  mode: "learn",
  pending: null,
};

// ---- Helpers -------------------------------------------------------------

function makeMessageId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function extractAIReply(data) {
  const candidates = [
    data?.reply,
    data?.response,
    data?.message,
    data?.data?.reply,
  ];
  const reply = candidates.find(
    (value) => typeof value === "string" && value.trim()
  );
  return reply ? reply.trim() : "";
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

function cleanContext(context) {
  if (!context || typeof context !== "object") return EMPTY_TUTORING_CONTEXT;
  return {
    subject: context.subject || null,
    topic: context.topic || null,
    goal: context.goal || null,
    level: context.level || "beginner",
    mode: context.mode || "learn",
    pending: context.pending || null,
  };
}

function buildHistory(messages) {
  return messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.type !== "error" &&
        !m.transient
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

// ===========================================================================
// Main component
// ===========================================================================

export default function FloatingAIChat({ user }) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [tutoringContext, setTutoringContext] = useState(EMPTY_TUTORING_CONTEXT);

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const autoScrollRef = useRef(true);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const scrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")
        ?.matches;
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: reduce ? "auto" : "smooth",
      });
    });
  }, []);

  useEffect(() => {
    if (!isOpen || !autoScrollRef.current) return;
    scrollToBottom();
  }, [messages, loading, isOpen, scrollToBottom]);

  // Auto-size composer.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, [input]);

  useEffect(() => {
    if (!isOpen) setShowInfo(false);
  }, [isOpen]);

  const handleConversationScroll = useCallback(() => {
    if (!scrollRef.current) return;
    autoScrollRef.current = isNearBottom(scrollRef.current);
  }, []);

  const submitMessage = useCallback(
    async (messageText, options = {}) => {
      const { appendUser = true, errorToRemove = null } = options;
      const userMessage = String(messageText || "").trim();
      if (!userMessage || loading) return;

      autoScrollRef.current = true;
      if (errorToRemove) {
        setMessages((prev) => prev.filter((msg) => msg.id !== errorToRemove));
      }
      if (appendUser) {
        setMessages((prev) => [
          ...prev,
          { id: makeMessageId("user"), role: "user", content: userMessage },
        ]);
      }
      setInput("");
      setLoading(true);

      const history = buildHistory(messages).concat(
        appendUser
          ? [{ role: "user", content: userMessage }]
          : []
      );

      try {
        const data = await queryAIEngine({
          message: userMessage,
          email: user?.email || "guest",
          conversationHistory: history,
          studentContext: {
            name: user?.name || user?.firstName || user?.username || "",
            email: user?.email || "",
            role: user?.role || "",
          },
          tutoringContext,
        });

        if (data?.error || data?.success === false) {
          throw new Error(data?.error || data?.reply || "EduNova AI request failed");
        }

        const reply = extractAIReply(data);
        if (!reply || /^AI encountered an internal error/i.test(reply)) {
          throw new Error("AI response was empty, malformed, or internal-only");
        }

        if (data?.tutoringContext) {
          setTutoringContext(cleanContext(data.tutoringContext));
        }

        setMessages((prev) => [
          ...prev,
          {
            id: makeMessageId("assistant"),
            role: "assistant",
            content: reply,
            suggestions: Array.isArray(data?.suggestions)
              ? data.suggestions.slice(0, 6)
              : undefined,
          },
        ]);
      } catch (error) {
        console.error("[EduNova AI] Query failed:", error);
        setMessages((prev) => [
          ...prev,
          {
            id: makeMessageId("assistant_err"),
            role: "assistant",
            type: "error",
            content:
              "I'm having trouble connecting to my tutoring service right now. Please try again in a moment.",
            retryMessage: userMessage,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, user, tutoringContext]
  );

  const sendMessage = useCallback(() => {
    submitMessage(input);
  }, [input, submitMessage]);

  const handleRetry = useCallback(
    (message) => {
      if (!message?.retryMessage) return;
      submitMessage(message.retryMessage, {
        appendUser: false,
        errorToRemove: message.id,
      });
    },
    [submitMessage]
  );

  const onComposerKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const toggleChat = useCallback(() => setIsOpen((prev) => !prev), []);
  const closeChat = useCallback(() => setIsOpen(false), []);
  const handleLauncherKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleChat();
      }
    },
    [toggleChat]
  );

  const hasConversation = messages.length > 0;
  const canSend = Boolean(input.trim()) && !loading;

  return (
    <>
      {/* ===== Chat Window ===== */}
      <div
        id="eduNova-ai-chat"
        className={`edunova-ai-chat flex flex-col overflow-hidden rounded-[1.65rem] border border-slate-200/80 bg-white/95 text-slate-900 shadow-[0_24px_80px_rgba(15,23,42,0.28)] backdrop-blur-2xl transition-[opacity,transform] duration-200 ease-out dark:border-white/10 dark:bg-slate-950/95 dark:text-white dark:shadow-[0_28px_90px_rgba(0,0,0,0.55)] ${
          isOpen
            ? "translate-y-0 scale-100 opacity-100 pointer-events-auto"
            : "translate-y-3 scale-[0.98] opacity-0 pointer-events-none"
        }`}
        aria-hidden={!isOpen}
        role="dialog"
        aria-label="EduNova AI tutor chat"
        aria-live="polite"
      >
        <Header
          showInfo={showInfo}
          setShowInfo={setShowInfo}
          onClose={closeChat}
        />

        <section
          ref={scrollRef}
          onScroll={handleConversationScroll}
          className="edunova-ai-scroll min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(20,184,166,0.11),transparent_34%),linear-gradient(180deg,rgba(248,250,252,0.94),rgba(255,255,255,0.98))] px-4 py-4 dark:bg-[radial-gradient(circle_at_top,rgba(45,212,191,0.13),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))]"
        >
          {!hasConversation ? (
            <WelcomeState
              onPrompt={(prompt) => submitMessage(prompt)}
              loading={loading}
            />
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onRetry={handleRetry}
                  retryDisabled={loading}
                  onSuggestion={(prompt) => submitMessage(prompt)}
                />
              ))}
              {loading && <TypingIndicator />}
            </div>
          )}
        </section>

        <form
          className="shrink-0 border-t border-slate-200/80 bg-white/92 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-white/10 dark:bg-slate-950/94"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50/90 p-1.5 shadow-inner transition focus-within:border-teal-300 focus-within:bg-white focus-within:ring-4 focus-within:ring-teal-400/15 dark:border-white/10 dark:bg-slate-900/85 dark:focus-within:border-teal-300/50 dark:focus-within:bg-slate-900 dark:focus-within:ring-teal-300/10">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask EduNova AI anything..."
              rows={1}
              className="max-h-[120px] min-h-[42px] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 dark:text-white dark:placeholder:text-slate-500"
              disabled={loading}
              aria-label="Message EduNova AI"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-cyan-500 text-white shadow-[0_10px_22px_rgba(13,148,136,0.28)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(13,148,136,0.34)] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:translate-y-0 disabled:translate-y-0 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none dark:focus-visible:ring-offset-slate-950 dark:disabled:from-slate-700 dark:disabled:to-slate-700 dark:disabled:text-slate-400"
              aria-label="Send message"
            >
              <SendIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
          <p className="mt-2 px-2 text-[11px] text-slate-400 dark:text-slate-500">
            Press Enter to send • Shift + Enter for a new line
          </p>
        </form>
      </div>

      {/* ===== Launcher (fixed bottom-right) ===== */}
      <button
        type="button"
        onClick={toggleChat}
        onKeyDown={handleLauncherKeyDown}
        aria-label={isOpen ? "Close EduNova AI" : "Open EduNova AI"}
        aria-expanded={isOpen}
        aria-controls="eduNova-ai-chat"
        className="edunova-ai-launcher group flex items-center justify-center rounded-full border border-white/70 bg-gradient-to-br from-teal-500 via-teal-500 to-cyan-500 p-[5px] shadow-[0_16px_40px_rgba(13,148,136,0.4)] transition-transform duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 hover:scale-105 active:scale-95 dark:border-white/10 dark:from-teal-600 dark:via-teal-700 dark:to-cyan-700"
      >
        <span className="pointer-events-none relative flex h-full w-full items-center justify-center rounded-full">
          <EduNovaAIAvatar
            size={58}
            decorative
            className="!w-[72%] !h-[72%]"
          />
          <span className="absolute bottom-[3px] right-[3px] h-[10px] w-[10px] rounded-full border-2 border-white bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.25)] dark:border-slate-950" />
        </span>
      </button>
    </>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

function Header({ showInfo, setShowInfo, onClose }) {
  return (
    <header className="relative shrink-0 border-b border-slate-200/80 bg-gradient-to-br from-white via-teal-50/85 to-slate-50 px-[18px] py-4 dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-teal-950/60">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-12 w-12 min-h-[48px] min-w-[48px] shrink-0 items-center justify-center overflow-hidden rounded-full">
            <EduNovaAIAvatar size={48} decorative />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-bold leading-tight tracking-tight text-slate-950 dark:text-white">
                {ASSISTANT_NAME}
              </h2>
              <span className="hidden rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-700 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200 sm:inline-flex">
                AI
              </span>
            </div>
            <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-300">
              {ASSISTANT_SUBTITLE}
            </p>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-teal-700 dark:text-teal-200">
              <span className="edunova-ai-status-dot" aria-hidden="true" />
              <span>{STATUS_LABEL}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShowInfo((value) => !value)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-900/5 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="AI information"
            aria-expanded={showInfo}
          >
            <InfoIcon className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-900/5 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Close EduNova AI"
          >
            <CloseIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      {showInfo && (
        <div className="absolute right-[18px] top-[4.5rem] z-10 w-[min(300px,calc(100%-2rem))] rounded-2xl border border-teal-100 bg-white/95 p-3 text-xs leading-relaxed text-slate-600 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-slate-900/95 dark:text-slate-300">
          EduNova AI is your personal tutor. It teaches step by step, adapts to
          your level, helps with practice and exam prep, and revises topics with
          you — all in a calm, supportive way.
        </div>
      )}
    </header>
  );
}

function WelcomeState({ onPrompt, loading }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center py-4 text-center">
      <div className="relative mb-4">
        <span
          className="absolute inset-0 rounded-full bg-teal-400/20 blur-xl"
          aria-hidden="true"
        />
        <EduNovaAIAvatar size={64} className="relative" decorative />
      </div>
      <h3 className="text-lg font-bold text-slate-950 dark:text-white">
        {ASSISTANT_NAME}
      </h3>
      <p className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-100">
        Hi! I'm EduNova AI, your personal learning assistant. 👋
      </p>
      <p className="mt-2 max-w-[18rem] text-sm leading-6 text-slate-500 dark:text-slate-400">
        What are we studying today?
      </p>

      <div className="mt-5 flex w-full flex-wrap justify-center gap-2">
        {SUBJECT_SUGGESTIONS.map((subject) => (
          <button
            key={subject}
            type="button"
            onClick={() => onPrompt(subject)}
            disabled={loading}
            className="rounded-xl border border-slate-200/90 bg-white/86 px-3 py-2 text-[13px] font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-teal-200 hover:bg-white hover:text-teal-800 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.055] dark:text-slate-200 dark:hover:border-teal-300/30 dark:hover:bg-white/[0.085] dark:hover:text-teal-100"
          >
            {subject}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatMessage({ message, onRetry, retryDisabled, onSuggestion }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-tr-md bg-gradient-to-br from-teal-500 to-cyan-500 px-[15px] py-3 text-sm leading-[1.6] text-white shadow-[0_10px_24px_rgba(13,148,136,0.22)]">
          <RichMessage content={message.content} />
        </div>
      </div>
    );
  }

  const isError = message.type === "error";

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0 flex h-[34px] w-[34px] min-h-[34px] min-w-[34px] shrink-0 items-center justify-center overflow-hidden rounded-full">
        <EduNovaAIAvatar size={34} decorative />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`max-w-[82%] rounded-2xl rounded-tl-md border px-[15px] py-3 text-sm leading-[1.6] shadow-sm ${
            isError
              ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-100"
              : "border-slate-200/80 bg-white/92 text-slate-700 dark:border-white/10 dark:bg-white/[0.07] dark:text-slate-100"
          }`}
        >
          <RichMessage content={message.content} />
          {isError && (
            <button
              type="button"
              onClick={() => onRetry(message)}
              disabled={retryDisabled}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-100 dark:hover:bg-rose-400/15"
            >
              <RetryIcon className="h-3.5 w-3.5" />
              Try again
            </button>
          )}
        </div>

        {!isError && message.suggestions?.length > 0 && (
          <div className="mt-2.5 flex max-w-[92%] flex-wrap gap-2">
            {message.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSuggestion(suggestion)}
                disabled={retryDisabled}
                className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-[12px] font-semibold text-slate-600 shadow-sm transition hover:-translate-y-0.5 hover:border-teal-300 hover:bg-white hover:text-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.055] dark:text-slate-200 dark:hover:border-teal-300/30 dark:hover:bg-white/[0.085] dark:hover:text-teal-100"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div
      className="flex items-start gap-2.5"
      aria-label="EduNova AI is typing"
    >
      <div className="mt-0 flex h-[34px] w-[34px] min-h-[34px] min-w-[34px] shrink-0 items-center justify-center overflow-hidden rounded-full">
        <EduNovaAIAvatar size={34} decorative />
      </div>
      <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-md border border-slate-200/80 bg-white/92 px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/[0.07]">
        <span className="edunova-ai-typing-dot" />
        <span className="edunova-ai-typing-dot [animation-delay:120ms]" />
        <span className="edunova-ai-typing-dot [animation-delay:240ms]" />
      </div>
    </div>
  );
}

// ===========================================================================
// Rich text renderer (bold, headings, lists, code)
// ===========================================================================

function renderInline(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={index} className="font-bold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={index}
            className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-teal-700 dark:bg-white/10 dark:text-teal-200"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={index}>{part}</React.Fragment>;
    });
}

function RichMessage({ content }) {
  const text = String(content || "").trim();
  if (!text) return null;

  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-2 break-words text-left [overflow-wrap:anywhere]">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        const heading = lines.find((l) => l.trim().startsWith("### "));

        if (heading) {
          const rest = lines.filter((l) => !l.trim().startsWith("### "));
          return (
            <div key={`h-${blockIndex}`}>
              <h4 className="mb-1 text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
                {renderInline(heading.replace(/^###\s+/, ""))}
              </h4>
              {rest.length > 0 && (
                <div className="space-y-2">
                  {rest.map((line, li) => (
                    <p key={li}>{renderInline(line)}</p>
                  ))}
                </div>
              )}
            </div>
          );
        }

        const isList =
          lines.length > 1 &&
          lines.every((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));

        if (isList) {
          return (
            <ul
              key={`l-${blockIndex}`}
              className="list-disc space-y-1 pl-4"
            >
              {lines.map((line, lineIndex) => (
                <li key={`li-${lineIndex}`}>
                  {renderInline(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={`p-${blockIndex}`}>
            {lines.map((line, lineIndex) => (
              <React.Fragment key={`ln-${lineIndex}`}>
                {renderInline(line)}
                {lineIndex < lines.length - 1 && <br />}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Icons
// ===========================================================================

function CloseIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function SendIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function InfoIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function RetryIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}
