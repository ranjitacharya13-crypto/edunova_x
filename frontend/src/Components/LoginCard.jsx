import React, { useEffect, useState } from "react";
import RegisterWizard from "./RegisterWizard";

export default function LoginCard({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [showRegister, setShowRegister] = useState(false);

  // Countdown for rate-limit (429) lockouts: the button stays disabled with
  // a visible "try again in Xs" label until the backend allows a retry.
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  if (showRegister) {
    return <RegisterWizard onBack={() => setShowRegister(false)} />;
  }

  const DEMO_STUDENT_EMAIL = "student@edunova.demo";
  const DEMO_STUDENT_PASSWORD = "Student@12345";

  // Single login path for manual + demo sign-in.
  //
  // Guarantees:
  // - `finally` ALWAYS resets `loading`, so the button can never get stuck
  //   on "Signing in..." — even if onLogin throws (e.g. localStorage
  //   unavailable in private browsing) or the request times out.
  // - Duplicate submissions are ignored while a request is in flight.
  // - Rate-limit responses surface a countdown instead of a dead button.
  const runLogin = async (emailValue, passwordValue) => {
    if (loading || retryAfter > 0) return;
    setError("");
    setLoading(true);
    try {
      const res = await onLogin(emailValue, passwordValue);
      if (res?.error) {
        setError(res.error);
        if (Number(res.retryAfterSeconds) > 0) {
          setRetryAfter(Number(res.retryAfterSeconds));
        }
        return;
      }
      // Success: Dashboard navigates to the home view; nothing to reset.
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = (event) => {
    if (event) event.preventDefault();
    runLogin(email, password);
  };

  // Demo login goes through the exact same real authentication API as a
  // manual login — no bypass, no direct navigation to the dashboard.
  const handleDemoStudentLogin = () => {
    runLogin(DEMO_STUDENT_EMAIL, DEMO_STUDENT_PASSWORD);
  };

  const locked = loading || retryAfter > 0;
  const submitLabel = retryAfter > 0
    ? `Try again in ${retryAfter}s`
    : loading
      ? "Signing in..."
      : "Sign In";

  return (
    <div className="w-full max-w-md mx-auto glass-card p-6">
      <h2 className="text-xl font-semibold mb-1">Sign in</h2>
      <p className="text-sm text-slate-500 mb-4">
        Login to continue to EduNova
      </p>

      {error && (
        <div className="mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {/* A real form (submit handler preserved): fixes the browser
          "[DOM] Password field is not contained in a form" warning and lets
          Enter submit, with identical styling, autocomplete and auth flow. */}
      <form onSubmit={handleLogin} noValidate>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="w-full mb-3 px-4 py-3 rounded-xl border border-white/40 bg-white/60 backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />

        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          className="w-full mb-4 px-4 py-3 rounded-xl border border-white/40 bg-white/60 backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />

        <button
          type="submit"
          disabled={locked}
          className="w-full bg-primary text-white py-3 rounded-xl font-medium disabled:opacity-60"
        >
          {submitLabel}
        </button>
      </form>

      <button
        onClick={() => setShowRegister(true)}
        className="w-full mt-4 text-primary border border-primary/30 bg-white/40 backdrop-blur-md py-2.5 rounded-xl hover:bg-white/60 transition"
      >
        Create Account
      </button>

      {/* ─────────── Demo Account ─────────── */}
      <div className="mt-5">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="flex-1 h-px bg-slate-300/60" />
          <span className="text-xs font-medium uppercase tracking-wide">
            Demo Account
          </span>
          <span className="flex-1 h-px bg-slate-300/60" />
        </div>

        <div className="mt-3 rounded-xl border border-white/40 bg-white/50 backdrop-blur-md px-4 py-3 text-sm">
          <p className="font-medium text-slate-700">Student Demo</p>
          <p className="mt-1 text-slate-500 break-all">
            {DEMO_STUDENT_EMAIL}
            <span className="mx-2 text-slate-300">•</span>
            {DEMO_STUDENT_PASSWORD}
          </p>
          <button
            type="button"
            onClick={handleDemoStudentLogin}
            disabled={locked}
            className="w-full mt-3 bg-slate-800 text-white py-2.5 rounded-xl font-medium hover:bg-slate-700 transition disabled:opacity-60"
          >
            {retryAfter > 0
              ? `Try again in ${retryAfter}s`
              : loading
                ? "Signing in..."
                : "Login as Demo Student"}
          </button>
        </div>
      </div>
    </div>
  );
}
