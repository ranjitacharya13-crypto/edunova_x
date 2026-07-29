export default function Header({ theme, onToggleTheme }) {
  const isDark = theme === "dark";
  const nextThemeLabel = isDark ? "Light mode" : "Dark mode";

  return (
    <header
      className="w-full glass-card rounded-none"
    >
      <div className="mx-auto max-w-[1600px] w-full px-2 sm:px-4 lg:px-6 2xl:px-8 py-3 flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-primary text-white
            grid place-items-center font-bold text-lg">
            ED
          </div>
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-semibold truncate">EduNova_X</div>
            <div className="text-[11px] sm:text-xs text-muted truncate">
              Classical education for the future
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          className="glass-btn text-xs sm:text-sm px-2.5 sm:px-3 py-2 rounded-xl inline-flex items-center gap-1.5 sm:gap-2 text-slate-700 dark:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 shrink-0"
          aria-label="Toggle theme"
        >
          {isDark ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="M4.93 4.93l1.41 1.41" />
              <path d="M17.66 17.66l1.41 1.41" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="M4.93 19.07l1.41-1.41" />
              <path d="M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
              aria-hidden="true"
            >
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              <path d="M17.5 6.5h.01" />
              <path d="M19.5 10.5h.01" />
            </svg>
          )}
          <span className="font-medium">{nextThemeLabel}</span>
        </button>
      </div>
    </header>
  );
}
