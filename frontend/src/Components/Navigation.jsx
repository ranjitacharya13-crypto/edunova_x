import React from "react";

const icons = {
  home: <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10Zm6 12v-7h6v7" />,
  syllabus: <><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17.5H7.5A2.5 2.5 0 0 0 5 22.5V4.5Z" /><path d="M5 4.5v15M9 6h7M9 10h7" /></>,
  study: <><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
  live: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3v-4Z" /></>,
  contact: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.7 9.7 0 0 1-4.1-.9L3 21l1.5-4A8.5 8.5 0 1 1 21 11.5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
};

export default function Navigation({ setView, activeView }) {
  const items = [
    { id: "home", label: "Home" },
    { id: "syllabus", label: "Syllabus" },
    { id: "study", label: "Study materials" },
    { id: "live", label: "Live classes" },
    { id: "contact", label: "Contact & help" },
  ];

  return (
    <nav aria-label="Primary navigation" className="glass-card p-3">
      <p className="px-3 pb-2 pt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-400">Workspace</p>
      <div className="space-y-1">
        {items.map((item) => {
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setView(item.id)}
              className={`group flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
                active
                  ? "bg-gradient-to-r from-teal-600 to-teal-500 text-white shadow-[0_10px_20px_rgba(13,148,136,0.22)]"
                  : "text-slate-600 hover:bg-teal-50 hover:text-teal-800 dark:text-slate-300 dark:hover:bg-white/8 dark:hover:text-teal-200"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
                {icons[item.id]}
              </svg>
              {item.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
