import React, { useCallback, useEffect, useState } from "react";
import { API, apiUrl } from "../../api/api";

function FileIcon({ video }) {
  return video ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3Z" /></svg>
  ) : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true"><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5M9 12h6M9 16h6" /></svg>;
}

export default function StudyView({ user }) {
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeVideoId, setActiveVideoId] = useState(null);
  const canUpload = user?.role === "teacher" || user?.role === "admin";

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await API.get("/study");
      setFiles(Array.isArray(response.data) ? response.data : []);
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Study materials could not be loaded. Please retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  const isVideoFile = (item) => item?.contentType?.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(item?.filename || "");
  const formatBytes = (value) => {
    const bytes = Number(value || 0);
    if (!bytes) return "File";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    setNotice("");
    if (!file) { setError("Choose a file before uploading."); return; }
    setUploading(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      await API.post("/study", form);
      setFile(null);
      const input = document.getElementById("study-file");
      if (input) input.value = "";
      setNotice("Study material uploaded successfully.");
      await fetchFiles();
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Upload failed. Please try again.");
    } finally { setUploading(false); }
  };

  const fileUrl = (item, action = "preview") => apiUrl(`/study/${item._id}/${action}?name=${encodeURIComponent(item.filename || "file")}`);

  return (
    <section className="space-y-5" aria-labelledby="study-title">
      <header className="flex flex-col gap-4 rounded-3xl border border-white/70 bg-gradient-to-br from-white/90 to-teal-50/65 p-5 shadow-soft sm:flex-row sm:items-end sm:justify-between sm:p-6 dark:border-white/10 dark:from-slate-950/70 dark:to-teal-500/10">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700 dark:text-teal-300">Learning library</p>
          <h2 id="study-title" className="mt-1 text-2xl font-bold tracking-[-.035em] text-slate-900 dark:text-white">Study materials</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">Open resources when you need them, or add a new item for your class.</p>
        </div>
        <button type="button" onClick={fetchFiles} disabled={loading} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-teal-200 bg-white/80 px-4 text-sm font-bold text-teal-800 transition hover:bg-teal-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-teal-400/20 dark:bg-white/5 dark:text-teal-200">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.5M20 4v7h-7" /></svg> Refresh
        </button>
      </header>

      {canUpload && (
        <form onSubmit={handleUpload} className="glass-card p-5" aria-label="Upload study material">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div><h3 className="font-bold text-slate-800 dark:text-white">Add a resource</h3><p className="mt-1 text-sm text-slate-500 dark:text-slate-300">PDF, image, or video files are supported.</p></div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="study-file" className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800 dark:border-white/10 dark:bg-white/5 dark:text-slate-100">{file ? file.name : "Choose file"}</label>
              <input id="study-file" type="file" accept=".pdf,image/*,video/*" onChange={(event) => setFile(event.target.files?.[0] || null)} className="sr-only" />
              <button type="submit" disabled={uploading || !file} className="min-h-10 rounded-xl bg-teal-700 px-4 text-sm font-bold text-white transition hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-55 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{uploading ? "Uploading…" : "Upload"}</button>
            </div>
          </div>
        </form>
      )}

      {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200">{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}

      <div className="glass-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-white/10"><h3 className="font-bold text-slate-800 dark:text-white">Available materials</h3><span className="text-xs font-semibold text-slate-400">{files.length} item{files.length === 1 ? "" : "s"}</span></div>
        {loading ? <div className="space-y-3 p-5"><div className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" /><div className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" /></div>
          : files.length === 0 ? <div className="px-5 py-14 text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-teal-50 text-teal-700 dark:bg-teal-400/10 dark:text-teal-200"><FileIcon /></div><p className="mt-4 text-sm font-bold text-slate-700 dark:text-white">No study materials yet</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-300">New resources will appear here when they are available.</p></div>
          : <ul className="divide-y divide-slate-100 dark:divide-white/10">{files.map((item) => { const video = isVideoFile(item); return <li key={item._id} className="p-4 transition hover:bg-teal-50/55 dark:hover:bg-white/5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700 dark:bg-teal-400/10 dark:text-teal-200"><FileIcon video={video} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800 dark:text-white">{item.filename || "Untitled resource"}</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-300">{video ? "Video" : item.contentType?.includes("pdf") ? "PDF document" : "Resource"} · {formatBytes(item.length)}</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => video ? setActiveVideoId((id) => id === item._id ? null : item._id) : window.open(fileUrl(item), "_blank", "noopener,noreferrer")} className="min-h-9 rounded-lg bg-teal-700 px-3 text-xs font-bold text-white transition hover:bg-teal-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{video ? activeVideoId === item._id ? "Close" : "Play" : "Preview"}</button><a href={fileUrl(item, "download")} className="inline-flex min-h-9 items-center rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 transition hover:border-teal-300 hover:text-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-white/10 dark:text-slate-200">Download</a></div></div>{video && activeVideoId === item._id && <video className="mt-4 w-full rounded-xl bg-black" src={fileUrl(item)} controls playsInline preload="metadata" />}</li>; })}</ul>}
      </div>
    </section>
  );
}
