import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: ["*", "5173-ir6v61hzw47wgxrktuu6t.e2b.app"],
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: ["*", "4173-ir6v61hzw47wgxrktuu6t.e2b.app"],
  },
});
