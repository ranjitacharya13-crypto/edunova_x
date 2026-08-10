import React, { useEffect, useState } from "react";
import { deleteAdminTimetable, getAdminTimetables } from "../../api/api";

export default function AdminTimetables() {
  const [teacher, setTeacher] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async (teacherFilter = "") => {
    setLoading(true);
    try {
      const result = await getAdminTimetables(teacherFilter);
      setError("");
      setRows(result?.timetables || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Failed to load timetables");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (type, id) => {
    const res = await deleteAdminTimetable(type, id);
    if (res?.error) {
      alert(res.error);
      return;
    }
    setRows((prev) => prev.filter((r) => r._id !== id));
  };

  if (loading) return <div className="glass-card p-5">Loading timetables...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="glass-card rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <h3 className="text-base font-semibold">Timetables</h3>
        <div className="flex gap-2">
          <input
            value={teacher}
            onChange={(e) => setTeacher(e.target.value)}
            placeholder="Filter by teacher/class"
            className="px-3 py-2 rounded-xl border border-slate-200/50 bg-white/70 dark:bg-slate-900/40"
          />
          <button onClick={() => load(teacher)} className="px-3 py-2 rounded-xl bg-primary text-white">
            Filter
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Type</th>
              <th className="py-2">Identifier</th>
              <th className="py-2">Created At</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t._id} className="border-t border-slate-200/40 dark:border-slate-700/40">
                <td className="py-2 capitalize">{t.type}</td>
                <td className="py-2">{t._id}</td>
                <td className="py-2">{t.createdAt ? new Date(t.createdAt).toLocaleString() : "-"}</td>
                <td className="py-2">
                  <button
                    onClick={() => handleDelete(t.type, t._id)}
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
