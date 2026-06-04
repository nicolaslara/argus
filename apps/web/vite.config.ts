import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the browser only ever talks to the Vite origin; these proxies forward
// API/SSE to the local backend server-side, so the server's Host/Origin allowlist
// (boundaries.md §4) stays satisfied and there is no browser CORS surface.
//
// Token wiring (M3, secure-by-construction): a shared ARGUS_TOKEN env drives BOTH
// the server (its per-launch token) and this proxy. The proxy injects
// `Authorization: Bearer $ARGUS_TOKEN` server-side via proxy.configure, so the
// browser never sees the token and there is no token in any client JS bundle.
// The server's token check is NOT disabled — it still validates the header.
const SERVER_PORT = process.env.ARGUS_PORT ?? '4317';
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
const ARGUS_TOKEN = process.env.ARGUS_TOKEN ?? '';

/**
 * Vite proxy options that inject the bearer token on every forwarded request.
 * Uses proxy.configure (the http-proxy instance) to set the Authorization header
 * on the OUTGOING proxy request — this runs in the Vite dev server (Node), never
 * in the browser, so the token stays server-side.
 */
function withToken(target: string) {
  return {
    target,
    changeOrigin: true,
    configure: (proxy: {
      on: (event: 'proxyReq', cb: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void;
    }) => {
      if (!ARGUS_TOKEN) return; // no token configured → forward as-is (server will 401)
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.setHeader('Authorization', `Bearer ${ARGUS_TOKEN}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': withToken(SERVER),
      '/health': { target: SERVER, changeOrigin: true },
      '/stream': withToken(SERVER),
    },
  },
});
