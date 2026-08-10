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
import BrandMark from "./BrandMark";

export default function Dashboard({ user, view, setUser, setView, setToken }) {
  useEffect(() => {
    if (user?.role === "admin" && !String(view || "").startsWith("admin-")) {
      setView("admin-overview");
    }
  }, [user, view, setView]);

  if (user?.role === "admin") {
    return <div className="page page-shell min-w-0 animate-page-in"><AdminDashboard view={view} user={user} /></div>;
  }

  const signIn = async (identifier, password) => {
    // Send the established `email` key for compatibility with already deployed
    // APIs. The value may be an email address or username; the server supports both.
    const response = await loginUser({ email: identifier, password });
    if (!response?.error && response?.token && response?.user) {
      localStorage.setItem("token", response.token);
      localStorage.setItem("edunova:user", JSON.stringify(response.user));
      setToken?.(response.token);
      setUser(response.user);
      setView("home");
    }
    return response;
  };

  return (
    <div className="min-w-0">
      {view === "welcome" && (
        <section className="animate-page-in overflow-hidden rounded-[28px] border border-white/70 bg-white/65 p-4 shadow-[0_24px_70px_rgba(15,23,42,0.09)] backdrop-blur-xl sm:p-6 lg:p-8 dark:border-white/10 dark:bg-slate-950/45">
          <div className="relative overflow-hidden rounded-[22px] bg-slate-950 px-5 py-7 text-white sm:px-8 sm:py-10 lg:px-10">
            <div className="hero-orb hero-orb-one" aria-hidden="true" />
            <div className="hero-orb hero-orb-two" aria-hidden="true" />
            <div className="relative grid gap-9 lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,.82fr)] lg:items-center">
              <div className="max-w-2xl">
                <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-teal-100 backdrop-blur">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-300 shadow-[0_0_10px_#5eead4]" />
                  One focused place to learn and teach
                </div>
                <BrandMark inverse className="mb-6" />
                <h1 className="max-w-xl text-3xl font-bold leading-[1.08] tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                  Make every learning session <span className="text-teal-300">more intentional.</span>
                </h1>
                <p className="mt-5 max-w-xl text-sm leading-6 text-slate-300 sm:text-base sm:leading-7">
                  Bring your timetable, study materials, live classes, and academic support into a calm, connected workspace.
                </p>
                <div className="mt-7 flex flex-wrap gap-3 text-sm text-slate-200">
                  <span className="inline-flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-teal-400/15 text-teal-200">✓</span>Structured study tools</span>
                  <span className="inline-flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-teal-400/15 text-teal-200">✓</span>Live learning spaces</span>
                </div>
              </div>
              <div className="relative mx-auto w-full max-w-md lg:max-w-none">
                <LoginCard onLogin={signIn} />
              </div>
            </div>
          </div>
          <div className="grid gap-3 pt-5 sm:grid-cols-3">
            {[['Organize', 'See what is next without switching contexts.'], ['Learn', 'Keep coursework and resources easy to reach.'], ['Connect', 'Move from timetable to a live class with clarity.']].map(([title, detail]) => (
              <div key={title} className="rounded-2xl border border-slate-100 bg-white/75 p-4 dark:border-white/10 dark:bg-white/5">
                <p className="text-sm font-bold text-slate-800 dark:text-white">{title}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-300">{detail}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {view === "home" && <div className="page page-shell animate-page-in"><HomeView user={user} setView={setView} /></div>}
      {view === "syllabus" && <div className="page page-shell animate-page-in"><SyllabusView user={user} /></div>}
      {view === "study" && <div className="page page-shell animate-page-in"><StudyView user={user} /></div>}
      {view === "live" && <div className="page page-shell animate-page-in"><LiveView user={user} /></div>}
      {view === "contact" && <div className="page page-shell animate-page-in"><ContactView /></div>}
      {view === "ai-assistant" && <div className="page page-shell animate-page-in"><AIChatAssistant user={user} /></div>}
    </div>
  );
}
