import React, { useState } from "react";
import RegisterWizard from "./RegisterWizard";
import BrandMark from "./BrandMark";

function MailIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
}
function LockIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}

export default function LoginCard({ onLogin }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  if (showRegister) {
    return (
      <RegisterWizard
        onBack={() => setShowRegister(false)}
        onComplete={async (registered, createdPassword) => {
          const result = await onLogin(registered?.user?.email || identifier, createdPassword);
          if (result?.error) setError(result.error);
        }}
      />
    );
  }

  const handleLogin = async (event) => {
    event.preventDefault();
    const cleanIdentifier = identifier.trim();
    setError("");
    if (!cleanIdentifier || !password) {
      setError("Enter your email or username and password.");
      return;
    }
    setLoading(true);
    try {
      const result = await onLogin(cleanIdentifier, password);
      if (result?.error) setError(result.error);
    } catch {
      setError("We could not reach EduNova. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "peer block w-full rounded-xl border border-slate-200 bg-white/90 py-3 pl-11 pr-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-teal-300 focus:border-teal-500 focus:ring-4 focus:ring-teal-400/15 dark:border-white/10 dark:bg-slate-900/75 dark:text-white dark:placeholder:text-slate-500 dark:hover:border-teal-300/60";

  return (
    <div className="w-full rounded-2xl border border-white/20 bg-white/95 p-5 text-slate-900 shadow-[0_24px_60px_rgba(2,6,23,0.28)] backdrop-blur-xl sm:p-6 dark:bg-slate-950/90 dark:text-white">
      <BrandMark className="mb-5" />
      <h2 className="text-xl font-bold tracking-[-0.025em]">Welcome back</h2>
      <p className="mt-1 text-sm leading-5 text-slate-500 dark:text-slate-300">Sign in to continue your learning journey.</p>

      <form onSubmit={handleLogin} className="mt-5 space-y-4" noValidate>
        {error && (
          <div role="alert" className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm leading-5 text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
            <span>{error}</span>
          </div>
        )}
        <div>
          <label htmlFor="login-identifier" className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-200">Email or username</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-0 grid w-11 place-items-center text-slate-400"><span className="h-4 w-4"><MailIcon /></span></span>
            <input id="login-identifier" name="identifier" type="text" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="you@example.com" className={inputClass} disabled={loading} />
          </div>
        </div>
        <div>
          <label htmlFor="login-password" className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-200">Password</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-0 grid w-11 place-items-center text-slate-400"><span className="h-4 w-4"><LockIcon /></span></span>
            <input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className={`${inputClass} pr-12`} disabled={loading} />
            <button type="button" onClick={() => setShowPassword((visible) => !visible)} className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-xs font-semibold text-teal-700 hover:text-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-teal-300" aria-label={showPassword ? "Hide password" : "Show password"}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <button type="submit" disabled={loading} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-700 to-teal-500 px-4 text-sm font-bold text-white shadow-[0_12px_25px_rgba(13,148,136,0.28)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_30px_rgba(13,148,136,0.34)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-65 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:ring-offset-2">
          {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />}
          {loading ? "Signing in…" : "Sign in securely"}
        </button>
      </form>

      <div className="my-5 h-px bg-slate-200 dark:bg-white/10" />
      <button type="button" onClick={() => setShowRegister(true)} className="min-h-10 w-full rounded-xl border border-teal-200 bg-teal-50 px-4 text-sm font-bold text-teal-800 transition hover:bg-teal-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200 dark:hover:bg-teal-400/15">
        Create an account
      </button>
    </div>
  );
}
