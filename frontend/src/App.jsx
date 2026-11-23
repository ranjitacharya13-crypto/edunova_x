import React, { useEffect, useState, useCallback, useRef } from "react";
import Header from "./Components/Header";
import Sidebar from "./Components/Sidebar";
import Dashboard from "./Components/Dashboard";
import Footer from "./Components/Footer";
import MobileBottomNav from "./Components/MobileBottomNav";
import FloatingAIChat from "./Components/FloatingAIChat";
import { getCurrentUser } from "./api/api";
import {
  clearStoredToken,
  getStoredToken,
  isJwtExpired,
} from "./api/authSession.mjs";

import { validDestination } from "./features/navigation";

const THEME_STORAGE_KEY = "theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable (private browsing)
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light";
}

export default function App() {
  const [user, setUser] = useState(null);
  const [view, updateView] = useState("welcome");
  const [resourceId, setResourceId] = useState(null);
  const [token, setToken] = useState(() => getStoredToken() || null);
  const [sessionNotice, setSessionNotice] = useState("");
  const [theme, setTheme] = useState(getInitialTheme);

  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const setView = useCallback((next) => {
    setResourceId(null);
    updateView(next);
  }, []);

  const handleLogout = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setUser(null);
    setSessionNotice("");
    setResourceId(null);
    updateView("welcome");
  }, []);

  // Validate any stored JWT once on startup. If no token is stored, skip any
  // network call and render the welcome/login view immediately.
  useEffect(() => {
    const initialToken = getStoredToken();
    if (!initialToken) return;

    if (isJwtExpired(initialToken)) {
      clearStoredToken();
      setToken(null);
      setSessionNotice("Your session has expired. Please sign in again.");
      return;
    }

    let cancelled = false;
    (async () => {
      const res = await getCurrentUser(initialToken);
      if (cancelled || userRef.current) return;
      if (res.user) {
        setToken(initialToken);
        setUser(res.user);
        updateView(res.user.role === "admin" ? "admin-overview" : "home");
      } else if (res.status === 401 || res.status === 403) {
        setToken(null);
        setSessionNotice(
          res.code === "ACCOUNT_BLOCKED" || res.status === 403
            ? "Your account has been suspended. Please contact an administrator."
            : "Your session has expired. Please sign in again."
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // React to mid-session JWT expiration or account suspension detected by the
  // Axios response interceptor.
  useEffect(() => {
    const onAuthExpired = (event) => {
      clearStoredToken();
      setToken(null);
      setUser(null);
      setResourceId(null);
      updateView("welcome");
      setSessionNotice(
        event?.detail?.message || "Your session has expired. Please sign in again."
      );
    };
    window.addEventListener("edunova:auth-expired", onAuthExpired);
    return () => window.removeEventListener("edunova:auth-expired", onAuthExpired);
  }, []);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable
    }
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
          user={user}
          onLogout={handleLogout}
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
                onLogout={handleLogout}
              />
            </aside>

            {/* ===== Content ===== */}
            <section className="min-w-0">
              <Dashboard
                user={user}
                token={token}
                view={view}
                resourceId={resourceId}
                setView={setView}
                setUser={setUser}
                setToken={setToken}
                sessionNotice={sessionNotice}
                onClearSessionNotice={() => setSessionNotice("")}
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
