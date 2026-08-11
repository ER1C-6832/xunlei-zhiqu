import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ command }: { command: string }) => ({
  plugins: [react()],
  base: command === 'build' ? '/app/' : '/',
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  build: {
    outDir: 'dist'
  }
}));
