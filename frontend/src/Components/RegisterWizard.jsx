import React, { useRef, useState } from "react";
import { registerUser } from "../api/api";

export default function RegisterWizard({ onComplete, onBack }) {
  const [form, setForm] = useState({
    name: "",
    dob: "",
    gender: "",
    username: "",
    email: "",
    password: "",
    role: "student",
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    if (error) setError("");
  };

  const handleRegister = async (event) => {
    if (event) event.preventDefault();
    if (inFlightRef.current || submitting) return;

    const { email, password, username } = form;
    if (!username.trim() || !email.trim() || !password) {
      setError("Username, Email and Password are required.");
      return;
    }

    inFlightRef.current = true;
    setError("");
    setSubmitting(true);
    try {
      const res = await registerUser(form);
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (res?.user) {
        onComplete?.(res.user, res.token);
      } else {
        setError("Registration did not complete. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleRegister}
      noValidate
      className="bg-white/90 backdrop-blur-md p-6 rounded-2xl shadow-soft max-w-md w-full mx-auto"
    >
      <h2 className="text-xl font-semibold mb-4">Create Account</h2>

      {error && (
        <div role="alert" className="mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      <input
        name="name"
        placeholder="Full Name"
        value={form.name}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-3 px-4 py-3 rounded-xl border disabled:opacity-60"
      />

      <input
        type="date"
        name="dob"
        value={form.dob}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-3 px-4 py-3 rounded-xl border disabled:opacity-60"
      />

      <select
        name="gender"
        value={form.gender}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-3 px-4 py-3 rounded-xl border disabled:opacity-60"
      >
        <option value="">Select Gender</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
        <option value="Other">Other</option>
      </select>

      <select
        name="role"
        value={form.role}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-3 px-4 py-3 rounded-xl border disabled:opacity-60"
      >
        <option value="student">Student</option>
        <option value="teacher">Teacher</option>
      </select>

      <input
        name="username"
        placeholder="Username"
        autoComplete="username"
        value={form.username}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-3 px-4 py-3 rounded-xl border disabled:opacity-60"
      />

      <input
        type="email"
        name="email"
        placeholder="Email"
        autoComplete="email"
        value={form.email}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-3 px-4 py-3 rounded-xl border disabled:opacity-60"
      />

      <input
        type="password"
        name="password"
        placeholder="Password"
        autoComplete="new-password"
        value={form.password}
        onChange={handleChange}
        disabled={submitting}
        className="w-full mb-4 px-4 py-3 rounded-xl border disabled:opacity-60"
      />

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 bg-teal-500 text-white py-3 rounded-xl disabled:opacity-60"
        >
          {submitting ? "Creating..." : "Create Account"}
        </button>

        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={submitting}
            className="flex-1 border py-3 rounded-xl disabled:opacity-60"
          >
            Back
          </button>
        )}
      </div>
    </form>
  );
}
