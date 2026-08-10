import React, { useState } from "react";
import { registerUser } from "../api/api";
import BrandMark from "./BrandMark";

export default function RegisterWizard({ onComplete, onBack }) {
  const [form, setForm] = useState({ name: "", dob: "", gender: "", username: "", email: "", password: "", role: "student" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  const input = "mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:ring-4 focus:ring-teal-400/10 dark:border-white/10 dark:bg-white/5 dark:text-white";

  const submit = async (event) => {
    event.preventDefault(); setError("");
    if (!form.username.trim() || !form.email.trim() || !form.password) { setError("Username, email, and password are required."); return; }
    setLoading(true);
    try {
      const result = await registerUser(form);
      if (result?.error) { setError(result.error); return; }
      await onComplete?.(result, form.password);
    } catch { setError("Unable to create your account right now. Please try again."); }
    finally { setLoading(false); }
  };

  return (
    <div className="w-full rounded-2xl border border-white/20 bg-white/95 p-5 text-slate-900 shadow-[0_24px_60px_rgba(2,6,23,0.28)] backdrop-blur-xl sm:p-6 dark:bg-slate-950/90 dark:text-white">
      <BrandMark className="mb-5" /><h2 className="text-xl font-bold">Create your account</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-300">Choose a learner or teacher workspace.</p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Full name<input name="name" value={form.name} onChange={update} placeholder="Your name" className={input} /></label><label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Date of birth<input type="date" name="dob" value={form.dob} onChange={update} className={input} /></label></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Role<select name="role" value={form.role} onChange={update} className={input}><option value="student">Student</option><option value="teacher">Teacher</option></select></label><label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Gender <span className="font-normal text-slate-400">(optional)</span><select name="gender" value={form.gender} onChange={update} className={input}><option value="">Select</option><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option></select></label></div>
        <label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Username<input required name="username" autoComplete="username" value={form.username} onChange={update} placeholder="Choose a username" className={input} /></label>
        <label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Email address<input required type="email" name="email" autoComplete="email" value={form.email} onChange={update} placeholder="you@example.com" className={input} /></label>
        <label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Password<input required minLength="6" type="password" name="password" autoComplete="new-password" value={form.password} onChange={update} placeholder="At least 6 characters" className={input} /></label>
        <div className="flex gap-3 pt-2"><button type="submit" disabled={loading} className="min-h-11 flex-1 rounded-xl bg-teal-700 px-4 text-sm font-bold text-white transition hover:bg-teal-600 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{loading ? "Creating…" : "Create account"}</button><button type="button" onClick={onBack} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-600 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5">Back</button></div>
      </form>
    </div>
  );
}
