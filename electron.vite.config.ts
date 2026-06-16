import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { resolve } from 'path';
import { execSync } from 'child_process';

function getGitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __GIT_COMMIT__: JSON.stringify(getGitCommit()),
    },
    build: {
      outDir: 'dist/main',
      lib: {
        entry: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'orchestration-mcp-shim': resolve(__dirname, 'src/main/agent/orchestration-mcp-shim.ts'),
        },
      },
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
      },
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
    css: {
      postcss: {
        plugins: [tailwindcss, autoprefixer],
      },
    },
  },
});
