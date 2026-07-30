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

  const handleLogin = async () => {
    setError("");
    setLoading(true);

    const res = await onLogin(email, password);

    if (res?.error) {
      setError(res.error);
      setLoading(false);
      return;
    }

    setLoading(false);
  };

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
        disabled={loading}
        onClick={handleLogin}
        className="w-full bg-primary text-white py-3 rounded-xl font-medium"
      >
        {loading ? "Signing in..." : "Sign In"}
      </button>

      <button
        onClick={() => setShowRegister(true)}
        className="w-full mt-4 text-primary border border-primary/30 bg-white/40 backdrop-blur-md py-2.5 rounded-xl hover:bg-white/60 transition"
      >
        Create Account
      </button>
    </div>
  );
}
