import React from "react";

const ADMIN_ITEMS = [
  { id: "admin-overview", label: "Overview" },
  { id: "admin-users", label: "Users" },
  { id: "admin-teachers", label: "Teachers" },
  { id: "admin-students", label: "Students" },
  { id: "admin-timetables", label: "Timetables" },
  { id: "admin-live-classes", label: "Live Classes" },
  { id: "admin-videos", label: "Recorded Videos" },
  { id: "admin-assignments", label: "Assignments" },
  { id: "admin-messages", label: "Messages" },
  { id: "admin-analytics", label: "System Analytics" },
  { id: "admin-ai-assistant", label: "AI Assistant" },
];

export default function AdminNavigation({ setView, activeView }) {
  return (
    <nav className="glass-card p-4 space-y-3">
      <div className="text-xs text-slate-500 font-medium">Admin Navigation</div>
      <div className="flex flex-col gap-1">
        {ADMIN_ITEMS.map((it) => (
          <button
            key={it.id}
            onClick={() => setView(it.id)}
            className={`text-left px-3 py-2.5 rounded-xl text-sm transition focus:outline-none focus:ring-2 focus:ring-primary/30 ${
              activeView === it.id
                ? "bg-primary/15 text-primary font-medium"
                : "text-slate-700 hover:bg-primary/10"
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
