import React, { useEffect, useState } from "react";
import { getAdminDashboard } from "../../api/api";

const STAT_ITEMS = [
  { key: "totalUsers", label: "Total Users" },
  { key: "totalStudents", label: "Total Students" },
  { key: "totalTeachers", label: "Total Teachers" },
  { key: "totalTimetables", label: "Total Timetables" },
  { key: "totalLiveClasses", label: "Total Live Classes" },
  { key: "totalRecordedVideos", label: "Total Recorded Videos" },
  { key: "totalAssignments", label: "Total Assignments" },
  { key: "totalMessages", label: "Total Messages" },
];

export default function AdminOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem("token");

    const load = async () => {
      const res = await getAdminDashboard(token);
      if (cancelled) return;
      if (res?.error) setError(res.error);
      else setData(res);
      setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="glass-card p-5">Loading overview...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {STAT_ITEMS.map((item) => (
          <div key={item.key} className="glass-card rounded-xl p-4">
            <div className="text-xs text-slate-500">{item.label}</div>
            <div className="text-2xl font-semibold mt-1">{data?.[item.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="glass-card rounded-xl p-5">
        <h3 className="text-base font-semibold mb-3">Recent Activity</h3>
        {(data?.recentActivity || []).length === 0 ? (
          <p className="text-sm text-slate-500">No recent activity found.</p>
        ) : (
          <div className="space-y-2">
            {(data?.recentActivity || []).map((item, idx) => (
              <div
                key={`${item.type}_${item.createdAt}_${idx}`}
                className="rounded-xl bg-white/50 dark:bg-slate-900/40 border border-white/40 dark:border-slate-700 px-3 py-2"
              >
                <div className="text-sm font-medium">{item.title}</div>
                <div className="text-xs text-slate-500">
                  {item.type.replace("_", " ")} |{" "}
                  {item.createdAt ? new Date(item.createdAt).toLocaleString() : "Unknown time"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
