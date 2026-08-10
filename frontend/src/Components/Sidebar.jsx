import React from "react";
import Navigation from "./Navigation";
import AdminNavigation from "./Admin/AdminNavigation";
import BrandMark from "./BrandMark";

export default function Sidebar({ user, view, setUser, setView, setToken }) {
  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("edunova:user");
    setToken(null);
    setUser(null);
    setView("welcome");
  };

  if (!user) return null;

  return (
    <aside className="flex flex-col gap-4" aria-label="Account and navigation">
      <div className="glass-card overflow-hidden p-4">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-teal-600 to-cyan-500 text-sm font-bold text-white shadow-[0_8px_20px_rgba(13,148,136,0.24)]" aria-hidden="true">
            {String(user.name || "U").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-900 dark:text-white">{user.name || "EduNova learner"}</p>
            <p className="mt-0.5 text-xs capitalize text-slate-500 dark:text-slate-400">{user.role || "member"} workspace</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="h-4 w-4" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /></svg>
          Sign out
        </button>
      </div>

      {user.role === "admin" ? (
        <AdminNavigation setView={setView} activeView={view} />
      ) : (
        <Navigation setView={setView} activeView={view} />
      )}

      <div className="hidden rounded-2xl border border-teal-100 bg-gradient-to-br from-teal-50 to-cyan-50 p-4 dark:border-teal-400/10 dark:from-teal-500/10 dark:to-cyan-500/5 lg:block">
        <BrandMark showWordmark={false} className="mb-3" />
        <p className="text-sm font-bold text-slate-800 dark:text-white">Make room for progress.</p>
        <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">Your timetable, materials, and live learning tools are kept together here.</p>
      </div>
    </aside>
  );
}
