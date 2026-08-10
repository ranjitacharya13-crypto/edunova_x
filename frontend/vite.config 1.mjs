import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    host: true,
    allowedHosts: [".ngrok-free.dev"],

    // 🔥 THIS IS THE FIX
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        secure: false,
      },
      "/socket.io": {
        target: "http://127.0.0.1:4000",
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
