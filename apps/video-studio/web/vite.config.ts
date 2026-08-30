import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/apps/video/",
  build: { emptyOutDir: true },
  server: {
    port: 5173,
    allowedHosts: ["linux-server", "linux-server.local"],
    hmr: { path: "/apps/video-hmr" },
    proxy: {
      "/apps/video/api": {
        target: "http://127.0.0.1:4317",
        rewrite: (path) => path.replace(/^\/apps\/video/, ""),
      },
    },
  },
});
