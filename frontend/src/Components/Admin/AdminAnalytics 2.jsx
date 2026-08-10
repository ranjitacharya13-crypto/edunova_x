import React, { useEffect, useState } from "react";
import { getAdminAnalytics } from "../../api/api";

function MiniChart({ title, points = [] }) {
  const max = Math.max(1, ...points.map((p) => p.count || 0));
  return (
    <div className="glass-card rounded-xl p-4">
      <h4 className="text-sm font-semibold mb-3">{title}</h4>
      <div className="space-y-2">
        {points.map((p) => (
          <div key={p.label} className="grid grid-cols-[72px_1fr_28px] gap-2 items-center text-xs">
            <span className="text-slate-500">{p.label}</span>
            <div className="h-2 rounded bg-slate-200/60 dark:bg-slate-700/60 overflow-hidden">
              <div
                className="h-full rounded bg-primary"
                style={{ width: `${Math.max(4, (100 * (p.count || 0)) / max)}%` }}
              />
            </div>
            <span className="text-right">{p.count || 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getAdminAnalytics();
        if (cancelled) return;
        setError("");
        setData(result);
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error || err.message || "Failed to load analytics");
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="glass-card p-5">Loading analytics...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <MiniChart title="User Growth" points={data?.userGrowth || []} />
      <MiniChart title="Teacher Growth" points={data?.teacherGrowth || []} />
      <MiniChart title="Classes Per Week" points={data?.classesPerWeek || []} />
      <MiniChart title="Active Users" points={data?.activeUsers || []} />
    </div>
  );
}
