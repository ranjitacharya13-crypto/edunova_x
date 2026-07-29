/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#2ec4b6",     // Teal
        secondary: "#ff6b6b",   // Coral
        accent: "#ffd166",
        surface: "#ffffff",
        muted: "#64748b",
      },
      boxShadow: {
        soft: "0 20px 40px rgba(0,0,0,0.06)",
      },
      borderRadius: {
        xl: "1.25rem",
        "2xl": "1.5rem",
      },
    },
  },
  plugins: [],
};
