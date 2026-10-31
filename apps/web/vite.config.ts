import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development: the web app (5173) proxies the API and Socket.IO to the server (4000), so the
// browser sees a single origin. The E2E run serves the built app from the server instead.
const SERVER = process.env.STUDYSYNC_SERVER_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': SERVER,
      '/socket.io': { target: SERVER, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
