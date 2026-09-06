import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { learningRequest } from "../../api/learning";
import { navigateTo } from "../../features/navigation";
import AIChatAssistant from "../AIChatAssistant";
const ARViewer = lazy(() => import("./ARViewer"));

export default function ARLessonView({ lessonId, onExit }) {
  const [lesson, setLesson] = useState(null), [selected, setSelected] = useState("");
  const [error, setError] = useState(""), [prompt, setPrompt] = useState("");
  const aiPanel = useRef(null);
  const onSelect = useCallback((id) => setSelected(id), []);
  useEffect(() => {
    const controller = new AbortController();
    setLesson(null); setError(""); setSelected(""); setPrompt("");
    learningRequest(`/ar/lessons/${encodeURIComponent(lessonId)}`, { signal: controller.signal }).then((data) => setLesson(data.lesson)).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [lessonId]);
  useEffect(() => { if (prompt) aiPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [prompt]);
  const hotspot = lesson?.hotspots.find((h) => h.id === selected);
  return <div className="space-y-5 rounded-2xl bg-white/90 p-4 shadow-soft dark:bg-slate-900 sm:p-6">
    <button type="button" onClick={onExit} className="text-sm text-teal-700 hover:underline">← Exit AR · return to Study Material</button>
    {error && <p role="alert" className="text-rose-600">{error}</p>}
    {!lesson && !error && <p role="status">Loading AR lesson…</p>}
    {lesson && <>
      <header><p className="text-xs font-semibold uppercase tracking-wider text-teal-700">{lesson.subject} / {lesson.topic}</p><h2 className="mt-1 text-2xl font-bold">{lesson.title}</h2><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{lesson.description}</p></header>
      <Suspense fallback={<p role="status">Checking viewer support…</p>}><ARViewer lesson={lesson} selected={selected} onSelect={onSelect} /></Suspense>
      <section><h3 className="font-semibold">Explore the parts</h3><div className="my-3 flex flex-wrap gap-2">{lesson.hotspots.map((h) => <button key={h.id} type="button" aria-pressed={selected === h.id} onClick={() => setSelected(h.id)} className={`rounded-xl border px-4 py-2 text-sm ${selected === h.id ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-200"}`}>{h.label}</button>)}</div>
        <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800"><h4 className="font-semibold">{hotspot?.label || "Select a part"}</h4><p className="mt-1 text-sm leading-6">{hotspot?.description || "Use a label on the model or a button above. All parts remain accessible without a camera or 3D support."}</p></div>
      </section>
      <section><h3 className="font-semibold">Learning objectives</h3><ul className="mt-2 list-inside list-disc space-y-1 text-sm text-slate-600 dark:text-slate-300">{lesson.learningObjectives.map((o) => <li key={o}>{o}</li>)}</ul></section>
      <div className="flex flex-wrap gap-3"><button type="button" onClick={() => setPrompt(hotspot ? `What does the ${hotspot.label} do? Explain it in the context of this lesson.` : `Explain ${lesson.topic} using this AR lesson.`)} className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white">Ask AI about {hotspot?.label || "this object"}</button>
        <button type="button" onClick={() => lesson.quizId ? navigateTo({ view: "quiz", id: lesson.quizId }) : setPrompt(`Create a practice quiz from this AR lesson's learning objectives${hotspot ? `, including ${hotspot.label}` : ""}.`)} className="rounded-xl border border-teal-600 px-5 py-2.5 text-sm font-semibold text-teal-700">Practice Quiz</button></div>
      {prompt && <div ref={aiPanel}><p className="mb-2 text-xs text-slate-500">Only lesson and hotspot identifiers are sent. EduNova resolves the educational context on the server.</p><AIChatAssistant feature="ar" initialPrompt={prompt} applicationContext={{ lessonId: String(lesson._id), hotspotId: selected || undefined }} /></div>}
    </>}
  </div>;
}
