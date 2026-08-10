import React, { useState } from "react";
import { API } from "../../api/api";

export default function ContactView() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const handleSend = async (event) => {
    event.preventDefault(); setSuccess(""); setError("");
    const payload = { name: name.trim(), email: email.trim(), message: message.trim() };
    if (!payload.name || !payload.email || !payload.message) { setError("Please complete your name, email, and message."); return; }
    setLoading(true);
    try {
      const response = await API.post("/contact", payload);
      if (!response.data?.success) throw new Error(response.data?.message || "Unable to send message");
      setSuccess("Your message has been sent. The EduNova team will review it."); setName(""); setEmail(""); setMessage("");
    } catch (requestError) { setError(requestError.response?.data?.message || requestError.message || "Unable to send your message right now."); }
    finally { setLoading(false); }
  };

  const inputClass = "mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 hover:border-teal-300 focus:border-teal-500 focus:ring-4 focus:ring-teal-400/10 dark:border-white/10 dark:bg-white/5 dark:text-white";
  return (
    <section className="space-y-5" aria-labelledby="contact-title">
      <header className="rounded-3xl border border-white/70 bg-gradient-to-br from-white/90 to-cyan-50/70 p-5 shadow-soft sm:p-6 dark:border-white/10 dark:from-slate-950/70 dark:to-cyan-500/10"><p className="text-xs font-bold uppercase tracking-[.14em] text-teal-700 dark:text-teal-300">Support</p><h2 id="contact-title" className="mt-1 text-2xl font-bold tracking-[-.035em] text-slate-900 dark:text-white">How can we help?</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">Send a clear message and the team can follow up using the email you provide.</p></header>
      <div className="grid gap-5 lg:grid-cols-[.72fr_1.28fr]">
        <aside className="glass-card p-5"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-50 text-teal-700 dark:bg-teal-400/10 dark:text-teal-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg></div><h3 className="mt-4 font-bold text-slate-800 dark:text-white">Contact EduNova</h3><p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-300">For access, platform, or learning questions, use the form or email the support address.</p><a href="mailto:ranjit5201314@gmail.com" className="mt-5 inline-flex rounded-lg text-sm font-bold text-teal-700 underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-teal-300">ranjit5201314@gmail.com</a></aside>
        <form onSubmit={handleSend} className="glass-card p-5 sm:p-6">
          {success && <p role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200">{success}</p>}
          {error && <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
          <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Your name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter your name" className={inputClass} /></label><label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">Email address<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className={inputClass} /></label></div>
          <label className="mt-4 block text-sm font-semibold text-slate-700 dark:text-slate-200">How can we help?<textarea required rows="6" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Tell us what you need help with…" className={`${inputClass} resize-y`} /></label>
          <button type="submit" disabled={loading} className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-700 px-5 text-sm font-bold text-white transition hover:-translate-y-0.5 hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{loading ? "Sending…" : "Send message"}</button>
        </form>
      </div>
    </section>
  );
}
