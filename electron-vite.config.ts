import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

const gitCommitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
})();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    plugins: [react()],
    root: resolve(__dirname, 'src/renderer'),
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommitHash),
    },
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
