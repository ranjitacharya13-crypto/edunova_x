import React, { useEffect, useRef, useState } from "react";
import { queryAIEngine } from "../api/api";

const QUICK_PROMPTS = [
  "Explain today's topic",
  "Help me study",
  "Give me practice questions",
];

function AssistantMark({ className = "" }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className} fill="none">
      <path d="M24 6a18 18 0 1 0 13.8 29.55L42 42l-6.45-4.2A18 18 0 1 0 24 6Z" fill="currentColor" opacity=".18" />
      <path d="M15 24h18M24 15v18M18.2 18.2l11.6 11.6M29.8 18.2 18.2 29.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".9" />
      <circle cx="24" cy="24" r="5.2" fill="currentColor" />
      <circle cx="14" cy="14" r="2.2" fill="currentColor" />
      <circle cx="34" cy="14" r="2.2" fill="currentColor" />
      <circle cx="34" cy="34" r="2.2" fill="currentColor" />
    </svg>
  );
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21 3-7.5 18-3.8-7.7L2 9.5 21 3Z" /><path d="m9.5 13.3 4-4" /></svg>;
}

export default function FloatingAIChat({ user }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async (value = input) => {
    const message = String(value || "").trim();
    if (!message || loading) return;
    setMessages((current) => [...current, { id: crypto.randomUUID?.() || Date.now(), role: "user", content: message }]);
    setInput("");
    setLoading(true);
    try {
      const data = await queryAIEngine({ message, email: user?.email });
      if (!data?.success || !data?.reply) throw new Error(data?.error || "Invalid AI response");
      setMessages((current) => [...current, { id: crypto.randomUUID?.() || `${Date.now()}-ai`, role: "assistant", content: data.reply }]);
    } catch (error) {
      setMessages((current) => [...current, {
        id: crypto.randomUUID?.() || `${Date.now()}-error`, role: "error",
        content: "EduNova AI is temporarily unavailable. Please try again.",
      }]);
    } finally {
      setLoading(false);
    }
  };

  return <div className="edunova-ai" aria-live="polite">
    {open && <section className="edunova-ai__panel" role="dialog" aria-modal="false" aria-label="EduNova AI assistant">
      <header className="edunova-ai__header">
        <div className="edunova-ai__identity"><span className="edunova-ai__avatar"><AssistantMark /></span><span><strong>EduNova AI</strong><small><i /> Your learning assistant</small></span></div>
        <button type="button" className="edunova-ai__close" onClick={() => setOpen(false)} aria-label="Close EduNova AI assistant">×</button>
      </header>
      <div className="edunova-ai__messages" ref={scrollRef}>
        {!messages.length && <div className="edunova-ai__empty"><span className="edunova-ai__empty-mark"><AssistantMark /></span><h2>Ready when you are</h2><p>Ask me anything about your studies, timetable, or revision plan.</p><div className="edunova-ai__prompts">{QUICK_PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => sendMessage(prompt)}>{prompt}</button>)}</div></div>}
        {messages.map((message) => <div className={`edunova-ai__message edunova-ai__message--${message.role}`} key={message.id}>{message.role === "assistant" && <AssistantMark className="edunova-ai__message-mark" />}<p>{message.content}</p></div>)}
        {loading && <div className="edunova-ai__typing"><span /><span /><span /> <em>EduNova AI is thinking</em></div>}
      </div>
      <form className="edunova-ai__composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
        <label className="sr-only" htmlFor="edunova-ai-input">Ask EduNova AI</label>
        <textarea id="edunova-ai-input" ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="Ask about your studies…" rows="1" disabled={loading} />
        <button type="submit" disabled={!input.trim() || loading} aria-label="Send message"><SendIcon /></button>
      </form>
    </section>}
    <button type="button" className={`edunova-ai__launcher ${open ? "edunova-ai__launcher--open" : ""}`} onClick={() => setOpen((value) => !value)} aria-label={open ? "Close EduNova AI assistant" : "Open EduNova AI assistant"} aria-expanded={open} aria-controls="edunova-ai-input">
      <span className="edunova-ai__launcher-glow" /><AssistantMark /><span className="sr-only">EduNova AI</span>
    </button>
  </div>;
}
