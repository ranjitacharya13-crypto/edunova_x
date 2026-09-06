import React, { useState, useEffect } from "react";
import { apiUrl } from "../../api/api";

import ARLessonLibrary from "../AR/ARLessonLibrary";
import { navigateTo } from "../../features/navigation";

const API = apiUrl("");

export default function StudyView({ user }) {
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeVideoId, setActiveVideoId] = useState(null);

  // FETCH FILES
  const fetchFiles = async () => {
    try {
      const res = await fetch(`${API}/study`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) throw new Error(data.error || "Materials could not be loaded");
      setFiles(data);
      setFetchError("");
    } catch (err) {
      setFetchError(err.message);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  // UPLOAD (TEACHER / ADMIN)
  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file) return alert("Please select a file");

    setLoading(true);
    const token = localStorage.getItem("token");

    const form = new FormData();
    form.append("file", file);
    form.append("subject", subject);
    form.append("topic", topic);

    try {
      const res = await fetch(`${API}/study`, {
        method: "POST",
        body: form,
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
        },
      });

      if (res.ok) {
        alert("File uploaded successfully!");
        setFile(null);
        fetchFiles();
      } else {
        alert("Upload failed");
      }
    } catch (err) {
      alert("Upload error");
    } finally {
      setLoading(false);
    }
  };

  // PREVIEW
  const isVideoFile = (item) => {
    if (item?.contentType?.startsWith("video/")) return true;
    return /\.(mp4|webm|mov|mkv)$/i.test(item?.filename || "");
  };

  const handlePreview = (item) => {
    if (isVideoFile(item)) {
      setActiveVideoId((prev) => (prev === item._id ? null : item._id));
      return;
    }

    const name = encodeURIComponent(item.filename || "file");
    window.open(`${API}/study/${item._id}/preview?name=${name}`, "_blank");
  };

  const handleDownload = (item) => {
    const name = encodeURIComponent(item.filename || "file");
    window.open(`${API}/study/${item._id}/download?name=${name}`, "_blank");
  };

  return (
    <div className="bg-white/80 backdrop-blur-md rounded-2xl p-4 sm:p-6 shadow-soft">
      <h2 className="text-xl font-semibold text-center mb-6">
        Study Materials
      </h2>

      {/* UPLOAD — TEACHER / ADMIN ONLY */}
      {(user?.role === "teacher" || user?.role === "admin") && (
        <div className="mb-6 bg-white rounded-2xl p-5 shadow-soft">
          <h4 className="text-sm font-medium mb-3">
            Upload Study Material (PDF / Image / Video)
          </h4>

          <form onSubmit={handleUpload} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={100} placeholder="e.g. Physics" className="mt-1 w-full rounded-lg border p-2" /></label><label className="text-sm">Topic<input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder="e.g. Human Eye" className="mt-1 w-full rounded-lg border p-2" /></label></div>
            <input
              type="file"
              accept=".pdf,image/*,video/*"
              onChange={(e) => setFile(e.target.files[0])}
              className="w-full text-sm
                file:mr-4 file:py-2 file:px-4
                file:rounded-xl file:border-0
                file:bg-primary/10 file:text-primary
                hover:file:bg-primary/20"
            />

            <button
              type="submit"
              disabled={loading}
              className="px-6 py-2 rounded-xl
                bg-primary text-white text-sm shadow"
            >
              {loading ? "Uploading..." : "Upload"}
            </button>
          </form>
        </div>
      )}

      {fetchError && <p role="alert" className="mb-3 text-sm text-rose-600">{fetchError}</p>}
      {/* FILE LIST — STUDENT + TEACHER */}
      <div className="bg-white rounded-2xl p-5 shadow-soft">
        <h4 className="font-medium mb-3">
          Available Study Materials
        </h4>

        {files.length === 0 ? (
          <p className="text-sm text-slate-500">
            No study materials available yet.
          </p>
        ) : (
          <ul className="divide-y">
            {files.map((f) => (
              <li
                key={f._id}
                className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm text-slate-700 break-words whitespace-normal sm:flex-1 sm:min-w-0 sm:truncate sm:whitespace-nowrap">
                  {f.filename}
                </span>

                <div className="flex items-center gap-4">
                  <button
                    onClick={() => handlePreview(f)}
                    className="text-sm text-primary hover:underline"
                  >
                    {isVideoFile(f) ? "Play" : "Preview"}
                  </button>
                  <button
                    onClick={() => handleDownload(f)}
                    className="text-sm text-slate-500 hover:underline"
                  >
                    Download
                  </button>
                </div>

                {isVideoFile(f) && activeVideoId === f._id && (
                  <div className="w-full mt-2">
                    <video
                      className="w-full rounded-xl bg-black"
                      src={`${API}/study/${f._id}/preview?name=${encodeURIComponent(
                        f.filename || "video"
                      )}`}
                      controls
                      playsInline
                      preload="metadata"
                    />
                    <p className="text-xs text-slate-500 mt-2">
                      If playback fails, use Download to open in your device player.
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {user && user.role !== "guest" && <>
        <ARLessonLibrary location="study" />
        <div className="mt-5 flex flex-wrap gap-4 text-sm"><button type="button" onClick={() => navigateTo({ view: "quiz" })} className="text-primary underline">Practice quizzes</button><button type="button" onClick={() => navigateTo({ view: "progress" })} className="text-primary underline">Progress & study plans</button></div>
      </>}
    </div>
  );
}
