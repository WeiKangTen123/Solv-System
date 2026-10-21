import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// UI_PORT and API_PORT let a second copy of the app run beside the first (a
// worktree on another branch) without either taking the other's ports.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.UI_PORT) || 5173,
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT || 4000}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
