import React from "react";

const NavItem = ({ label, active, onClick, icon }) => (
  <button
    onClick={onClick}
    className={`
      relative flex flex-col items-center justify-center gap-1
      text-[10px] sm:text-[11px] font-medium
      min-w-[56px] min-h-[52px] px-2 sm:px-3 py-2 rounded-2xl
      transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30
      ${active ? "text-teal-700" : "text-slate-500 hover:text-slate-600"}
    `}
  >
    <span
      className={`absolute inset-0 rounded-2xl transition ${
        active ? "bg-primary/10" : "bg-transparent"
      }`}
      aria-hidden="true"
    />
    <div
      className={`
        relative w-6 h-6
        ${active ? "fill-teal-600" : "fill-slate-400"}
      `}
    >
      {icon}
    </div>
    <span className="relative">{label}</span>
  </button>
);

export default function MobileBottomNav({ view, setView }) {
  return (
    <nav
      className="
        glass-nav rounded-2xl
        shadow-[0_-12px_32px_rgba(15,23,42,0.10)]
        flex justify-between items-stretch
        mx-2 sm:mx-3 mb-2.5 sm:mb-3
        px-1 py-2
        z-50
      "
    >
      <NavItem
        label="Home"
        active={view === "home"}
        onClick={() => setView("home")}
        icon={
          <svg viewBox="0 0 24 24">
            <path d="M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
          </svg>
        }
      />

      <NavItem
        label="Syllabus"
        active={view === "syllabus"}
        onClick={() => setView("syllabus")}
        icon={
          <svg viewBox="0 0 24 24">
            <path d="M4 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4zM8 7h8M8 11h8M8 15h5" />
          </svg>
        }
      />

      <NavItem
        label="Study"
        active={view === "study"}
        onClick={() => setView("study")}
        icon={
          <svg viewBox="0 0 24 24">
            <path d="M3 4h18v14H3zM7 18h10v2H7z" />
          </svg>
        }
      />

      <NavItem
        label="Live"
        active={view === "live"}
        onClick={() => setView("live")}
        icon={
          <svg viewBox="0 0 24 24">
            <path d="M4 6h12v12H4zM18 8l4-2v12l-4-2z" />
          </svg>
        }
      />

      <NavItem
        label="Help"
        active={view === "contact"}
        onClick={() => setView("contact")}
        icon={
          <svg viewBox="0 0 24 24">
            <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 15h.01M11 10a1 1 0 1 1 2 0c0 1-1 1.5-1 2" />
          </svg>
        }
      />

      <NavItem
        label="AI"
        active={view === "ai-assistant"}
        onClick={() => setView("ai-assistant")}
        icon={
          <svg viewBox="0 0 24 24">
            <path d="M8 4h8v3h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2v2h-2v-2h-4v2H8v-2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2zm0 7h8V9H8zm-2 3h12v2H6z" />
          </svg>
        }
      />
    </nav>
  );
}
