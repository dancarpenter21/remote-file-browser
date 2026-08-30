import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  const videoTarget = process.env.VITE_VIDEO_STUDIO_TARGET
  const textTarget = process.env.VITE_TEXT_EDITOR_TARGET
  return {
  plugins: [react()],
  server: {
    allowedHosts: ['linux-server', 'linux-server.local'],
    proxy: {
      ...(textTarget ? {
        '/apps/text-hmr': { target: textTarget, ws: true },
        '/apps/text': { target: textTarget, ws: true },
      } : {}),
      ...(videoTarget ? {
        '/apps/video-hmr': { target: videoTarget, ws: true },
        '/apps/video': { target: videoTarget, ws: true },
      } : {}),
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:8080',
        ws: true,
        configure(proxy) {
          proxy.on('proxyReq', proxyRequest => {
            const cookie = proxyRequest.getHeader('cookie')
            if (typeof cookie === 'string') {
              proxyRequest.setHeader('cookie', cookie.replace(/(^|;\s*)rfb_dev_session=/, '$1rfb_session='))
            }
          })
          proxy.on('proxyReqWs', proxyRequest => {
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
  }
})
