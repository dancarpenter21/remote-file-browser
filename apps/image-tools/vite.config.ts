import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/apps/images/',
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['linux-server', 'linux-server.local'],
    hmr: { path: '/apps/images-hmr' },
    proxy: {
      '/api': { target: process.env.VITE_FILES_TARGET ?? 'http://127.0.0.1:8080' },
    },
  },
})
