import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { pathToFileURL } from 'url'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Vite dev-server plugin that mounts POST /api/verify by loading
 * Arc-Dungeon/api/verify.js (the same handler used in production on Vercel).
 * Returns 503 when VERIFIER_PRIVATE_KEY is unset — no key is created.
 */
function verifierPlugin(): Plugin {
  return {
    name: 'verifier-api',
    configureServer(server) {
      server.middlewares.use('/api/verify', async (req, res, _next) => {
        const method = req.method?.toUpperCase()
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (method === 'OPTIONS') { res.writeHead(204); return res.end() }
        if (method !== 'POST') { res.writeHead(405); return res.end(JSON.stringify({ error: 'Method not allowed' })) }

        // Collect body
        let raw = ''
        for await (const chunk of req as AsyncIterable<Buffer>) raw += chunk
        let body: unknown
        try { body = JSON.parse(raw) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Invalid JSON' }))
        }

        try {
          // Dynamic import so errors (missing viem, etc.) are caught per-request
          const verifyUrl = pathToFileURL(path.resolve(__dirname, 'Arc-Dungeon/api/verify.js')).href
          const { handleVerify } = await import(verifyUrl)
          const { status, body: responseBody } = await handleVerify(body, process.env)
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(responseBody))
        } catch (err) {
          console.error('[verifier-plugin]', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal verifier error' }))
        }
      })

      // GET /api/history — read-only onchain history scanner
      server.middlewares.use('/api/history', async (req, res, _next) => {
        const method = req.method?.toUpperCase()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (method === 'OPTIONS') { res.writeHead(204); return res.end() }
        if (method !== 'GET') { res.writeHead(405); return res.end(JSON.stringify({ error: 'Method not allowed' })) }

        try {
          const historyUrl = pathToFileURL(path.resolve(__dirname, 'Arc-Dungeon/api/history.js')).href
          const { handleHistory } = await import(historyUrl)
          res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=120')
          const { status, body: responseBody } = await handleHistory({}, process.env)
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(responseBody))
        } catch (err) {
          console.error('[history-plugin]', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal history error' }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), nodePolyfills(), verifierPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    allowedHosts: true,
    cors: true,
    proxy: {
      '/game': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/game/, ''),
      },
    },
  },
})
