import React, { useCallback, useEffect, useRef, useState } from "react";
import { confirmAIAction, streamAIEngine } from "../api/api";
import EduNovaAIAvatar from "./EduNovaAIAvatar";

const ASSISTANT_NAME = "EduNova AI";
const ASSISTANT_SUBTITLE = "Your personal learning assistant";
const STATUS_LABEL = "Ready to help";

// ---- Constants & Configuration ----
export const BUTTON_SIZE = 72;
export const STORAGE_KEY = "eduNova_ai_position";
export const DRAG_THRESHOLD = 8;
const Z_INDEX_BUTTON = 50;
const Z_INDEX_CHAT = 49;
const CHAT_WIDTH = 400;
const CHAT_HEIGHT = 600;
const CHAT_GAP = 12;

const QUICK_PROMPTS = [
  {
    id: "today-classes",
    title: "What classes do I have today?",
    prompt: "What classes do I have today according to my timetable?",
    icon: BookOpenIcon,
  },
  {
    id: "study-recommendation",
    title: "What should I study today?",
    prompt: "What should I study today based on my weak topics and syllabus?",
    icon: SparkleIcon,
  },
  {
    id: "exam-study-plan",
    title: "Make me an exam study plan",
    prompt: "Make me a study plan for my upcoming exam based on my weak topics.",
    icon: ClipboardIcon,
  },
  {
    id: "quiz-analysis",
    title: "Analyze my last quiz",
    prompt: "Why did I perform badly in my last physics quiz?",
    icon: DocumentIcon,
  },
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewport() {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768 };
  }
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 1024,
    height: window.innerHeight || document.documentElement.clientHeight || 768,
  };
}

export function clampPosition(x, y, elWidth = BUTTON_SIZE, elHeight = BUTTON_SIZE) {
  const vp = getViewport();
  const maxX = Math.max(0, vp.width - elWidth);
  const maxY = Math.max(0, vp.height - elHeight);
  return {
    x: clamp(Number(x) || 0, 0, maxX),
    y: clamp(Number(y) || 0, maxY),
  };
}

function loadSavedPosition() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      isNaN(parsed.x) ||
      isNaN(parsed.y)
    ) {
      return null;
    }
    return clampPosition(parsed.x, parsed.y, BUTTON_SIZE, BUTTON_SIZE);
  } catch {
    return null;
  }
}

function savePosition(x, y) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // localStorage may be unavailable
  }
}

function getDefaultPosition() {
  const vp = getViewport();
  return {
    x: Math.max(0, vp.width - BUTTON_SIZE - 24),
    y: Math.max(0, vp.height - BUTTON_SIZE - 24),
  };
}

function makeMessageId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function extractAIReply(data) {
  const candidates = [data?.reply, data?.response, data?.message, data?.data?.reply];
  const reply = candidates.find((value) => typeof value === "string" && value.trim());
  return reply ? reply.trim() : "";
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

if (typeof window !== "undefined") {
  window.__eduNovaAI = {
    clampPosition,
    DRAG_THRESHOLD,
    STORAGE_KEY,
    "cursor:grab": "cursor:grab",
    "cursor:grabbing": "cursor:grabbing",
  };
}

export default function FloatingAIChat({ feature = "dashboard" }) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState(STATUS_LABEL);
  const [showInfo, setShowInfo] = useState(false);

  const [position, setPosition] = useState(() => {
    const saved = loadSavedPosition();
    return saved || getDefaultPosition();
  });
  const [isDragging, setIsDragging] = useState(false);

  const buttonRef = useRef(null);
  const chatRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const autoScrollRef = useRef(true);
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, buttonX: 0, buttonY: 0 });
  const isPointerDownRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const activePointerIdRef = useRef(null);
  const currentPosRef = useRef(position);
  const isOpenRef = useRef(isOpen);
  const rafRef = useRef(null);
  const conversationIdRef = useRef(null);

  currentPosRef.current = position;
  isOpenRef.current = isOpen;

  useEffect(() => {
    let timeoutId;
    function handleResize() {
      const current = currentPosRef.current;
      const clamped = clampPosition(current.x, current.y, BUTTON_SIZE, BUTTON_SIZE);
      if (clamped.x !== current.x || clamped.y !== current.y) {
        setPosition(clamped);
        savePosition(clamped.x, clamped.y);
      }
    }

    const debouncedResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(handleResize, 100);
    };

    window.addEventListener("resize", debouncedResize);
    return () => {
      window.removeEventListener("resize", debouncedResize);
      clearTimeout(timeoutId);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    });
  }, []);

  useEffect(() => {
    if (!isOpen || !autoScrollRef.current) return;
    scrollToBottom();
  }, [messages, loading, isOpen, scrollToBottom]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, [input]);

  useEffect(() => {
    if (!isOpen) setShowInfo(false);
  }, [isOpen]);

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
      setAgentStatus("Reasoning across sources...");

      try {
        const data = await streamAIEngine({
          message: userMessage,
          conversationId: conversationIdRef.current,
          applicationContext: { route: window.location.pathname, feature },
          onEvent: (event) => {
            if (event?.type === "status" && event?.message) {
              setAgentStatus(event.message);
            }
          },
        });

        if (data?.error || data?.success === false) {
          throw new Error(data?.error || data?.message || "EduNova AI request failed");
        }
        if (data?.conversationId) conversationIdRef.current = data.conversationId;

        const reply = extractAIReply(data);
        if (!reply || /^AI encountered an internal error/i.test(reply)) {
          throw new Error("AI response was empty, malformed, or internal-only");
        }

        setMessages((prev) => [
          ...prev,
          {
            id: makeMessageId("assistant"),
            role: "assistant",
            content: reply,
            sources: Array.isArray(data.sources) ? data.sources : [],
            internalSources: Array.isArray(data.internalSources) ? data.internalSources : [],
            actions: Array.isArray(data.actions) ? data.actions : [],
            usedWeb: Boolean(data.usedWeb),
            usedInternalDb: Boolean(data.usedInternalDb),
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
            content: error?.message || "Sorry, I couldn't reach EduNova AI right now.",
            retryMessage: userMessage,
          },
        ]);
      } finally {
        setLoading(false);
        setAgentStatus(STATUS_LABEL);
      }
    },
    [loading, feature]
  );


  const confirmAction = useCallback(async (messageId, index, token) => {
    try {
      const response = await confirmAIAction(token);
      setMessages((items) => items.map((item) => item.id !== messageId ? item : {
        ...item,
        actions: item.actions.map((action, actionIndex) => actionIndex === index
          ? { ...action, message: response?.data?.message || "Saved to EduNova", data: { ...action.data, pending: false, requiresConfirmation: false } }
          : action),
      }));
    } catch {
      setMessages((items) => [...items, { id: makeMessageId("action_err"), role: "assistant", type: "error", content: "That action could not be saved. It may have expired." }]);
    }
  }, []);

  const sendMessage = useCallback(() => {
    submitMessage(input);
  }, [input, submitMessage]);

  const handleRetry = useCallback(
    (message) => {
      if (!message?.retryMessage) return;
      submitMessage(message.retryMessage, { appendUser: false, errorToRemove: message.id });
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

  const handleConversationScroll = useCallback(() => {
    if (!scrollRef.current) return;
    autoScrollRef.current = isNearBottom(scrollRef.current);
  }, []);

  const toggleChat = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const closeChat = useCallback(() => {
    setIsOpen(false);
  }, []);

  const getChatPlacement = useCallback(() => {
    const vp = getViewport();
    const isMobile = vp.width < 640;
    const margin = isMobile ? 10 : 16;
    const chatW = Math.min(CHAT_WIDTH, Math.max(0, vp.width - margin * 2));
    const targetMobileHeight = Math.max(440, Math.round(vp.height * 0.84));
    const chatH = isMobile
      ? Math.min(targetMobileHeight, Math.max(0, vp.height - margin * 2))
      : Math.min(CHAT_HEIGHT, Math.max(0, vp.height - margin * 2));

    const btnX = position.x;
    const btnY = position.y;

    const spaceAbove = btnY - margin;
    const spaceBelow = vp.height - (btnY + BUTTON_SIZE) - margin;

    let top;
    if (spaceAbove >= chatH + CHAT_GAP) {
      top = btnY - chatH - CHAT_GAP;
    } else if (spaceBelow >= chatH + CHAT_GAP) {
      top = btnY + BUTTON_SIZE + CHAT_GAP;
    } else {
      top = spaceAbove >= spaceBelow ? btnY - chatH - CHAT_GAP : btnY + BUTTON_SIZE + CHAT_GAP;
    }

    let left;
    if (btnX > vp.width / 2) {
      left = btnX + BUTTON_SIZE - chatW;
    } else {
      left = btnX;
    }

    const leftMax = Math.max(margin, vp.width - chatW - margin);
    const topMax = Math.max(margin, vp.height - chatH - margin);

    return {
      left: clamp(left, margin, leftMax),
      top: clamp(top, margin, topMax),
      width: chatW,
      height: chatH,
    };
  }, [position]);

  const chatPlacement = getChatPlacement();

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;

    isPointerDownRef.current = true;
    hasDraggedRef.current = false;
    activePointerIdRef.current = event.pointerId;

    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      buttonX: currentPosRef.current.x,
      buttonY: currentPosRef.current.y,
    };

    if (buttonRef.current && typeof buttonRef.current.setPointerCapture === "function") {
      try {
        buttonRef.current.setPointerCapture(event.pointerId);
      } catch {}
    }
  }, []);

  const handlePointerMove = useCallback((event) => {
    if (!isPointerDownRef.current) return;

    const dx = event.clientX - dragStartRef.current.pointerX;
    const dy = event.clientY - dragStartRef.current.pointerY;
    const distance = Math.hypot(dx, dy);

    if (!hasDraggedRef.current && distance >= DRAG_THRESHOLD) {
      hasDraggedRef.current = true;
      setIsDragging(true);
      if (isOpenRef.current) {
        setIsOpen(false);
      }
    }

    if (hasDraggedRef.current) {
      const nextX = dragStartRef.current.buttonX + dx;
      const nextY = dragStartRef.current.buttonY + dy;
      const clamped = clampPosition(nextX, nextY, BUTTON_SIZE, BUTTON_SIZE);

      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setPosition(clamped);
      });
    }
  }, []);

  const handlePointerUp = useCallback(
    (event) => {
      if (!isPointerDownRef.current) return;
      isPointerDownRef.current = false;

      if (buttonRef.current && typeof buttonRef.current.releasePointerCapture === "function") {
        try {
          if (activePointerIdRef.current !== null) {
            buttonRef.current.releasePointerCapture(activePointerIdRef.current);
          }
        } catch {}
      }
      activePointerIdRef.current = null;

      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      if (hasDraggedRef.current) {
        setIsDragging(false);
        const finalPos = clampPosition(
          currentPosRef.current.x,
          currentPosRef.current.y,
          BUTTON_SIZE,
          BUTTON_SIZE
        );
        setPosition(finalPos);
        savePosition(finalPos.x, finalPos.y);
      } else {
        toggleChat();
      }

      hasDraggedRef.current = false;
    },
    [toggleChat]
  );

  const handleLauncherKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleChat();
      }
    },
    [toggleChat]
  );

  const buttonCursorClass = isDragging ? "cursor-grabbing cursor:grabbing" : "cursor-grab cursor:grab";
  const hasConversation = messages.length > 0;
  const canSend = Boolean(input.trim()) && !loading;

  const buttonStyle = {
    position: "fixed",
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${BUTTON_SIZE}px`,
    height: `${BUTTON_SIZE}px`,
    zIndex: Z_INDEX_BUTTON,
    touchAction: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
    cursor: isDragging ? "grabbing" : "grab",
  };

  const chatStyle = {
    position: "fixed",
    left: `${chatPlacement.left}px`,
    top: `${chatPlacement.top}px`,
    width: `${chatPlacement.width}px`,
    height: `${chatPlacement.height}px`,
    zIndex: Z_INDEX_CHAT,
  };

  return (
    <>
      <div
        id="eduNova-ai-chat"
        ref={chatRef}
        style={chatStyle}
        className={`edunova-ai-panel flex h-full flex-col overflow-hidden rounded-[1.65rem] border border-slate-200/80 bg-white/95 text-slate-900 shadow-[0_24px_80px_rgba(15,23,42,0.28)] backdrop-blur-xl transition-[opacity,transform] duration-200 dark:border-white/10 dark:bg-slate-950/95 dark:text-white dark:shadow-[0_28px_90px_rgba(0,0,0,0.55)] ${
          isOpen
            ? "translate-y-0 scale-100 opacity-100 pointer-events-auto"
            : "translate-y-2 scale-[0.97] opacity-0 pointer-events-none"
        }`}
        aria-hidden={!isOpen}
        role="dialog"
        aria-label="EduNova AI assistant chat"
      >
        <header className="relative shrink-0 border-b border-slate-200/80 bg-gradient-to-br from-white via-teal-50/85 to-slate-50 px-4 py-3 dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-teal-950/60">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <EduNovaAIAvatar size={48} decorative />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-bold tracking-tight text-slate-950 dark:text-white">
                    {ASSISTANT_NAME}
                  </h2>
                  <span className="hidden rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-700 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200 sm:inline-flex">
                    DATA-AWARE
                  </span>
                </div>
                <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-300">
                  {ASSISTANT_SUBTITLE}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-teal-700 dark:text-teal-200">
                  <span className="edunova-ai-status-dot" aria-hidden="true" />
                  <span>{loading ? agentStatus : STATUS_LABEL}</span>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowInfo((value) => !value)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-900/5 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label="About EduNova AI"
                aria-expanded={showInfo}
              >
                <InfoIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={closeChat}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-900/5 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label="Close EduNova AI assistant"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {showInfo && (
            <div className="absolute right-4 top-[4.25rem] z-10 w-[min(310px,calc(100%-2rem))] rounded-2xl border border-teal-100 bg-white/95 p-3 text-xs leading-relaxed text-slate-600 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-slate-900/95 dark:text-slate-300">
              EduNova AI is a unified data-aware assistant. It intelligently accesses your timetable, syllabus, quiz performance, and study progress from EduNova and supplements with verified web research.
            </div>
          )}
        </header>

        <section
          ref={scrollRef}
          onScroll={handleConversationScroll}
          className="edunova-ai-scroll min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(20,184,166,0.11),transparent_34%),linear-gradient(180deg,rgba(248,250,252,0.94),rgba(255,255,255,0.98))] px-4 py-4 dark:bg-[radial-gradient(circle_at_top,rgba(45,212,191,0.13),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))]"
          aria-live="polite"
        >
          {!hasConversation ? (
            <WelcomeState onPrompt={(prompt) => submitMessage(prompt)} loading={loading} />
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} onRetry={handleRetry} onConfirmAction={confirmAction} retryDisabled={loading} />
              ))}
              {loading && <TypingIndicator status={agentStatus} />}
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
              placeholder="Ask about timetable, quizzes, weak topics, study plans..."
              rows={1}
              className="max-h-[120px] min-h-[42px] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 dark:text-white dark:placeholder:text-slate-500"
              disabled={loading}
              aria-label="Message EduNova AI"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-500 text-white shadow-[0_10px_22px_rgba(13,148,136,0.28)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(13,148,136,0.34)] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:translate-y-0 disabled:translate-y-0 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none dark:focus-visible:ring-offset-slate-950 dark:disabled:from-slate-700 dark:disabled:to-slate-700 dark:disabled:text-slate-400"
              aria-label="Send message"
            >
              <SendIcon className="h-4.5 w-4.5" />
            </button>
          </div>
          <p className="mt-2 px-2 text-[11px] text-slate-400 dark:text-slate-500">
            Press Enter to send • Shift + Enter for a new line
          </p>
        </form>
      </div>

      <button
        ref={buttonRef}
        type="button"
        style={buttonStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleLauncherKeyDown}
        aria-label={isOpen ? "Close EduNova AI assistant" : "Open EduNova AI assistant"}
        aria-expanded={isOpen}
        aria-controls="eduNova-ai-chat"
        data-drag-threshold={DRAG_THRESHOLD}
        data-position-key={STORAGE_KEY}
        className={`group rounded-full border border-white/70 bg-gradient-to-br from-white via-teal-50 to-cyan-50 p-[6px] shadow-[0_14px_34px_rgba(15,23,42,0.25)] transition-transform duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-teal-950 dark:focus-visible:ring-offset-slate-950 ${buttonCursorClass} ${
          isDragging
            ? "scale-110 shadow-[0_18px_44px_rgba(15,23,42,0.5)]"
            : "hover:scale-105 hover:shadow-[0_18px_44px_rgba(13,148,136,0.32)] active:scale-95"
        }`}
      >
        <span className="pointer-events-none relative flex h-full w-full items-center justify-center rounded-full">
          <EduNovaAIAvatar size={58} decorative />
          <span className="absolute -right-0.5 -top-0.5 rounded-full border border-white/80 bg-white px-1.5 py-0.5 text-[9px] font-black tracking-[0.12em] text-teal-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-teal-200">
            AI
          </span>
          <span className="absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.16)] dark:border-slate-950" />
        </span>
      </button>
    </>
  );
}

function WelcomeState({ onPrompt, loading }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center py-4 text-center">
      <div className="relative mb-4">
        <span className="absolute inset-0 rounded-full bg-teal-400/20 blur-xl" aria-hidden="true" />
        <EduNovaAIAvatar size={64} className="relative" decorative />
      </div>
      <h3 className="text-lg font-bold text-slate-950 dark:text-white">EduNova AI</h3>
      <p className="mt-1 text-base font-semibold text-slate-800 dark:text-slate-100">Unified Data-Aware Assistant</p>
      <p className="mt-2 max-w-[18rem] text-sm leading-6 text-slate-500 dark:text-slate-400">
        Connected to your timetable, subjects, quiz scores, and verified research.
      </p>

      <div className="mt-5 grid w-full gap-2.5">
        {QUICK_PROMPTS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onPrompt(item.prompt)}
              disabled={loading}
              className="group flex w-full items-center gap-3 rounded-2xl border border-slate-200/90 bg-white/86 px-3 py-3 text-left text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-teal-200 hover:bg-white hover:text-teal-800 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.055] dark:text-slate-200 dark:hover:border-teal-300/30 dark:hover:bg-white/[0.085] dark:hover:text-teal-100"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 transition group-hover:bg-teal-100 dark:bg-teal-400/10 dark:text-teal-200 dark:group-hover:bg-teal-400/15">
                <Icon className="h-4.5 w-4.5" />
              </span>
              <span>{item.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatMessage({ message, onRetry, onConfirmAction, retryDisabled }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-gradient-to-br from-teal-500 to-cyan-500 px-4 py-3 text-sm leading-6 text-white shadow-[0_10px_24px_rgba(13,148,136,0.22)]">
          <RichMessage content={message.content} />
        </div>
      </div>
    );
  }

  const isError = message.type === "error";

  return (
    <div className="flex items-start gap-2.5">
      <EduNovaAIAvatar size={34} decorative />
      <div
        className={`max-w-[84%] rounded-2xl rounded-tl-md border px-4 py-3 text-sm leading-6 shadow-sm ${
          isError
            ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-100"
            : "border-slate-200/80 bg-white/92 text-slate-700 dark:border-white/10 dark:bg-white/[0.07] dark:text-slate-100"
        }`}
      >
        <RichMessage content={message.content} />

        {/* Internal DB Sources Badges */}
        {!isError && Array.isArray(message.internalSources) && message.internalSources.length > 0 && (
          <div className="mt-3 border-t border-slate-200/80 pt-2.5 dark:border-white/10">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-teal-600 dark:text-teal-300">
              EduNova Data Consulted
            </p>
            <div className="flex flex-wrap gap-1.5">
              {message.internalSources.map((src, i) => (
                <span
                  key={`msg-src-${i}`}
                  className="inline-flex items-center gap-1 rounded bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-200"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
                  {src.title || src.source}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Executed Actions Tags */}
        {!isError && Array.isArray(message.actions) && message.actions.length > 0 && (
          <div className="mt-2.5 border-t border-slate-200/80 pt-2 dark:border-white/10">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-300">
              Actions Saved
            </p>
            <div className="space-y-1">
              {message.actions.map((act, i) => (
                <div
                  key={`msg-act-${i}`}
                  className="rounded bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
                >
                  {act.data?.requiresConfirmation ? (
                    <button type="button" onClick={() => onConfirmAction(message.id, i, act.data.confirmationToken)} className="font-bold underline">
                      Confirm: {act.message || act.tool}
                    </button>
                  ) : `✓ ${act.message || act.tool}`}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* External Web Sources */}
        {!isError && Array.isArray(message.sources) && message.sources.length > 0 && (
          <div className="mt-3 border-t border-slate-200/80 pt-3 dark:border-white/10">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
              External Sources
            </p>
            <div className="space-y-1.5">
              {message.sources.slice(0, 5).map((source) => (
                <a
                  key={`${source.id}-${source.url}`}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-teal-700 transition hover:bg-teal-50 hover:text-teal-800 dark:bg-white/[0.05] dark:text-teal-200 dark:hover:bg-teal-400/10"
                  title={source.title || source.url}
                >
                  {source.id ? `${source.id} · ` : ""}{source.title || source.domain || source.url}
                </a>
              ))}
            </div>
          </div>
        )}

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
    </div>
  );
}

function TypingIndicator({ status }) {
  return (
    <div className="flex items-start gap-2.5" aria-label={status || "EduNova AI is working"}>
      <EduNovaAIAvatar size={34} decorative />
      <div className="rounded-2xl rounded-tl-md border border-slate-200/80 bg-white/92 px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/[0.07]">
        <div className="flex items-center gap-1.5">
          <span className="edunova-ai-typing-dot" />
          <span className="edunova-ai-typing-dot [animation-delay:120ms]" />
          <span className="edunova-ai-typing-dot [animation-delay:240ms]" />
        </div>
        <p className="mt-2 max-w-[14rem] text-xs font-medium text-slate-500 dark:text-slate-300">
          {status || "Working on your request..."}
        </p>
      </div>
    </div>
  );
}

function RichMessage({ content }) {
  const text = String(content || "").trim();
  if (!text) return null;

  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-2 break-words">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        const isList = lines.length > 1 && lines.every((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));

        if (isList) {
          return (
            <ul key={`block-${blockIndex}`} className="list-disc space-y-1 pl-4">
              {lines.map((line, lineIndex) => (
                <li key={`line-${lineIndex}`}>{renderInline(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={`block-${blockIndex}`}>
            {lines.map((line, lineIndex) => (
              <React.Fragment key={`line-${lineIndex}`}>
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

function renderInline(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      return <React.Fragment key={index}>{part}</React.Fragment>;
    });
}

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

function BookOpenIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 7v14" />
      <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22V5.5z" />
      <path d="M12 5.5A3.5 3.5 0 0 0 8.5 2H4v20" />
    </svg>
  );
}

function ClipboardIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 4h6" />
      <path d="M9 4a3 3 0 0 1 6 0" />
      <path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M8 12h8M8 16h5" />
    </svg>
  );
}

function SparkleIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 2l1.7 5.1L19 9l-5.3 1.9L12 16l-1.7-5.1L5 9l5.3-1.9L12 2z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
      <path d="M5 14l.7 1.8L7.5 16.5l-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7L5 14z" />
    </svg>
  );
}

function DocumentIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}
