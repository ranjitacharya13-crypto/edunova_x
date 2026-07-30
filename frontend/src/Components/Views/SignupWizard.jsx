import React, { useState } from "react";
import { registerUser } from "../../api/api";

export default function SignupWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [role, setRole] = useState("");

  const [form, setForm] = useState({
    name: "",
    age: "",
    email: "",
    password: "",
  });

  const next = () => setStep(step + 1);
  const back = () => setStep(step - 1);

  const handleRegister = async () => {
    if (role === "student" && form.age > 19) {
      alert("Students must be age 19 or below.");
      return;
    }
    if (role === "teacher" && form.age < 21) {
      alert("Teachers must be 21 or older.");
      return;
    }

    try {
      const res = await registerUser({ ...form, role });
      if (res.token) {
        localStorage.setItem("token", res.token);
        onComplete(res.user);
      } else {
        alert(res.message || "Something went wrong");
      }
    } catch (err) {
      alert("Server error");
      console.error(err);
    }
  };

  return (
    <div className="bg-white/80 backdrop-blur-md rounded-2xl p-4 sm:p-6 shadow-soft max-w-md mx-auto">
      {/* HEADER */}
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900">
          Create Account
        </h2>
        <p className="text-sm text-slate-500">
          Join EduNova and start learning today
        </p>
      </div>

      {/* STEP 1 — ROLE */}
      {step === 1 && (
        <div className="space-y-4">
          <button
            className="w-full py-3 rounded-xl bg-primary text-white font-medium shadow"
            onClick={() => {
              setRole("student");
              next();
            }}
          >
            Create Student Account
          </button>

          <button
            className="w-full py-3 rounded-xl bg-primary/10 text-primary font-medium"
            onClick={() => {
              setRole("teacher");
              next();
            }}
          >
            Create Teacher Account
          </button>
        </div>
      )}

      {/* STEP 2 — NAME */}
      {step === 2 && (
        <>
          <label className="text-sm font-medium text-slate-700">
            Full Name
          </label>
          <input
            className="w-full mt-2 mb-5 p-3 rounded-xl border border-slate-200
              focus:ring-2 focus:ring-primary/30 focus:outline-none"
            placeholder="Your Name"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />

          <div className="flex justify-between">
            <button onClick={back} className="text-sm text-slate-500">
              Back
            </button>
            <button
              onClick={next}
              className="px-5 py-2 rounded-xl bg-primary text-white text-sm shadow"
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* STEP 3 — AGE */}
      {step === 3 && (
        <>
          <label className="text-sm font-medium text-slate-700">
            {role === "student"
              ? "Age (Below 19)"
              : "Age (21+ Required)"}
          </label>

          <input
            type="number"
            className="w-full mt-2 mb-5 p-3 rounded-xl border border-slate-200
              focus:ring-2 focus:ring-primary/30 focus:outline-none"
            placeholder="Your Age"
            onChange={(e) => setForm({ ...form, age: e.target.value })}
          />

          <div className="flex justify-between">
            <button onClick={back} className="text-sm text-slate-500">
              Back
            </button>
            <button
              onClick={next}
              className="px-5 py-2 rounded-xl bg-primary text-white text-sm shadow"
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* STEP 4 — EMAIL */}
      {step === 4 && (
        <>
          <label className="text-sm font-medium text-slate-700">
            Email Address
          </label>
          <input
            type="email"
            className="w-full mt-2 mb-5 p-3 rounded-xl border border-slate-200
              focus:ring-2 focus:ring-primary/30 focus:outline-none"
            placeholder="Email"
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />

          <div className="flex justify-between">
            <button onClick={back} className="text-sm text-slate-500">
              Back
            </button>
            <button
              onClick={next}
              className="px-5 py-2 rounded-xl bg-primary text-white text-sm shadow"
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* STEP 5 — PASSWORD */}
      {step === 5 && (
        <>
          <label className="text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            type="password"
            className="w-full mt-2 mb-5 p-3 rounded-xl border border-slate-200
              focus:ring-2 focus:ring-primary/30 focus:outline-none"
            placeholder="Create password"
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />

          <div className="flex justify-between">
            <button onClick={back} className="text-sm text-slate-500">
              Back
            </button>
            <button
              onClick={handleRegister}
              className="px-5 py-2 rounded-xl bg-primary text-white text-sm shadow"
            >
              Create Account
            </button>
          </div>
        </>
      )}
    </div>
  );
}
