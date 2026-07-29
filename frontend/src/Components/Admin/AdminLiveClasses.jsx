import React, { useEffect, useState } from "react";
import { getAdminLiveClasses } from "../../api/api";

export default function AdminLiveClasses() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getAdminLiveClasses();
        if (cancelled) return;
        setError("");
        setRows(result?.liveClasses || []);
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error || err.message || "Failed to load live classes");
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

  if (loading) return <div className="glass-card p-5">Loading live classes...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="text-base font-semibold mb-4">Live Classes</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Room Name</th>
              <th className="py-2">Teacher</th>
              <th className="py-2">Participants</th>
              <th className="py-2">Date</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._id} className="border-t border-slate-200/40 dark:border-slate-700/40">
                <td className="py-2">{row.roomName}</td>
                <td className="py-2">{row.teacher?.name || "-"}</td>
                <td className="py-2">{row.participantsCount ?? 0}</td>
                <td className="py-2">{row.date ? new Date(row.date).toLocaleString() : "-"}</td>
                <td className="py-2 capitalize">{row.status || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
