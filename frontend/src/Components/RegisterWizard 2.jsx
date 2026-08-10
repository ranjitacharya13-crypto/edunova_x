import React, { useState } from "react";
import { registerUser } from "../api/api";

export default function RegisterWizard({ onComplete, onBack }) {
  const [form, setForm] = useState({
    name: "",
    dob: "",
    gender: "",
    username: "",
    email: "",
    password: "",
    role: "student", // ✅ default role
  });

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleRegister = async () => {
    const { name, email, password, username, role } = form;

    if (!username || !email || !password) {
      alert("Username, Email and Password are required");
      return;
    }

    const res = await registerUser(form);

    if (res?.error) {
      alert(res.error);
    } else {
      alert("Account created successfully");
      onComplete && onComplete(res.user);
    }
  };

  return (
    <div className="bg-white/90 backdrop-blur-md p-6 rounded-2xl shadow-soft max-w-md mx-auto">
      <h2 className="text-xl font-semibold mb-4">Create Account</h2>

      {/* NAME */}
      <input
        name="name"
        placeholder="Full Name"
        value={form.name}
        onChange={handleChange}
        className="w-full mb-3 px-4 py-3 rounded-xl border"
      />

      {/* DATE OF BIRTH */}
      <input
        type="date"
        name="dob"
        value={form.dob}
        onChange={handleChange}
        className="w-full mb-3 px-4 py-3 rounded-xl border"
      />

      {/* GENDER */}
      <select
        name="gender"
        value={form.gender}
        onChange={handleChange}
        className="w-full mb-3 px-4 py-3 rounded-xl border"
      >
        <option value="">Select Gender</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
        <option value="Other">Other</option>
      </select>

      {/* ✅ ROLE SELECTOR (STUDENT / TEACHER) */}
      <select
        name="role"
        value={form.role}
        onChange={handleChange}
        className="w-full mb-3 px-4 py-3 rounded-xl border"
      >
        <option value="student">Student</option>
        <option value="teacher">Teacher</option>
      </select>

      {/* USERNAME */}
      <input
        name="username"
        placeholder="Username"
        value={form.username}
        onChange={handleChange}
        className="w-full mb-3 px-4 py-3 rounded-xl border"
      />

      {/* EMAIL */}
      <input
        type="email"
        name="email"
        placeholder="Email"
        value={form.email}
        onChange={handleChange}
        className="w-full mb-3 px-4 py-3 rounded-xl border"
      />

      {/* PASSWORD */}
      <input
        type="password"
        name="password"
        placeholder="Password"
        value={form.password}
        onChange={handleChange}
        className="w-full mb-4 px-4 py-3 rounded-xl border"
      />

      {/* ACTION BUTTONS */}
      <div className="flex gap-3">
        <button
          onClick={handleRegister}
          className="flex-1 bg-teal-500 text-white py-3 rounded-xl"
        >
          Create Account
        </button>

        {onBack && (
          <button
            onClick={onBack}
            className="flex-1 border py-3 rounded-xl"
          >
            Back
          </button>
        )}
      </div>
    </div>
  );
}
