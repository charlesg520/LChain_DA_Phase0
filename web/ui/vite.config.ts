import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the Vite server proxies API, media and the WebSocket to the console server.
const target = process.env.HQ_WEB_SERVER || "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    proxy: {
      "/api": { target, changeOrigin: true },
      "/media": { target, changeOrigin: true },
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
