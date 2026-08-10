import React, { useId } from "react";

export default function EduNovaAIAvatar({ size = 48, className = "", decorative = false }) {
  const uid = useId().replace(/:/g, "");
  const gradientId = `edunova-ai-gradient-${uid}`;
  const glowId = `edunova-ai-glow-${uid}`;
  const shineId = `edunova-ai-shine-${uid}`;

  const accessibilityProps = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": "EduNova AI avatar" };

  return (
    <span
      {...accessibilityProps}
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-teal-500 shadow-[0_10px_26px_rgba(13,148,136,0.25)] ring-1 ring-teal-200/70 dark:ring-teal-300/30 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 64 64" className="h-full w-full" focusable="false" aria-hidden="true">
        <defs>
          <radialGradient id={gradientId} cx="32%" cy="20%" r="78%">
            <stop offset="0%" stopColor="#ccfbf1" />
            <stop offset="38%" stopColor="#14b8a6" />
            <stop offset="74%" stopColor="#0f766e" />
            <stop offset="100%" stopColor="#0f172a" />
          </radialGradient>
          <radialGradient id={shineId} cx="30%" cy="18%" r="45%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.6" result="blur" />
            <feColorMatrix
              in="blur"
              type="matrix"
              values="0 0 0 0 0.08 0 0 0 0 0.85 0 0 0 0 0.75 0 0 0 0.55 0"
            />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle cx="32" cy="32" r="31" fill={gradientId ? `url(#${gradientId})` : "#0f766e"} />
        <circle cx="32" cy="32" r="30.2" fill={`url(#${shineId})`} opacity="0.5" />
        <circle cx="32" cy="32" r="28.5" fill="none" stroke="rgba(255,255,255,0.34)" strokeWidth="1.2" />
        <circle cx="32" cy="32" r="20" fill="rgba(15,23,42,0.2)" stroke="rgba(204,251,241,0.46)" strokeWidth="1" />

        <g filter={`url(#${glowId})`} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 22 L27 30 M46 22 L37 30 M18 42 L27 34 M46 42 L37 34" stroke="#99f6e4" strokeWidth="1.35" opacity="0.82" />
          <path d="M25 20 V44 M25 20 H42 M25 32 H39 M25 44 H42" stroke="#f8fafc" strokeWidth="4.2" />
          <path d="M25 20 V44 M25 20 H42 M25 32 H39 M25 44 H42" stroke="#0f766e" strokeOpacity="0.2" strokeWidth="1" />
          <circle cx="18" cy="22" r="3.1" fill="#ccfbf1" />
          <circle cx="46" cy="22" r="3.1" fill="#ccfbf1" />
          <circle cx="18" cy="42" r="3.1" fill="#ccfbf1" />
          <circle cx="46" cy="42" r="3.1" fill="#ccfbf1" />
          <circle cx="32" cy="32" r="3.5" fill="#f8fafc" />
        </g>

        <g fill="#ffffff" opacity="0.92">
          <path d="M48 12.5l1.35 3.05 3.15 1.25-3.15 1.25L48 21.1l-1.35-3.05-3.15-1.25 3.15-1.25L48 12.5z" />
          <path d="M15.5 12l0.82 1.85 1.93 0.78-1.93 0.77-0.82 1.86-0.82-1.86-1.93-0.77 1.93-0.78L15.5 12z" opacity="0.74" />
        </g>
      </svg>
      <span className="pointer-events-none absolute inset-0 rounded-full border border-white/40" aria-hidden="true" />
    </span>
  );
}
