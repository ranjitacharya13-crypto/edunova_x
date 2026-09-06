import React, { useEffect, useState, useCallback } from "react";
import Header from "./Components/Header";
import Sidebar from "./Components/Sidebar";
import Dashboard from "./Components/Dashboard";
import Footer from "./Components/Footer";
import MobileBottomNav from "./Components/MobileBottomNav";
import FloatingAIChat from "./Components/FloatingAIChat";

import { validDestination } from "./features/navigation";

const THEME_STORAGE_KEY = "theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light";
}

export default function App() {
  const [user, setUser] = useState(null);
  const [view, updateView] = useState("welcome");
  const [resourceId, setResourceId] = useState(null);
  const setView = useCallback((next) => { setResourceId(null); updateView(next); }, []);
  useEffect(() => {
    const onNavigate = (event) => {
      if (!user || !validDestination(event.detail)) return;
      const aliases = { timetable: "home", assignments: "live", "study-plans": "progress" };
      setResourceId(event.detail.id || null);
      updateView(aliases[event.detail.view] || event.detail.view);
    };
    window.addEventListener("edunova:navigate", onNavigate);
    return () => window.removeEventListener("edunova:navigate", onNavigate);
  }, [user]);
  const [token, setToken] = useState(localStorage.getItem("token"));
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      {/* ================= TOP BAR ================= */}
      <div className="shrink-0">
        <Header
          theme={theme}
          onToggleTheme={() =>
            setTheme((t) => (t === "dark" ? "light" : "dark"))
          }
        />
      </div>

      {/* ================= SCROLL AREA ================= */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <main className="w-full max-w-[1600px] mx-auto px-2 sm:px-4 lg:px-6 2xl:px-8 py-3 sm:py-4">
          <div className="grid grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] gap-4 sm:gap-6 items-start">
            {/* ===== Sidebar (TABLET+ ONLY) ===== */}
            <aside className="hidden md:block sticky top-4">
              <Sidebar
                user={user}
                view={view}
                setUser={setUser}
                setView={setView}
                setToken={setToken}
              />
            </aside>

            {/* ===== Content ===== */}
            <section className="min-w-0">
              <Dashboard
                user={user}
                view={view}
                resourceId={resourceId}
                setView={setView}
                setUser={setUser}
              />
            </section>
          </div>

          {/* ================= FOOTER (DESKTOP ONLY) ================= */}
          <div className="hidden lg:block">
            <Footer />
          </div>
        </main>
      </div>

      {/* ================= BOTTOM TABS (MOBILE) ================= */}
      {user && user.role !== "admin" && (
        <div className="md:hidden shrink-0 pb-[env(safe-area-inset-bottom)]">
          <MobileBottomNav view={view} setView={setView} />
        </div>
      )}

      {user && <FloatingAIChat user={user} feature={view} />}
    </div>
  );
}
