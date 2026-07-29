import React, { useEffect } from "react";
import { loginUser } from "../api/api";

import HomeView from "./Views/HomeView";
import SyllabusView from "./Views/SyllabusView";
import StudyView from "./Views/StudyView";
import LiveView from "./Views/LiveView";
import ContactView from "./Views/ContactView";
import LoginCard from "./LoginCard";
import AdminDashboard from "./Admin/AdminDashboard";
import AIChatAssistant from "./AIChatAssistant";

export default function Dashboard({ user, view, setUser, setView }) {
  useEffect(() => {
    if (user?.role === "admin" && !String(view || "").startsWith("admin-")) {
      setView("admin-overview");
    }
  }, [user, view, setView]);

  if (user?.role === "admin") {
    return (
        <div className="w-full min-w-0">
        <div className="page slide-enter-active page-shell">
          <AdminDashboard view={view} user={user} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">

      {/* =========================
          WELCOME / LOGIN (APP STYLE)
      ========================== */}
      {view === "welcome" && (
        <div className="page slide-enter-active page-shell">
          <div className="flex flex-col lg:grid lg:grid-cols-2 lg:items-center gap-8">

            {/* ===== LEFT : HERO CONTENT ===== */}
            <div className="w-full text-center lg:text-left px-2">

              <h1 className="text-2xl lg:text-4xl font-bold leading-tight">
                Educational platform <br />
                <span className="text-primary">
                  for Students and Teachers
                </span>
              </h1>

              <p className="mt-3 text-sm lg:text-base text-slate-600 max-w-md mx-auto lg:mx-0">
                Best interaction for teacher–student.
                Access syllabus, study materials and live classes — all in one platform.
              </p>

              {/* FEATURES (hide on very small screens) */}
              <div className="hidden sm:flex justify-center lg:justify-start gap-6 mt-6">
                <div>
                  <div className="text-primary font-semibold text-sm">For</div>
                  <div className="text-xs text-slate-500">
                    Students & Teachers
                  </div>
                </div>
                <div>
                  <div className="text-primary font-semibold text-sm">Features</div>
                  <div className="text-xs text-slate-500">
                    Live classes & study materials
                  </div>
                </div>
              </div>

            </div>

            {/* ===== RIGHT : LOGIN CARD ===== */}
            <div className="w-full flex justify-center mt-8 lg:mt-0">
              <LoginCard
                onLogin={async (email, password) => {
                  const res = await loginUser({ email, password });
                  if (!res?.error && res?.user) {
                    localStorage.setItem("token", res.token);
                    setUser(res.user);
                    setView("home");
                  }
                  return res;
                }}
                onGuest={() => {
                  setUser({ name: "Guest", role: "guest" });
                  setView("home");
                }}
              />
            </div>

          </div>
        </div>
      )}

      {/* =========================
          HOME
      ========================== */}
      {view === "home" && (
        <div className="page slide-enter-active page-shell">
          <HomeView user={user} setView={setView} />
        </div>
      )}

      {/* =========================
          SYLLABUS
      ========================== */}
      {view === "syllabus" && (
        <div className="page slide-enter-active page-shell">
          <SyllabusView user={user} />
        </div>
      )}

      {/* =========================
          STUDY
      ========================== */}
      {view === "study" && (
        <div className="page slide-enter-active page-shell">
          <StudyView user={user} />
        </div>
      )}

      {/* =========================
          LIVE
      ========================== */}
      {view === "live" && (
        <div className="page slide-enter-active page-shell">
          <LiveView user={user} />
        </div>
      )}

      {/* =========================
          CONTACT
      ========================== */}
      {view === "contact" && (
        <div className="page slide-enter-active page-shell">
          <ContactView />
        </div>
      )}

      {view === "ai-assistant" && (
        <div className="page slide-enter-active page-shell">
          <AIChatAssistant user={user} />
        </div>
      )}

    </div>
  );
}
