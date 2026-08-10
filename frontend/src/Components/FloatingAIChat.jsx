import React, { useEffect, useRef, useState, useCallback } from "react";
import { queryAIEngine } from "../api/api";

const AVATAR_SRC = "/edu-assistance-snn.svg";
const AVATAR_FALLBACK = "https://ui-avatars.com/api/?name=SNN&background=0F766E&color=fff";
const ASSISTANT_NAME = "edu_assistance";
const ASSISTANT_KIND = "ASI: Artificial Superintelligence";
const SNN_LABEL = "SNN: Spiking Neural Network";

// ---- Constants & Configuration ----
export const BUTTON_SIZE = 72; // matches w-[72px] h-[72px]
export const STORAGE_KEY = "eduNova_ai_position";
export const DRAG_THRESHOLD = 8; // px – movement beyond this counts as drag, not click
const Z_INDEX_BUTTON = 50;
const Z_INDEX_CHAT = 49;
const CHAT_WIDTH = 380;
const CHAT_HEIGHT = 520;
const CHAT_GAP = 12;

// ---- Viewport and Clamping Helpers ----
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
    // Validate against current viewport and return clamped position
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
    // localStorage may be unavailable (private browsing, quota exceeded, etc.)
  }
}

function getDefaultPosition() {
  const vp = getViewport();
  return {
    x: Math.max(0, vp.width - BUTTON_SIZE - 24),
    y: Math.max(0, vp.height - BUTTON_SIZE - 24),
  };
}

// Preserve configuration and helpers for testing / bundle inspection
if (typeof window !== "undefined") {
  window.__eduNovaAI = {
    clampPosition,
    DRAG_THRESHOLD,
    STORAGE_KEY,
    "cursor:grab": "cursor:grab",
    "cursor:grabbing": "cursor:grabbing",
  };
}

// ---- Main Component ----
export default function FloatingAIChat({ user }) {
  const displayName = String(user?.name || "User").trim() || "User";
  const userId = String(user?.id || "").trim();
  const todayLabel = new Date().toLocaleDateString("en-US", { weekday: "long" });

  // ---- Chat state ----
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    {
      id: `assistant_init_${Date.now()}`,
      role: "assistant",
      content: `Hello ${displayName}, today is ${todayLabel}. I am ${ASSISTANT_NAME}, your ${ASSISTANT_KIND} assistant powered by ${SNN_LABEL}.`,
    },
  ]);
  const [loading, setLoading] = useState(false);

  // ---- Position & Drag State ----
  const [position, setPosition] = useState(() => {
    const saved = loadSavedPosition();
    return saved || getDefaultPosition();
  });
  const [isDragging, setIsDragging] = useState(false);

  // ---- Refs ----
  const buttonRef = useRef(null);
  const chatRef = useRef(null);
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, buttonX: 0, buttonY: 0 });
  const isPointerDownRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const activePointerIdRef = useRef(null);
  const currentPosRef = useRef(position);
  const isOpenRef = useRef(isOpen);
  const scrollRef = useRef(null);
  const rafRef = useRef(null);

  // Keep refs in sync with state
  currentPosRef.current = position;
  isOpenRef.current = isOpen;

  // ---- Clamp and save on window resize (debounced) ----
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

  // ---- Auto-scroll chat on new messages or state change ----
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, isOpen]);

  // ---- Chat send handler ----
  const sendMessage = useCallback(async () => {
    const userMessage = String(input || "").trim();
    if (!userMessage || loading) return;

    setMessages((prev) => [
      ...prev,
      { id: `user_${Date.now()}`, role: "user", content: userMessage },
    ]);
    setInput("");
    setLoading(true);

    try {
      const data = await queryAIEngine({
        message: userMessage,
        email: user?.email || "guest",
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: data?.reply || "No response",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_err_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: "edu_assistance service unavailable",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, user]);

  const onKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // ---- Toggle and close chat ----
  const toggleChat = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const closeChat = useCallback(() => {
    setIsOpen(false);
  }, []);

  // ---- Compute chat placement intelligently relative to button ----
  const getChatPlacement = useCallback(() => {
    const vp = getViewport();
    const chatW = Math.min(CHAT_WIDTH, vp.width - 16);
    const chatH = Math.min(CHAT_HEIGHT, vp.height - 16);

    const btnX = position.x;
    const btnY = position.y;

    const spaceAbove = btnY;
    const spaceBelow = vp.height - (btnY + BUTTON_SIZE);

    // Decide vertical placement: above if fits, or if more space above than below
    let top;
    if (spaceAbove >= chatH + CHAT_GAP) {
      top = btnY - chatH - CHAT_GAP;
    } else if (spaceBelow >= chatH + CHAT_GAP) {
      top = btnY + BUTTON_SIZE + CHAT_GAP;
    } else {
      top = spaceAbove >= spaceBelow ? btnY - chatH - CHAT_GAP : btnY + BUTTON_SIZE + CHAT_GAP;
    }

    // Decide horizontal placement: align right with button if on right half, else align left
    let left;
    if (btnX > vp.width / 2) {
      left = btnX + BUTTON_SIZE - chatW;
    } else {
      left = btnX;
    }

    // Clamp chat position to viewport boundaries
    const clampedChat = clampPosition(left, top, chatW, chatH);
    return {
      left: clampedChat.x,
      top: clampedChat.y,
      width: chatW,
      height: chatH,
    };
  }, [position]);

  const chatPlacement = getChatPlacement();

  // ---- Pointer Events for Drag & Click ----
  const handlePointerDown = useCallback((event) => {
    // Only respond to main button clicks (left mouse button or touch/pen)
    if (event.button !== 0 && event.pointerType === "mouse") return;

    // Ignore if click originated on child controls with specific actions
    if (event.target.closest('[aria-label="Close chat"]')) return;

    isPointerDownRef.current = true;
    hasDraggedRef.current = false;
    activePointerIdRef.current = event.pointerId;

    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      buttonX: currentPosRef.current.x,
      buttonY: currentPosRef.current.y,
    };

    // Capture pointer events for smooth dragging even outside button boundaries
    if (buttonRef.current && typeof buttonRef.current.setPointerCapture === "function") {
      try {
        buttonRef.current.setPointerCapture(event.pointerId);
      } catch {
        // Fallback safely if setPointerCapture is unsupported
      }
    }
  }, []);

  const handlePointerMove = useCallback((event) => {
    if (!isPointerDownRef.current) return;

    const dx = event.clientX - dragStartRef.current.pointerX;
    const dy = event.clientY - dragStartRef.current.pointerY;
    const distance = Math.hypot(dx, dy);

    // Check if movement exceeds threshold
    if (!hasDraggedRef.current && distance >= DRAG_THRESHOLD) {
      hasDraggedRef.current = true;
      setIsDragging(true);

      // Gracefully close open chat window on drag start
      if (isOpenRef.current) {
        setIsOpen(false);
      }
    }

    if (hasDraggedRef.current) {
      const nextX = dragStartRef.current.buttonX + dx;
      const nextY = dragStartRef.current.buttonY + dy;
      const clamped = clampPosition(nextX, nextY, BUTTON_SIZE, BUTTON_SIZE);

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        setPosition(clamped);
      });
    }
  }, []);

  const handlePointerUp = useCallback(
    (event) => {
      if (!isPointerDownRef.current) return;

      isPointerDownRef.current = false;

      // Release pointer capture
      if (buttonRef.current && typeof buttonRef.current.releasePointerCapture === "function") {
        try {
          if (activePointerIdRef.current !== null) {
            buttonRef.current.releasePointerCapture(activePointerIdRef.current);
          }
        } catch {
          // Ignore release errors
        }
      }
      activePointerIdRef.current = null;

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }

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
        // Tap/click detected without drag -> Toggle chat
        toggleChat();
      }

      hasDraggedRef.current = false;
    },
    [toggleChat]
  );

  // ---- Keyboard accessibility ----
  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleChat();
      }
    },
    [toggleChat]
  );

  // ---- Dynamic Styles ----
  const buttonCursorClass = isDragging ? "cursor-grabbing cursor:grabbing" : "cursor-grab cursor:grab";

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
      {/* ===== AI Chat Window ===== */}
      <div
        id="eduNova-ai-chat"
        ref={chatRef}
        style={chatStyle}
        className={`rounded-2xl bg-gradient-to-b from-slate-900/95 via-slate-900/90 to-slate-950/95 backdrop-blur-md border border-white/10 shadow-2xl overflow-hidden transition-all duration-300 ${
          isOpen
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-95 pointer-events-none"
        }`}
        aria-hidden={!isOpen}
        role="dialog"
        aria-label="EduNova AI Assistant Chat"
      >
        <div className="h-16 px-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-full overflow-hidden shadow-md ring-1 ring-teal-300/40 bg-slate-900">
              <img
                src={AVATAR_SRC}
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = AVATAR_FALLBACK;
                }}
                alt="edu_assistance SNN logo"
                className="w-full h-full rounded-full object-cover border-2 border-white shadow-md"
              />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">edu_assistance</p>
              <p className="text-xs text-slate-300 truncate">
                {`${ASSISTANT_KIND} | ${SNN_LABEL} | ${displayName}${userId ? ` (${userId})` : ""} | ${todayLabel}`}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={closeChat}
            className="text-slate-300 hover:text-white transition text-lg leading-none px-2 py-1 rounded-md cursor-pointer"
            aria-label="Close chat"
          >
            ×
          </button>
        </div>

        <div ref={scrollRef} className="h-[382px] px-3 py-3 overflow-y-auto space-y-3">
          {messages.map((msg) =>
            msg.role === "user" ? (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[80%] bg-teal-500 text-white px-4 py-2 rounded-xl shadow-sm text-sm">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={msg.id} className="flex items-start gap-2">
                <img
                  src={AVATAR_SRC}
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = AVATAR_FALLBACK;
                  }}
                  alt="edu_assistance SNN logo"
                  className="w-9 h-9 rounded-full object-cover border-2 border-white shadow-md flex-shrink-0 bg-slate-900"
                />
                <div className="max-w-[80%] bg-slate-800 text-white px-4 py-2 rounded-xl shadow-sm text-sm whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            )
          )}

          {loading && (
            <div className="flex items-start gap-2">
              <img
                src={AVATAR_SRC}
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = AVATAR_FALLBACK;
                }}
                alt="edu_assistance SNN logo"
                className="w-9 h-9 rounded-full object-cover border-2 border-white shadow-md flex-shrink-0 bg-slate-900"
              />
              <div className="bg-slate-800 text-slate-200 px-4 py-2 rounded-xl text-sm">
                ...
              </div>
            </div>
          )}
        </div>

        <div className="h-[74px] border-t border-white/10 p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type your message..."
              rows={1}
              className="flex-1 resize-none rounded-xl bg-slate-800/80 text-white placeholder:text-slate-400 px-3 py-2 text-sm border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400/40"
            />
            <button
              type="button"
              onClick={sendMessage}
              disabled={loading}
              className="px-3 py-2 rounded-xl bg-teal-500 text-white text-sm font-medium hover:bg-teal-400 transition disabled:opacity-50 cursor-pointer"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ===== AI Assistant Button (Freely Draggable) ===== */}
      <button
        ref={buttonRef}
        type="button"
        style={buttonStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        aria-label={isOpen ? "Close EduNova AI assistant" : "Open EduNova AI assistant"}
        aria-expanded={isOpen}
        aria-controls="eduNova-ai-chat"
        data-drag-threshold={DRAG_THRESHOLD}
        data-position-key={STORAGE_KEY}
        className={`
          group rounded-full
          bg-white border-[3px] border-slate-900
          shadow-[0_8px_24px_rgba(15,23,42,0.35)]
          transition-transform duration-150
          focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300
          overflow-hidden p-[4px]
          ${buttonCursorClass}
          ${isDragging ? "scale-110 shadow-[0_16px_36px_rgba(15,23,42,0.6)]" : "hover:scale-105 active:scale-95 hover:shadow-[0_12px_32px_rgba(15,23,42,0.45)]"}
        `}
      >
        <img
          src={AVATAR_SRC}
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = AVATAR_FALLBACK;
          }}
          alt="edu_assistance SNN logo"
          className="w-full h-full rounded-full object-cover border-2 border-slate-200 pointer-events-none"
          draggable={false}
        />
      </button>
    </>
  );
}
