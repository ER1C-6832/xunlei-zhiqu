import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

function assertSelfContainedContentScript(): Plugin {
  return {
    name: 'assert-self-contained-content-script',
    generateBundle(_options, bundle) {
      const contentChunk = Object.values(bundle).find(
        (item) => item.type === 'chunk' && item.name === 'content'
      );
      if (!contentChunk || contentChunk.type !== 'chunk') {
        this.error('content.js entry was not generated');
        return;
      }
      if (contentChunk.imports.length || contentChunk.dynamicImports.length) {
        this.error(
          `MV3 content.js must be self-contained; found imports: ${[
            ...contentChunk.imports,
            ...contentChunk.dynamicImports
          ].join(', ')}`
        );
      }
    }
  };
}

function injectRuntimeEndpoint(runtimeUrl: string): Plugin {
  const declaration = "const RUNTIME_URL = 'http://127.0.0.1:8765';";
  const replacement = `const RUNTIME_URL = ${JSON.stringify(runtimeUrl)};`;
  return {
    name: 'inject-runtime-endpoint',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/StageDApp.tsx') && !id.endsWith('/BatchImagePanel.tsx')) return null;
      if (!code.includes(declaration)) {
        this.error(`Runtime endpoint declaration was not found in ${id}`);
        return null;
      }
      return { code: code.replace(declaration, replacement), map: null };
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const runtimeUrl = (env.VITE_RUNTIME_URL || 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');

  return {
    plugins: [
      react(),
      injectRuntimeEndpoint(runtimeUrl),
      assertSelfContainedContentScript()
    ],
    build: {
      emptyOutDir: true,
      rollupOptions: {
        input: {
          sidepanel: fileURLToPath(new URL('sidepanel.html', import.meta.url)),
          background: fileURLToPath(new URL('src/background.ts', import.meta.url)),
          content: fileURLToPath(new URL('src/content.ts', import.meta.url))
        },
        output: {
          entryFileNames: (chunk) => {
            if (chunk.name === 'background') return 'background.js';
            if (chunk.name === 'content') return 'content.js';
            return 'assets/[name]-[hash].js';
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      }
    }
  };
});
