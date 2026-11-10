import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:3025',
        changeOrigin: true,
      },
    },
  },
});
