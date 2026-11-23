import React, { useEffect, useRef, useState } from "react";
import RegisterWizard from "./RegisterWizard";

const DEMO_STUDENT_EMAIL = "student@edunova.demo";
const DEMO_STUDENT_PASSWORD = "Student@12345";

export default function LoginCard({
  onLogin,
  onRegistered,
  sessionNotice = "",
  onClearSessionNotice,
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeSource, setActiveSource] = useState(null); // "manual" | "demo" | null
  const [slowHint, setSlowHint] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [lockedTarget, setLockedTarget] = useState(""); // "*" | normalized email | ""
  const [showRegister, setShowRegister] = useState(false);

  // Synchronous lock prevents rapid double-clicks / double-Enter submissions
  // before React commits the asynchronous `loading` state update.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (retryAfter <= 0) {
      if (lockedTarget) setLockedTarget("");
      return;
    }
    const timer = setTimeout(() => {
      setRetryAfter((s) => {
        const next = Math.max(0, s - 1);
        if (next === 0) setLockedTarget("");
        return next;
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [retryAfter, lockedTarget]);

  if (showRegister) {
    return (
      <RegisterWizard
        onBack={() => setShowRegister(false)}
        onComplete={(user, token) => {
          setShowRegister(false);
          if (onRegistered && user && token) {
            onRegistered(user, token);
          } else if (user?.email) {
            setEmail(user.email);
          }
        }}
      />
    );
  }

  const normalizedManualEmail = email.trim().toLowerCase();
  const manualRateLimited =
    retryAfter > 0 &&
    (lockedTarget === "*" ||
      (Boolean(normalizedManualEmail) && lockedTarget === normalizedManualEmail));
  const demoRateLimited =
    retryAfter > 0 &&
    (lockedTarget === "*" || lockedTarget === DEMO_STUDENT_EMAIL);

  const runLogin = async (emailValue, passwordValue, source) => {
    if (inFlightRef.current || loading) return;

    const cleanEmail = String(emailValue || "").trim();
    const normalizedTarget = cleanEmail.toLowerCase();

    if (source === "manual" && (!cleanEmail || !passwordValue)) {
      setError("Please enter your email and password.");
      return;
    }

    if (
      retryAfter > 0 &&
      (lockedTarget === "*" || (normalizedTarget && lockedTarget === normalizedTarget))
    ) {
      return;
    }

    inFlightRef.current = true;
    onClearSessionNotice?.();
    setError("");
    setSlowHint(false);
    setActiveSource(source);
    setLoading(true);

    const slowTimer = setTimeout(() => {
      setSlowHint(true);
    }, 4000);

    try {
      const res = await onLogin(cleanEmail, passwordValue);
      if (res?.error) {
        setError(res.error);
        const waitSeconds = Number(res.retryAfterSeconds) || 0;
        if (res.status === 429 && waitSeconds > 0) {
          setRetryAfter(waitSeconds);
          setLockedTarget(res.bucket === "ip" ? "*" : normalizedTarget || "*");
        }
        return;
      }
      if (!res?.token || !res?.user) {
        setError("Sign-in did not complete. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      clearTimeout(slowTimer);
      inFlightRef.current = false;
      setLoading(false);
      setActiveSource(null);
      setSlowHint(false);
    }
  };

  const handleLogin = (event) => {
    if (event) event.preventDefault();
    runLogin(email, password, "manual");
  };

  const handleDemoStudentLogin = () => {
    runLogin(DEMO_STUDENT_EMAIL, DEMO_STUDENT_PASSWORD, "demo");
  };

  const manualDisabled = loading || manualRateLimited;
  const demoDisabled = loading || demoRateLimited;

  const submitLabel = manualRateLimited
    ? `Try again in ${retryAfter}s`
    : loading && activeSource === "manual"
      ? "Signing in..."
      : "Sign In";

  const demoLabel = demoRateLimited
    ? `Try again in ${retryAfter}s`
    : loading && activeSource === "demo"
      ? "Signing in..."
      : "Login as Demo Student";

  return (
    <div className="w-full max-w-md mx-auto glass-card p-6">
      <h2 className="text-xl font-semibold mb-1">Sign in</h2>
      <p className="text-sm text-slate-500 mb-4">
        Login to continue to EduNova
      </p>

      {sessionNotice && !error && (
        <div
          role="status"
          className="mb-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg"
        >
          {sessionNotice}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg"
        >
          {error}
        </div>
      )}

      {loading && slowHint && (
        <div
          role="status"
          className="mb-3 text-xs text-slate-600 bg-slate-100/80 px-3 py-2 rounded-lg"
        >
          Connecting to server — waking up service, please wait...
        </div>
      )}

      <form onSubmit={handleLogin} noValidate>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError("");
          }}
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
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError("");
          }}
          disabled={loading}
          className="w-full mb-4 px-4 py-3 rounded-xl border border-white/40 bg-white/60 backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />

        <button
          type="submit"
          disabled={manualDisabled}
          className="w-full bg-primary text-white py-3 rounded-xl font-medium disabled:opacity-60"
        >
          {submitLabel}
        </button>
      </form>

      <button
        type="button"
        disabled={loading}
        onClick={() => setShowRegister(true)}
        className="w-full mt-4 text-primary border border-primary/30 bg-white/40 backdrop-blur-md py-2.5 rounded-xl hover:bg-white/60 transition disabled:opacity-60"
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
            disabled={demoDisabled}
            className="w-full mt-3 bg-slate-800 text-white py-2.5 rounded-xl font-medium hover:bg-slate-700 transition disabled:opacity-60"
          >
            {demoLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
