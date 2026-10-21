import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Listen on all network interfaces so other devices (e.g. a phone on the
    // same Wi-Fi) can reach the dev server, not just localhost.
    host: true,
    allowedHosts: ['.vercel.run', 'localhost'],
  },
});
