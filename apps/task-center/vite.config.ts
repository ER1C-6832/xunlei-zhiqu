import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }: { command: string; mode: string }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const configuredRuntime = (
    process.env.VITE_RUNTIME_URL
    || env.VITE_RUNTIME_URL
    || ''
  ).trim().replace(/\/+$/, '');
  // Dev keeps today's local workflow. Production defaults to same-origin, so the
  // exact same Task Center build can be served by a local Runtime or a remote
  // Runtime/Gateway host without hard-coding 127.0.0.1 into application code.
  const runtimeExpression = configuredRuntime
    ? JSON.stringify(configuredRuntime)
    : command === 'build'
      ? 'window.location.origin'
      : JSON.stringify('http://127.0.0.1:8765');

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_RUNTIME_URL': runtimeExpression
    },
    base: command === 'build' ? '/app/' : '/',
    server: {
      host: '127.0.0.1',
      port: 5173
    },
    build: {
      outDir: 'dist'
    }
  };
});
