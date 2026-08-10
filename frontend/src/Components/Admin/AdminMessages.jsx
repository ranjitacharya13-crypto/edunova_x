import React, { useEffect, useState } from "react";
import { deleteAdminMessage, getAdminMessages } from "../../api/api";

export default function AdminMessages() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminMessages();
      setError("");
      setRows(result?.messages || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Failed to load messages");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (id) => {
    const res = await deleteAdminMessage(id);
    if (res?.error) {
      alert(res.error);
      return;
    }
    setRows((prev) => prev.filter((msg) => msg._id !== id));
  };

  if (loading) return <div className="glass-card p-5">Loading messages...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="text-base font-semibold mb-4">Messages</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Name</th>
              <th className="py-2">Email</th>
              <th className="py-2">Message</th>
              <th className="py-2">Date</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._id} className="border-t border-slate-200/40 dark:border-slate-700/40">
                <td className="py-2">{row.name}</td>
                <td className="py-2">{row.email}</td>
                <td className="py-2 max-w-[240px] sm:max-w-[360px]">
                  <div className="line-clamp-2">{row.message}</div>
                </td>
                <td className="py-2">{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
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
