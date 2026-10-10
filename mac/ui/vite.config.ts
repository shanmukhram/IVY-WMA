import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the API and the event stream to a running @ivy/mac-service.
// IVY_SERVICE_URL overrides the default http://127.0.0.1:4777.
const target = process.env.IVY_SERVICE_URL ?? "http://127.0.0.1:4777";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/events": { target: target.replace(/^http/, "ws"), ws: true, changeOrigin: false },
    },
  },
});
