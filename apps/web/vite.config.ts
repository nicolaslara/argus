import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the browser only ever talks to the Vite origin; these proxies forward
// API/SSE to the local backend server-side, so the server's Host/Origin allowlist
// (boundaries.md §4) stays satisfied and there is no browser CORS surface.
const SERVER_PORT = process.env.ARGUS_PORT ?? '4317';
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/health': { target: SERVER, changeOrigin: true },
      '/stream': { target: SERVER, changeOrigin: true },
    },
  },
});
