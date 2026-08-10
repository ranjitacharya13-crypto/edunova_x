import React, { useState } from "react";
import RegisterWizard from "./RegisterWizard";

export default function LoginCard({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  if (showRegister) {
    return <RegisterWizard onBack={() => setShowRegister(false)} />;
  }

  const handleLogin = async (e) => {
    if (e) e.preventDefault();
    setError("");

    // Client-side validation
    const trimmedEmail = String(email || "").trim();
    const trimmedPassword = String(password || "").trim();

    if (!trimmedEmail || !trimmedPassword) {
      setError("Please enter both email and password.");
      return;
    }

    setLoading(true);

    try {
      const res = await onLogin(trimmedEmail, trimmedPassword);

      if (res?.error) {
        setError(
          res.error === "Missing email or password"
            ? "Please enter both email and password."
            : res.error === "Invalid credentials"
            ? "Invalid email or password. Please try again."
            : res.error
        );
      }
    } catch {
      setError("Unable to reach the server. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto glass-card p-6">
      <h2 className="text-xl font-semibold mb-1">Sign in</h2>
      <p className="text-sm text-slate-500 mb-4">
        Login to continue to EduNova
      </p>

      {error && (
        <div
          className="mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg border border-red-100"
          role="alert"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleLogin} noValidate>
        <label htmlFor="login-email" className="sr-only">
          Email or username
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="Email or username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="w-full mb-3 px-4 py-3 rounded-xl border border-white/40 bg-white/60 backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />

        <label htmlFor="login-password" className="sr-only">
          Password
        </label>
        <input
          id="login-password"
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
          disabled={loading}
          className="w-full bg-primary text-white py-3 rounded-xl font-medium hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setShowRegister(true)}
        disabled={loading}
        className="w-full mt-4 text-primary border border-primary/30 bg-white/40 backdrop-blur-md py-2.5 rounded-xl hover:bg-white/60 transition disabled:opacity-60"
      >
        Create Account
      </button>
    </div>
  );
}
