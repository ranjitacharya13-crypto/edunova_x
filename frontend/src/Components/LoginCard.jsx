import React, { useState } from "react";
import RegisterWizard from "./RegisterWizard";
import { AUTH_MESSAGES } from "../api/authErrors";

// The demo account printed on this card. It is a REAL account: the button below
// authenticates through the same production login call as a manual sign-in, so
// it only works while the seeded record exists in the deployed database (see
// server/services/demoAccount.js).
const DEMO_STUDENT_EMAIL = "student@edunova.demo";
const DEMO_STUDENT_PASSWORD = "Student@12345";

export default function LoginCard({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  if (showRegister) {
    return <RegisterWizard onBack={() => setShowRegister(false)} />;
  }

  // THE single authentication path. The form and the demo button both call it,
  // so neither can be a fake/short-circuited login: the credentials always go to
  // the real backend and the dashboard only opens on a verified response.
  const authenticate = async (emailValue, passwordValue) => {
    setError("");

    const cleanEmail = String(emailValue || "").trim();
    if (!cleanEmail || !passwordValue) {
      // Same condition the API answers with 400 — caught here so the user gets
      // an immediate, accurate message without a pointless round trip.
      setError(AUTH_MESSAGES.REQUEST);
      return;
    }

    setLoading(true);
    try {
      const res = await onLogin?.(cleanEmail, passwordValue);
      if (res?.error) {
        setError(res.error);
        return;
      }
      setLoading(false);
    } catch (err) {
      // A rejected promise from the auth layer is a transport/config problem, not
      // a wrong password.
      console.error("[EduNova auth] login did not complete:", err?.message || err);
      setError(AUTH_MESSAGES.NETWORK);
      setLoading(false);
    }
  };

  const handleLogin = async (event) => {
    event?.preventDefault();
    await authenticate(email, password);
  };

  // Fills the form with the published demo credentials and submits them through
  // the exact same authenticate() → onLogin() → loginUser() call as above.
  const handleDemoStudentLogin = async () => {
    setEmail(DEMO_STUDENT_EMAIL);
    setPassword(DEMO_STUDENT_PASSWORD);
    await authenticate(DEMO_STUDENT_EMAIL, DEMO_STUDENT_PASSWORD);
  };

  return (
    <div className="w-full max-w-md mx-auto glass-card p-6">
      <h2 className="text-xl font-semibold mb-1">Sign in</h2>
      <p className="text-sm text-slate-500 mb-4">
        Login to continue to EduNova
      </p>

      {error && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="login-error"
          className="mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg"
        >
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
          className="w-full mb-3 px-4 py-3 rounded-xl border border-white/40 bg-white/60 backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/30"
        />

        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-4 py-3 rounded-xl border border-white/40 bg-white/60 backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/30"
        />

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary text-white py-3 rounded-xl font-medium"
        >
          {loading ? "Signing in..." : "Sign In"}
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
            disabled={loading}
            className="w-full mt-3 bg-slate-800 text-white py-2.5 rounded-xl font-medium hover:bg-slate-700 transition disabled:opacity-60"
          >
            {loading ? "Signing in..." : "Login as Demo Student"}
          </button>
        </div>
      </div>
    </div>
  );
}
