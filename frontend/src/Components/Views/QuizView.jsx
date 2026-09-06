import React, { useEffect, useState } from "react";
import { learningRequest } from "../../api/learning";
import { navigateTo } from "../../features/navigation";

export default function QuizView({ quizId }) {
  const [quizzes, setQuizzes] = useState([]), [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState([]), [result, setResult] = useState(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setResult(null); setQuiz(null); setAnswers([]);
    learningRequest(quizId ? `/quizzes/${quizId}` : "/quizzes", { signal: controller.signal }).then((data) => { if (quizId) { setQuiz(data.quiz); setAnswers(Array(data.quiz.questions.length).fill(null)); } else setQuizzes(data.quizzes || []); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [quizId]);
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError("");
    try { setResult(await learningRequest(`/quizzes/${quizId}/attempts`, { method: "POST", body: JSON.stringify({ answers }) })); }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  return <section className="rounded-2xl bg-white/90 p-5 shadow-soft dark:bg-slate-900">
    <h2 className="text-xl font-semibold">{quiz?.title || "Practice quizzes"}</h2>
    <p className="mt-1 text-sm text-slate-500">Your answers are graded and saved on the server, then used by EduNova AI to guide your study.</p>
    {error && <p role="alert" className="mt-4 text-rose-600">{error}</p>}{loading && <p role="status" className="mt-4">Loading quizzes…</p>}
    {!quizId && !loading && <div className="mt-4 space-y-3">{!quizzes.length && <p>No quizzes yet. Ask EduNova AI to create one from a class or explore an AR lesson.</p>}{quizzes.map((q) => <button key={q._id} type="button" onClick={() => navigateTo({ view: "quiz", id: q._id })} className="block w-full rounded-xl border border-slate-200 p-4 text-left"><span className="block font-semibold">{q.title}</span><span className="text-sm text-slate-500">{q.subject || q.topic || "Course quiz"} →</span></button>)}</div>}
    {quiz && !result && <form onSubmit={submit} className="mt-6 space-y-6">{quiz.questions.map((question, i) => <fieldset key={i}><legend className="mb-2 font-medium">{i + 1}. {question.question}</legend>{question.options.map((option, j) => <label key={j} className="my-2 flex cursor-pointer gap-3 rounded-xl border border-slate-200 p-3 text-sm"><input type="radio" name={`q-${i}`} checked={answers[i] === j} onChange={() => setAnswers((prev) => prev.map((v, n) => n === i ? j : v))} required />{option}</label>)}</fieldset>)}<button disabled={saving || answers.some((a) => a === null)} className="rounded-xl bg-primary px-5 py-3 text-white disabled:opacity-50">{saving ? "Saving attempt…" : "Submit quiz"}</button></form>}
    {result && <div className="mt-5 space-y-3"><p className="text-xl font-semibold">{result.score}% · {result.correctAnswers}/{result.totalQuestions} correct</p>{result.answers.map((a, i) => <div key={i} className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800"><p className="font-medium">{a.isCorrect ? "✓" : "✗"} {a.question}</p><p>Your answer: {a.selectedOption}</p>{!a.isCorrect && <p>Correct answer: {a.correctOption}</p>}</div>)}<button type="button" className="text-primary underline" onClick={() => navigateTo({ view: "progress" })}>View my progress →</button></div>}
  </section>;
}
