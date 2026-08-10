import React, { useEffect, useRef, useState, useCallback } from "react";
import { queryAIEngine } from "../api/api";

const AVATAR_SRC = "/edu-assistance-snn.svg";
const AVATAR_FALLBACK = "https://ui-avatars.com/api/?name=SNN&background=0F766E&color=fff";
const ASSISTANT_NAME = "edu_assistance";
const ASSISTANT_KIND = "ASI: Artificial Superintelligence";
const SNN_LABEL = "SNN: Spiking Neural Network";

// ---- Constants ----
const BUTTON_SIZE = 72; // matches w-[72px] h-[72px]
const STORAGE_KEY = "eduNova_ai_position";
const DRAG_THRESHOLD = 8; // px – movement beyond this counts as drag, not click
const Z_INDEX_BUTTON = 50;
const Z_INDEX_CHAT = 49;

// ---- Helpers ----
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function clampPosition(x, y, elWidth, elHeight) {
  const vp = getViewport();
  return {
    x: clamp(x, 0, vp.width - elWidth),
    y: clamp(y, 0, vp.height - elHeight),
  };
}

function loadSavedPosition() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    // Validate against current viewport
    const vp = getViewport();
    const clamped = clampPosition(parsed.x, parsed.y, BUTTON_SIZE, BUTTON_SIZE);
    // If clamped significantly differently, position was out of bounds — still use clamped
    return clamped;
  } catch {
    return null;
  }
}

function savePosition(x, y) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fail silently
  }
}

// ---- Component ----
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

  // ---- Position state ----
  const [position, setPosition] = useState({ x: -BUTTON_SIZE, y: -BUTTON_SIZE }); // start off-screen until mounted
  const [isDragging, setIsDragging] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);

  // ---- Refs ----
  const buttonRef = useRef(null);
  const chatRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(null);
  const scrollRef = useRef(null);

  // ---- Restore saved position on mount ----
  useEffect(() => {
    const saved = loadSavedPosition();
    if (saved) {
      setPosition(saved);
    } else {
      // Default: bottom-right with margin
      const vp = getViewport();
      setPosition({
        x: vp.width - BUTTON_SIZE - 24,
        y: vp.height - BUTTON_SIZE - 24,
      });
    }
  }, []);

  // ---- Clamp position on viewport resize ----
  useEffect(() => {
    function handleResize() {
      setPosition((prev) => {
        const clamped = clampPosition(prev.x, prev.y, BUTTON_SIZE, BUTTON_SIZE);
        // Only save if position actually changed due to clamp
        if (clamped.x !== prev.x || clamped.y !== prev.y) {
          savePosition(clamped.x, clamped.y);
        }
        return clamped;
      });
    }

    let timeoutId;
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

  // ---- Auto-scroll chat ----
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, isOpen]);

  // ---- Chat send ----
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

  // ---- Compute chat position relative to button ----
  const getChatPlacement = useCallback(() => {
    const buttonRect = {
      left: position.x,
      top: position.y,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
    };

    // Estimate chat dimensions (matches CSS: w-[380px], h-[520px] + bottom margin)
    const chatWidth = 380;
    const chatHeight = 520;
    const gap = 12; // space between button and chat
    const vp = getViewport();

    // Default: chat opens above-left of button (classic floating position)
    let left = buttonRect.left;
    let top = buttonRect.top - chatHeight - gap;

    // Available space in each direction
    const spaceAbove = buttonRect.top;
    const spaceBelow = vp.height - (buttonRect.top + buttonRect.height);
    const spaceLeft = buttonRect.left;
    const spaceRight = vp.width - (buttonRect.left + buttonRect.width);

    // Decide vertical placement
    if (spaceAbove >= chatHeight + gap && spaceAbove >= spaceBelow) {
      // Open above
      top = buttonRect.top - chatHeight - gap;
    } else if (spaceBelow >= chatHeight + gap) {
      // Open below
      top = buttonRect.top + buttonRect.height + gap;
    } else {
      // Neither fits perfectly — clamp
      if (spaceAbove > spaceBelow) {
        top = buttonRect.top - chatHeight - gap;
      } else {
        top = buttonRect.top + buttonRect.height + gap;
      }
    }

    // Decide horizontal placement
    if (spaceLeft >= chatWidth && spaceLeft >= spaceRight) {
      left = buttonRect.left;
    } else if (spaceRight >= chatWidth) {
      left = buttonRect.left;
    } else {
      // Clamp horizontally
      left = clamp(buttonRect.left, 0, vp.width - chatWidth);
    }

    // Final clamp to viewport
    const { x, y } = clampPosition(left, top, chatWidth, chatHeight);
    return { left: x, top: y, width: chatWidth, height: chatHeight };
  }, [position]);

  const chatPlacement = getChatPlacement();

  // ---- Toggle chat ----
  const toggleChat = useCallback(() => {
    setIsOpen((v) => !v);
  }, []);

  const closeChat = useCallback(() => {
    setIsOpen(false);
  }, []);

  // ---- Drag handlers ----
  const handlePointerDown = useCallback(
    (event) => {
      // Ignore if the event target is the close button inside chat
      if (event.target.closest('[aria-label="Close chat"]')) return;

      const rect = buttonRef.current.getBoundingClientRect();
      dragStartRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      setIsDragging(true);
      setHasDragged(false);

      // Mark pointer capture for smooth tracking
      if (buttonRef.current) {
        buttonRef.current.setPointerCapture(event.pointerId);
      }
    },
    []
  );

  const handlePointerMove = useCallback(
    (event) => {
      if (!isDragging) return;

      const dx = event.clientX - dragStartRef.current.x;
      const dy = event.clientY - dragStartRef.current.y;

      // Detect drag vs click
      if (!hasDragged && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        setHasDragged(true);
        // If chat was open and we start dragging, close it gracefully
        if (isOpen) {
          setIsOpen(false);
        }
      }

      if (!hasDragged) return;

      // Calculate new position
      const newX = event.clientX - BUTTON_SIZE / 2; // center button on pointer
      const newY = event.clientY - BUTTON_SIZE / 2;

      // Clamp to viewport
      const clamped = clampPosition(newX, newY, BUTTON_SIZE, BUTTON_SIZE);

      // Use rAF for smooth visual updates
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        setPosition(clamped);
      });
    },
    [isDragging, hasDragged, isOpen]
  );

  const handlePointerUp = useCallback(
    (event) => {
      if (!isDragging) return;

      setIsDragging(false);

      // Release pointer capture
      if (buttonRef.current) {
        try {
          buttonRef.current.releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }

      // Save final position
      savePosition(position.x, position.y);

      // If it was just a click (no drag), toggle chat
      if (!hasDragged) {
        toggleChat();
      }

      setHasDragged(false);
    },
    [isDragging, hasDragged, toggleChat, position]
  );

  // ---- Keyboard support ----
  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleChat();
      }
    },
    [toggleChat]
  );

  // ---- Determine cursor class ----
  const buttonCursor = isDragging ? "cursor:grabbing" : "cursor:grab";
  const buttonStyle = {
    position: "fixed",
    left: position.x,
    top: position.y,
    zIndex: Z_INDEX_BUTTON,
  };

  const chatStyle = {
    position: "fixed",
    left: chatPlacement.left,
    top: chatPlacement.top,
    width: chatPlacement.width,
    height: chatPlacement.height,
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
            className="text-slate-300 hover:text-white transition text-lg leading-none px-2 py-1 rounded-md"
            aria-label="Close chat"
          >
            ×{" "}
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
              className="px-3 py-2 rounded-xl bg-teal-500 text-white text-sm font-medium hover:bg-teal-400 transition disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ===== AI Assistant Button (Draggable) ===== */}
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
        className={`
          group w-[72px] h-[72px] rounded-full
          bg-white border-[3px] border-slate-900
          shadow-[0_8px_24px_rgba(15,23,42,0.35)]
          hover:scale-105 active:scale-95
          transition-transform duration-200
          focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300
          overflow-hidden p-[4px]
          ${buttonCursor}
          ${isDragging ? "scale-110 shadow-[0_12px_32px_rgba(15,23,42,0.5)]" : ""}
          ${!isDragging ? "hover:shadow-[0_12px_32px_rgba(15,23,42,0.45)]" : ""}
        `}
      >
        <img
          src={AVATAR_SRC}
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = AVATAR_FALLBACK;
          }}
          alt="edu_assistance SNN logo"
          className="w-full h-full rounded-full object-cover border-2 border-slate-200"
        />
      </button>
    </>
  );
}
