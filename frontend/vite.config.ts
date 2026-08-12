import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['linux-server', 'linux-server.local'],
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:8080',
        configure(proxy) {
          proxy.on('proxyReq', proxyRequest => {
            const cookie = proxyRequest.getHeader('cookie')
            if (typeof cookie === 'string') {
              proxyRequest.setHeader('cookie', cookie.replace(/(^|;\s*)rfb_dev_session=/, '$1rfb_session='))
            }
          })
          proxy.on('proxyRes', proxyResponse => {
            const cookies = proxyResponse.headers['set-cookie']
            if (cookies) {
              proxyResponse.headers['set-cookie'] = cookies.map(cookie =>
                cookie
                  .replace(/^rfb_session=/, 'rfb_dev_session=')
                  .replace(/;\s*Secure(?=;|$)/i, ''),
              )
            }
          })
        },
      },
    },
  },
})
