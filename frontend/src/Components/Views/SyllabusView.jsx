import React, { useCallback, useEffect, useState } from "react";
import { API, apiUrl } from "../../api/api";

function SyllabusIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true"><path d="M5 3.5h12.5A1.5 1.5 0 0 1 19 5v15H6.5A2.5 2.5 0 0 0 4 22.5v-17A2 2 0 0 1 6 3.5Z" /><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H19M8 7h7M8 11h7" /></svg>;
}

export default function SyllabusView({ user }) {
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canUpload = user?.role === "teacher" || user?.role === "admin";

  const fetchFiles = useCallback(async () => {
    setLoading(true); setError("");
    try { const response = await API.get("/syllabus"); setFiles(Array.isArray(response.data) ? response.data : []); }
    catch (requestError) { setError(requestError.response?.data?.error || "Syllabus resources could not be loaded. Please retry."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  const handleUpload = async (event) => {
    event.preventDefault(); setNotice("");
    if (!file) { setError("Choose a syllabus file before uploading."); return; }
    setUploading(true); setError("");
    const form = new FormData(); form.append("file", file);
    try {
      await API.post("/syllabus", form);
      setFile(null); const input = document.getElementById("syllabus-file"); if (input) input.value = "";
      setNotice("Syllabus resource uploaded successfully."); await fetchFiles();
    } catch (requestError) { setError(requestError.response?.data?.error || "Upload failed. Please try again."); }
    finally { setUploading(false); }
  };
  const previewUrl = (item) => apiUrl(`/syllabus/${item._id}/preview?name=${encodeURIComponent(item.filename || "syllabus-file")}`);

  return (
    <section className="space-y-5" aria-labelledby="syllabus-title">
      <header className="flex flex-col gap-4 rounded-3xl border border-white/70 bg-gradient-to-br from-white/90 to-amber-50/60 p-5 shadow-soft sm:flex-row sm:items-end sm:justify-between sm:p-6 dark:border-white/10 dark:from-slate-950/70 dark:to-amber-400/5">
        <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700 dark:text-teal-300">Course foundation</p><h2 id="syllabus-title" className="mt-1 text-2xl font-bold tracking-[-.035em] text-slate-900 dark:text-white">Syllabus resources</h2><p className="mt-2 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">Keep the curriculum clear, current, and easy to open from any device.</p></div>
        <button type="button" onClick={fetchFiles} disabled={loading} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-teal-200 bg-white/80 px-4 text-sm font-bold text-teal-800 transition hover:bg-teal-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-teal-400/20 dark:bg-white/5 dark:text-teal-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.5M20 4v7h-7" /></svg>Refresh</button>
      </header>
      {canUpload && <form onSubmit={handleUpload} className="glass-card p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-bold text-slate-800 dark:text-white">Upload a syllabus resource</h3><p className="mt-1 text-sm text-slate-500 dark:text-slate-300">Add a PDF, image, or video for learners and teachers.</p></div><div className="flex flex-col gap-2 sm:flex-row"><label htmlFor="syllabus-file" className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800 dark:border-white/10 dark:bg-white/5 dark:text-slate-100">{file ? file.name : "Choose file"}</label><input id="syllabus-file" type="file" accept=".pdf,image/*,video/*" onChange={(event) => setFile(event.target.files?.[0] || null)} className="sr-only" /><button type="submit" disabled={uploading || !file} className="min-h-10 rounded-xl bg-teal-700 px-4 text-sm font-bold text-white transition hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-55 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{uploading ? "Uploading…" : "Upload"}</button></div></div></form>}
      {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200">{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
      <div className="glass-card overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-white/10"><h3 className="font-bold text-slate-800 dark:text-white">Available syllabus files</h3><span className="text-xs font-semibold text-slate-400">{files.length} item{files.length === 1 ? "" : "s"}</span></div>{loading ? <div className="space-y-3 p-5"><div className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" /><div className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" /></div> : files.length === 0 ? <div className="px-5 py-14 text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200"><SyllabusIcon /></div><p className="mt-4 text-sm font-bold text-slate-700 dark:text-white">No syllabus files yet</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-300">Resources shared by your school will appear here.</p></div> : <ul className="divide-y divide-slate-100 dark:divide-white/10">{files.map((item) => <li key={item._id} className="flex flex-col gap-3 p-4 transition hover:bg-teal-50/55 sm:flex-row sm:items-center dark:hover:bg-white/5"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200"><SyllabusIcon /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800 dark:text-white">{item.filename || "Untitled syllabus resource"}</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-300">{item.contentType?.includes("pdf") ? "PDF document" : "Syllabus resource"}</p></div><a href={previewUrl(item)} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center justify-center rounded-lg bg-teal-700 px-3 text-xs font-bold text-white transition hover:bg-teal-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">Open resource</a></li>)}</ul>}</div>
    </section>
  );
}
