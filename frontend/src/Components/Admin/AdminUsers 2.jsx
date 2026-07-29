import React, { useEffect, useState } from "react";
import { deleteAdminUser, getAdminUsers, toggleAdminUserBlock } from "../../api/api";

export default function AdminUsers({ roleFilter = "" }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminUsers(roleFilter);
      setError("");
      setUsers(result?.users || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Failed to load users");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [roleFilter]);

  const handleDelete = async (id) => {
    const res = await deleteAdminUser(id);
    if (res?.error) {
      alert(res.error);
      return;
    }
    setUsers((prev) => prev.filter((u) => u._id !== id));
  };

  const handleToggleBlock = async (user) => {
    const res = await toggleAdminUserBlock(user._id, !user.isBlocked);
    if (res?.error) {
      alert(res.error);
      return;
    }
    setUsers((prev) =>
      prev.map((u) => (u._id === user._id ? { ...u, isBlocked: res.user?.isBlocked ?? !u.isBlocked } : u))
    );
  };

  if (loading) return <div className="glass-card p-5">Loading users...</div>;
  if (error) return <div className="glass-card p-5 text-rose-500">{error}</div>;

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="text-base font-semibold mb-4">Users</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Name</th>
              <th className="py-2">Email</th>
              <th className="py-2">Role</th>
              <th className="py-2">Created At</th>
              <th className="py-2">Status</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u._id} className="border-t border-slate-200/40 dark:border-slate-700/40">
                <td className="py-2">{u.name || "-"}</td>
                <td className="py-2">{u.email}</td>
                <td className="py-2 capitalize">{u.role}</td>
                <td className="py-2">{u.createdAt ? new Date(u.createdAt).toLocaleString() : "-"}</td>
                <td className="py-2">{u.isBlocked ? "Blocked" : "Active"}</td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggleBlock(u)}
                      className="px-2 py-1 rounded-lg bg-primary/10 text-primary"
                    >
                      {u.isBlocked ? "Unblock" : "Block"}
                    </button>
                    <button
                      onClick={() => handleDelete(u._id)}
                      disabled={u.role === "admin"}
                      className="px-2 py-1 rounded-lg bg-rose-500/10 text-rose-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
