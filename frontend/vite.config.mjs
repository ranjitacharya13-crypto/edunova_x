import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: [
      "*",
      "5173-ipqppl8su1jy3zul40j7a.e2b.app",
      "5173-ir6v61hzw47wgxrktuu6t.e2b.app",
      ".e2b.app",
    ],
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
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: [
      "*",
      "4173-ipqppl8su1jy3zul40j7a.e2b.app",
      "4173-ir6v61hzw47wgxrktuu6t.e2b.app",
      ".e2b.app",
    ],
  },
});
