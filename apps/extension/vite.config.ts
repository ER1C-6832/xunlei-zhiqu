import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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

export default defineConfig({
  plugins: [
    react(),
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
});
