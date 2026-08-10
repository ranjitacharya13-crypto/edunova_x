import React, { useEffect, useState } from "react";
import { getAdminAssignments } from "../../api/api";

export default function AdminAssignments() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getAdminAssignments();
        if (cancelled) return;
        setError("");
        setRows(result?.assignments || []);
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error || err.message || "Failed to load assignments");
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="glass-card p-5">Loading assignments...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="text-base font-semibold mb-4">Assignments</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Class Name</th>
              <th className="py-2">Teacher</th>
              <th className="py-2">Submission Count</th>
              <th className="py-2">Due Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._id} className="border-t border-slate-200/40 dark:border-slate-700/40">
                <td className="py-2">{row.className || "-"}</td>
                <td className="py-2">{row.teacher || "-"}</td>
                <td className="py-2">{row.submissionCount ?? 0}</td>
                <td className="py-2">{row.dueDate ? new Date(row.dueDate).toLocaleDateString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
