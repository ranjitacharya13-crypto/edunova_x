/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#0f9f94",
        "primary-deep": "#0f766e",
        secondary: "#f08a75",
        accent: "#eabf52",
        surface: "#ffffff",
        muted: "#64748b",
      },
      boxShadow: {
        soft: "0 18px 45px rgba(15, 23, 42, 0.08)",
        "soft-dark": "0 24px 65px rgba(2, 6, 23, 0.23)",
      },
      borderRadius: {
        xl: "1.1rem",
        "2xl": "1.35rem",
      },
    },
  },
  plugins: [],
};
