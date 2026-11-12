import { defineConfig } from 'vite';

export default defineConfig({
  configFile: false,
  build: {
    outDir: 'dist-worker',
    emptyOutDir: true,
    minify: true,
    target: 'esnext',
    assetsInlineLimit: Infinity,
    rollupOptions: {
      input: 'src/database-worker.js',
      output: {
        format: 'iife',
        entryFileNames: 'database-worker.js',
        inlineDynamicImports: true,
      },
    },
  },
});