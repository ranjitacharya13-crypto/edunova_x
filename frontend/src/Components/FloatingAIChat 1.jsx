import React, { useEffect, useRef, useState } from "react";

const AVATAR_SRC = "/edai.png";
const AVATAR_FALLBACK = "https://ui-avatars.com/api/?name=AI&background=0D8ABC&color=fff";

export default function FloatingAIChat({ user }) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    {
      id: `assistant_${Date.now()}`,
      role: "assistant",
      content: "Hello, I am EduNova AI Assistant. Ask me anything about your learning workflow.",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, isOpen]);

  const sendMessage = async () => {
    const userMessage = String(input || "").trim();
    if (!userMessage || loading) return;

    setMessages((prev) => [...prev, { id: `user_${Date.now()}`, role: "user", content: userMessage }]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("http://localhost:8001/api/ai/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: userMessage,
          email: user?.email || "guest",
        }),
      });

      const data = await response.json();
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: data.reply || "No response",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_err_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: "AI service unavailable",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="group w-[72px] h-[72px] rounded-full bg-white border-[3px] border-slate-900 shadow-[0_8px_24px_rgba(15,23,42,0.35)] hover:scale-105 transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 overflow-hidden p-[4px]"
        aria-label={isOpen ? "Close AI chat" : "Open AI chat"}
      >
        <img
          src={AVATAR_SRC}
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = AVATAR_FALLBACK;
          }}
          alt="AI Avatar"
          className="w-full h-full rounded-full object-cover border-2 border-slate-200"
        />
      </button>

      <div
        className={`absolute bottom-20 right-0 w-[380px] max-w-[calc(100vw-2rem)] h-[520px] rounded-2xl bg-gradient-to-b from-slate-900/95 via-slate-900/90 to-slate-950/95 backdrop-blur-md border border-white/10 shadow-2xl overflow-hidden transition-all duration-300 ${
          isOpen
            ? "opacity-100 translate-y-0 scale-100 pointer-events-auto"
            : "opacity-0 translate-y-4 scale-95 pointer-events-none"
        }`}
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
                alt="AI Avatar"
                className="w-full h-full rounded-full object-cover border-2 border-white shadow-md"
              />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">EduNova AI Assistant</p>
              <p className="text-xs text-slate-300 truncate">Powered by Internal ML</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="text-slate-300 hover:text-white transition text-lg leading-none px-2 py-1 rounded-md"
            aria-label="Close chat"
          >
            x
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
                  alt="AI Avatar"
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
                alt="AI Avatar"
                className="w-9 h-9 rounded-full object-cover border-2 border-white shadow-md flex-shrink-0 bg-slate-900"
              />
              <div className="bg-slate-800 text-slate-200 px-4 py-2 rounded-xl text-sm">...</div>
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
    </div>
  );
}
