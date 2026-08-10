import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    host: true,
    // Arena previews are hosted under *.e2b.app; keep that explicit alongside
    // local/ngrok development rather than rejecting a valid preview Host header.
    allowedHosts: [".ngrok-free.dev", ".e2b.app"],

    // Proxy API and socket during local dev
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

