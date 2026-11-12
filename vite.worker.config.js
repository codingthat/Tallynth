import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-worker",
    emptyOutDir: true,
    minify: true,
    target: "esnext",
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: 80000,

    rolldownOptions: {
      input: "src/database-worker.js",
      output: {
        format: "iife",
        entryFileNames: "database-worker.js",
      },

      onLog(level, log, defaultHandler) {
        if (level === "warn") {
          const message = log.message ?? "";

          if (
            log.code === "EMPTY_IMPORT_META" ||
            log.code === "EVAL" ||
            message.includes('Module "node:module" has been externalized')
          ) {
            return;
          }
        }

        defaultHandler(level, log);
      },
    },
  },
});
