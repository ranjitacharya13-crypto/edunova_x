import React, { useEffect, useState } from "react";
import { learningRequest } from "../../api/learning";
import { navigateTo } from "../../features/navigation";

export default function ARLessonLibrary({ location = "study", materialId }) {
  const [lessons, setLessons] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    learningRequest("/ar/lessons", { signal: controller.signal }).then((data) => {
      setLessons((data.lessons || []).filter((lesson) => !materialId || lesson.materialId === materialId));
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [materialId]);
  return <section aria-label="Interactive topic lessons" className="mt-6 rounded-2xl border border-teal-200 bg-teal-50/50 p-4 dark:border-teal-900 dark:bg-teal-950/20">
    <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Interactive learning</p><h3 className="text-lg font-semibold">Explore a topic in AR</h3></div><span className="text-xs text-slate-500">3D & reading fallback</span></div>
    <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">Select a topic, discover its parts, ask EduNova AI, then practice with a quiz. Camera access is optional.</p>
    {loading && <p role="status">Loading lessons…</p>}
    {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
    {!loading && !error && !lessons.length && <p className="text-sm text-slate-500">No published AR lessons for this material yet.</p>}
    <div className="grid gap-3 sm:grid-cols-2">{lessons.map((lesson) => <article key={lesson._id} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-xs font-semibold text-teal-700">{lesson.subject} / {lesson.topic}</p><h4 className="mt-1 font-semibold">{lesson.title}</h4>
      <p className="mt-2 line-clamp-3 text-sm text-slate-600 dark:text-slate-300">{lesson.description}</p>
      <button type="button" onClick={() => navigateTo({ view: "ar", id: lesson._id })} className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white">{location === "syllabus" ? "Explore in AR" : "View in AR"} →</button>
    </article>)}</div>
  </section>;
}
