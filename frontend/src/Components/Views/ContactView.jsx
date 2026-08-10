import React, { useState } from "react";
import { API } from "../../api/api";

export default function ContactView() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const handleSend = async (e) => {
    e.preventDefault();
    setSuccess("");
    setError("");

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedMsg = msg.trim();

    if (!trimmedName || !trimmedEmail || !trimmedMsg) {
      setError("Please fill out all fields");
      return;
    }

    setLoading(true);
    try {
      const res = await API.post("/contact", {
        name: trimmedName,
        email: trimmedEmail,
        message: trimmedMsg,
      });

      const data = res.data;
      if (!data.success) {
        throw new Error(data.message || "Failed to send message");
      }

      setSuccess("Message sent successfully");
      setName("");
      setEmail("");
      setMsg("");
    } catch (err) {
      setError(err.message || "Failed to send message");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white/80 backdrop-blur-md rounded-2xl p-4 sm:p-6 shadow-soft">
      {/* Header */}
      <div className="mb-5">
        <h3 className="text-lg font-semibold text-slate-900">
          Contact / Help
        </h3>
        <p className="text-sm text-slate-500">
          Need help? Reach out to us anytime.
        </p>
      </div>

      {/* Contact Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-2xl bg-white p-4 shadow-soft">
          <div className="text-sm font-medium text-slate-900 mb-1">
            Support
          </div>
          <div className="text-sm text-slate-500">
            ranjit5201314@gmail.com
          </div>
          <div className="text-sm text-slate-500">
            +91 63801 04161
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-soft">
          <div className="text-sm font-medium text-slate-900 mb-1">
            Administration
          </div>
          <div className="text-sm text-slate-500">
            ranjit5201314@gmail.com
          </div>
          <div className="text-sm text-slate-500">
            +91 63801 04161
          </div>
        </div>
      </div>

      {/* Message Box */}
      <form onSubmit={handleSend}>
        {success && (
          <div className="mb-4 rounded-xl bg-emerald-50 text-emerald-700 text-sm px-4 py-3">
            {success}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl bg-rose-50 text-rose-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Your Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              className="w-full rounded-xl border border-slate-200
                p-3 text-sm focus:outline-none
                focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Your Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              className="w-full rounded-xl border border-slate-200
                p-3 text-sm focus:outline-none
                focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <label className="block text-sm font-medium text-slate-700 mb-2">
          Your Message
        </label>

        <textarea
          rows="4"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="Type your message here..."
          className="w-full rounded-xl border border-slate-200
            p-4 text-sm focus:outline-none
            focus:ring-2 focus:ring-primary/30"
        />

        <button
          type="submit"
          disabled={loading}
          className="mt-4 px-6 py-2 rounded-xl
            bg-primary text-white text-sm font-medium shadow"
        >
          {loading ? "Sending..." : "Send Message"}
        </button>
      </form>
    </div>
  );
}
