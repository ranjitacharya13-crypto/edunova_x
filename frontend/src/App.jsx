import React, { useEffect, useState } from "react";
import Header from "./Components/Header";
import Sidebar from "./Components/Sidebar";
import Dashboard from "./Components/Dashboard";
import Footer from "./Components/Footer";
import MobileBottomNav from "./Components/MobileBottomNav";
import FloatingAIChat from "./Components/FloatingAIChat";

const THEME_STORAGE_KEY = "theme";
const USER_STORAGE_KEY = "edunova:user";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function getStoredUser() {
  if (typeof window === "undefined" || !localStorage.getItem("token")) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    localStorage.removeItem(USER_STORAGE_KEY);
    return null;
  }
}

export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [view, setView] = useState(() => (getStoredUser() ? "home" : "welcome"));
  const [token, setToken] = useState(() => localStorage.getItem("token"));
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!token || !user) return;
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  }, [token, user]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <Header theme={theme} onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))} />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <main className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5 sm:py-6 lg:px-8">
          <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[264px_minmax(0,1fr)] lg:grid-cols-[290px_minmax(0,1fr)] lg:gap-7">
            <aside className="sticky top-24 hidden md:block">
              <Sidebar user={user} view={view} setUser={setUser} setView={setView} setToken={setToken} />
            </aside>
            <section className="min-w-0">
              <Dashboard user={user} view={view} setView={setView} setUser={setUser} setToken={setToken} />
            </section>
          </div>
          <Footer onNavigate={setView} />
        </main>
      </div>

      {user && user.role !== "admin" && (
        <div className="shrink-0 pb-[env(safe-area-inset-bottom)] md:hidden">
          <MobileBottomNav view={view} setView={setView} />
        </div>
      )}

      <FloatingAIChat user={user} />
    </div>
  );
}
