import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Run the Vercel `api/cwf/*` serverless handlers inside Vite so the Browse tab works
// locally, under BOTH `vite dev` and `vite preview`. In production Vercel runs these same
// files as real functions.
//
// This used to hook `configureServer` only, which is the DEV server. `start.bat` serves the
// production build with `vite preview`, which has its own hook — so every /api/cwf request
// fell through to the SPA fallback and came back as index.html with a 200. The client saw
// `res.ok === true`, called `res.json()`, and reported
// `Unexpected token '<', "<!doctype "... is not valid JSON`, which says nothing about the
// actual problem. Browse simply never worked outside `npm run dev`.
function cwfApiMiddleware(loadHandler) {
  return async (req, res, next) => {
    if (!req.url || !req.url.startsWith('/api/cwf/')) return next()
    const url = new URL(req.url, 'http://localhost')
    const name = url.pathname.split('/')[3] // /api/cwf/<name>
    if (name !== 'search' && name !== 'puzzle') return next()

    let handler
    try {
      handler = await loadHandler(name)
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ error: 'load_failed', message: String(err.message || err) }))
    }

    // Adapt Node req/res to the Vercel handler interface.
    req.query = Object.fromEntries(url.searchParams)
    res.status = (code) => { res.statusCode = code; return res }
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res }
    try {
      await handler(req, res)
    } catch (err) {
      if (!res.writableEnded) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'handler_error', message: String(err.message || err) }))
      }
    }
  }
}

function cwfDevApi() {
  return {
    name: 'cwf-dev-api',
    // Dev: go through Vite's module graph so edits to the handlers hot-reload.
    configureServer(server) {
      server.middlewares.use(cwfApiMiddleware(
        async (name) => (await server.ssrLoadModule(`/api/cwf/${name}.js`)).default,
      ))
    },
    // Preview: no module graph, so import the files directly. They are plain ESM and the
    // package is "type": "module", so bare Node loads them as-is.
    configurePreviewServer(server) {
      server.middlewares.use(cwfApiMiddleware(
        async (name) => (await import(`./api/cwf/${name}.js`)).default,
      ))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cwfDevApi()],
  server: {
    port: 7891,
    strictPort: true,
    host: true, // expose on LAN / Tailscale so a phone can reach it
    // Personal app on a private tailnet: allow any host (Tailscale IP or
    // MagicDNS name) so Vite never answers "Blocked request ... is not allowed".
    allowedHosts: true,
  },
  preview: {
    port: 7891,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
})
