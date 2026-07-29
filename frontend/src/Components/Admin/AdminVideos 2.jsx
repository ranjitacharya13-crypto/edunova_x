import React, { useEffect, useState } from "react";
import { deleteAdminVideo, getAdminVideos } from "../../api/api";

export default function AdminVideos() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminVideos();
      setError("");
      setRows(result?.videos || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Failed to load videos");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (id) => {
    const res = await deleteAdminVideo(id);
    if (res?.error) {
      alert(res.error);
      return;
    }
    setRows((prev) => prev.filter((row) => row._id !== id));
  };

  if (loading) return <div className="glass-card p-5">Loading recorded videos...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="text-base font-semibold mb-4">Recorded Videos</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Video Title</th>
              <th className="py-2">Linked Timetable Slot</th>
              <th className="py-2">Teacher</th>
              <th className="py-2">Upload Date</th>
              <th className="py-2">Video</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._id} className="border-t border-slate-200/40 dark:border-slate-700/40">
                <td className="py-2">{row.title}</td>
                <td className="py-2">{row.timetableId || "-"}</td>
                <td className="py-2">{row.teacher?.name || "-"}</td>
                <td className="py-2">{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                <td className="py-2">
                  {row.videoUrl ? (
                    <a className="text-primary underline" href={row.videoUrl} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="py-2">
                  <button
                    onClick={() => handleDelete(row._id)}
                    className="px-2 py-1 rounded-lg bg-rose-500/10 text-rose-600"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
