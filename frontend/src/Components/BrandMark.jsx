import React from "react";

/**
 * EduNova's shared, lightweight brand mark.
 * The open-book silhouette represents learning; the orbit and star represent
 * guided discovery. It is intentionally inline SVG so it works offline and in
 * the PWA without an external image request.
 */
export default function BrandMark({ className = "", showWordmark = true, inverse = false }) {
  const textClass = inverse ? "text-white" : "text-slate-900 dark:text-white";
  const subClass = inverse ? "text-white/70" : "text-slate-500 dark:text-slate-300";

  return (
    <div className={`inline-flex items-center gap-3 min-w-0 ${className}`}>
      <svg
        viewBox="0 0 48 48"
        role="img"
        aria-label="EduNova"
        className="h-10 w-10 shrink-0 drop-shadow-[0_8px_18px_rgba(13,148,136,0.28)]"
      >
        <defs>
          <linearGradient id="edunova-mark" x1="5" x2="43" y1="5" y2="44" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0f766e" />
            <stop offset="0.55" stopColor="#14b8a6" />
            <stop offset="1" stopColor="#5eead4" />
          </linearGradient>
          <linearGradient id="edunova-page" x1="10" x2="37" y1="15" y2="36" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffffff" />
            <stop offset="1" stopColor="#ccfbf1" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="44" height="44" rx="14" fill="url(#edunova-mark)" />
        <path d="M24 15.5c-4.5-2.7-9.5-2.5-13.2.1v15.1c3.9-2.2 8.9-2.1 13.2.6 4.3-2.7 9.3-2.8 13.2-.6V15.6c-3.7-2.6-8.7-2.8-13.2-.1Z" fill="url(#edunova-page)" />
        <path d="M24 15.5v15.8M14.4 20.1c2.7-1.2 5.6-1 8.3.5M33.6 20.1c-2.7-1.2-5.6-1-8.3.5" fill="none" stroke="#0f766e" strokeLinecap="round" strokeWidth="1.45" opacity=".8" />
        <path d="m35.5 8.2.75 2.05 2.05.75-2.05.76-.75 2.04-.76-2.04-2.04-.76 2.04-.75.76-2.05Z" fill="#fef3c7" />
      </svg>
      {showWordmark && (
        <span className="min-w-0 leading-tight">
          <span className={`block truncate text-[17px] font-bold tracking-[-0.035em] ${textClass}`}>
            Edu<span className="text-teal-600 dark:text-teal-300">Nova</span><span className="text-teal-500">_X</span>
          </span>
          <span className={`block truncate text-[10px] font-medium tracking-[0.12em] uppercase ${subClass}`}>
            Learning, elevated
          </span>
        </span>
      )}
    </div>
  );
}
