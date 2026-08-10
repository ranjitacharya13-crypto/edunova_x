import React from "react";
import Navigation from "./Navigation";
import AdminNavigation from "./Admin/AdminNavigation";

export default function Sidebar({ user, view, setUser, setView, setToken }) {
  const handleLogout = () => {
    localStorage.removeItem("token");
    setToken(null);
    setUser(null);
    setView("welcome");
  };

  return (
    <aside className="flex flex-col gap-5 sticky top-24">

      {/* ================= USER CARD ================= */}
      {user && (
        <div className="glass-card p-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">{user.name}</div>
            <div className="text-xs text-slate-500 capitalize">
              {user.role}
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="text-sm text-rose-600 bg-rose-500/10 px-3 py-1.5 rounded-xl hover:bg-rose-500/15 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            Sign out
          </button>
        </div>
      )}

      {/* ================= NAVIGATION ================= */}
      {user &&
        (user.role === "admin" ? (
          <AdminNavigation setView={setView} activeView={view} />
        ) : (
          <Navigation setView={setView} />
        ))}
    </aside>
  );
}
