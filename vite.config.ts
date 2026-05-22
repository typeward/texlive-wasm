import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    dts({
      entryRoot: 'src',
      outDir: 'dist',
      insertTypesEntry: true,
      rollupTypes: false,
    }),
  ],
  build: {
    target: 'es2022',
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        tauri: resolve(__dirname, 'src/tauri.ts'),
        worker: resolve(__dirname, 'src/core/worker.ts'),
        manifest: resolve(__dirname, 'src/core/manifest.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entry) => `${entry}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['comlink', '@tauri-apps/plugin-fs', 'node:fs', 'node:path', 'node:url'],
      output: {
        preserveModules: false,
      },
    },
    sourcemap: true,
    minify: false,
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
