import BrandMark from "./BrandMark";

export default function Header({ theme, onToggleTheme }) {
  const isDark = theme === "dark";

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/50 bg-white/70 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/75">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <BrandMark />

        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border border-teal-100 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-800 sm:inline-flex dark:border-teal-400/15 dark:bg-teal-400/10 dark:text-teal-200">
            Learning workspace
          </span>
          <button
            type="button"
            onClick={onToggleTheme}
            className="glass-btn inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-slate-700 transition-all hover:-translate-y-0.5 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
            aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
            title={`Switch to ${isDark ? "light" : "dark"} mode`}
          >
            {isDark ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
            )}
            <span className="hidden sm:inline">{isDark ? "Light mode" : "Dark mode"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
