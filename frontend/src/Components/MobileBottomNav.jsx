import React from "react";

const items = [
  ["home", "Home", <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-5v-7H10v7H5a2 2 0 0 1-2-2V10Z" />],
  ["syllabus", "Syllabus", <><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z" /><path d="M8 8h8M8 12h8M8 16h5" /></>],
  ["study", "Study", <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>],
  ["live", "Live", <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>],
  ["contact", "Help", <><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.4 2.4 0 1 1 3.8 2c-.95.7-1.5 1.12-1.5 2.5M12 17h.01" /></>],
];

export default function MobileBottomNav({ view, setView }) {
  return (
    <nav aria-label="Mobile navigation" className="glass-nav mx-2 mb-2 grid grid-cols-5 gap-1 rounded-2xl p-1.5 shadow-[0_-10px_28px_rgba(15,23,42,.10)]">
      {items.map(([id, label, icon]) => {
        const active = view === id;
        return <button key={id} type="button" onClick={() => setView(id)} aria-current={active ? "page" : undefined} className={`flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${active ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:bg-teal-50 hover:text-teal-800 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-teal-200"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true">{icon}</svg>{label}
        </button>;
      })}
    </nav>
  );
}
