import BrandMark from "./BrandMark";

export default function Footer({ onNavigate }) {
  const year = new Date().getFullYear();
  const links = [
    ["Home", "home"],
    ["Syllabus", "syllabus"],
    ["Study materials", "study"],
    ["Live classes", "live"],
    ["Contact", "contact"],
  ];

  return (
    <footer className="mt-8 border-t border-slate-200/80 pt-7 text-sm dark:border-white/10">
      <div className="grid gap-7 md:grid-cols-[1.35fr_1fr_1fr]">
        <div>
          <BrandMark />
          <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-300">
            A focused learning workspace for classrooms, study resources, and live sessions.
          </p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Explore</p>
          <div className="mt-3 grid gap-2">
            {links.map(([label, view]) => (
              <button key={view} type="button" onClick={() => onNavigate?.(view)} className="w-fit text-left text-slate-600 transition hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-slate-300 dark:hover:text-teal-200">
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Support</p>
          <a href="mailto:ranjit5201314@gmail.com" className="mt-3 block w-fit text-slate-600 transition hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-slate-300 dark:hover:text-teal-200">
            ranjit5201314@gmail.com
          </a>
          <button type="button" onClick={() => onNavigate?.("contact")} className="mt-2 text-left text-slate-600 transition hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-slate-300 dark:hover:text-teal-200">
            Get help or send a message
          </button>
        </div>
      </div>
      <div className="mt-7 flex flex-col gap-2 border-t border-slate-200/80 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:text-slate-400">
        <span>© {year} EduNova_X. All rights reserved.</span>
        <span>Designed for thoughtful learning.</span>
      </div>
    </footer>
  );
}
