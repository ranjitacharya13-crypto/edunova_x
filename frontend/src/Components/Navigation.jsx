import React from "react";

export default function Navigation({ setView }) {
  const items = [
    { id: "home", label: "Home" },
    { id: "syllabus", label: "Syllabus" },
    { id: "study", label: "Study Material" },
    { id: "live", label: "Live Classes" },
    { id: "quiz", label: "Practice Quiz" },
    { id: "progress", label: "Progress & Plans" },
    { id: "ai-assistant", label: "EduNova AI" },
    { id: "contact", label: "Contact" },
  ];

  return (
    <nav className="glass-card p-4 space-y-3">
      <div className="text-xs text-slate-500 font-medium">
        Navigation
      </div>

      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => setView(it.id)}
            className="text-left px-3 py-2.5 rounded-xl text-sm text-slate-700 hover:bg-primary/10 transition focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {it.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
