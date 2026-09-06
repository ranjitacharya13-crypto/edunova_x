import React, { useEffect, useState } from "react";
import { learningRequest } from "../../api/learning";

export default function ProgressView() {
  const [data, setData] = useState(null), [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); learningRequest("/quizzes/progress", { signal: controller.signal }).then(setData).catch((e) => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, []);
  return <section className="space-y-5 rounded-2xl bg-white/90 p-5 shadow-soft dark:bg-slate-900"><header><h2 className="text-xl font-semibold">Your learning progress</h2><p className="text-sm text-slate-500">Based on saved quiz attempts and study history—not estimated grades.</p></header>{error && <p role="alert" className="text-rose-600">{error}</p>}{!data && !error && <p role="status">Loading progress…</p>}
    {data && <><div className="grid gap-3 sm:grid-cols-2">{!data.subjects.length && <p className="text-sm text-slate-500">Complete a quiz to begin tracking subject performance.</p>}{data.subjects.map((s) => <article key={s._id} className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold">{s._id}</h3><p className="text-2xl font-semibold text-teal-700">{Math.round(s.averageScore)}%</p><p className="text-xs text-slate-500">Average across {s.attempts} saved attempts</p></article>)}</div>
      <h3 className="font-semibold">Study plans</h3>{!data.studyPlans.length && <p className="text-sm text-slate-500">Ask EduNova AI to create a plan from your timetable, syllabus and progress.</p>}{data.studyPlans.map((plan) => <article key={plan._id} className="rounded-xl border border-slate-200 p-4"><h4 className="font-semibold">{plan.title}</h4><ul className="mt-2 space-y-2 text-sm">{plan.schedule.map((item, i) => <li key={i}><strong>{item.day} · {item.time}</strong><br />{item.subject}: {item.topic} — {item.task}</li>)}</ul></article>)}
      <h3 className="font-semibold">Recent study sessions</h3>{!data.studyHistory.length && <p className="text-sm text-slate-500">No recorded study sessions yet.</p>}{data.studyHistory.map((item) => <p key={item._id} className="text-sm">{item.subject} · {item.topic} · {item.durationMinutes} min · {item.completed ? "Completed" : "Planned"}</p>)}</>}
  </section>;
}
