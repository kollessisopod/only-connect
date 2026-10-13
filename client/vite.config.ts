import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API (Fastify + socket.io) listens on :3000 during development. In production nginx does the same
// proxying (see client/nginx/default.conf), so every URL in the client stays relative.
const API_TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
});
