import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/apps/video/",
  // The source bind mount can contain root-owned workspace dependencies.
  cacheDir: join(tmpdir(), "remote-workspace-video-studio-vite"),
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
