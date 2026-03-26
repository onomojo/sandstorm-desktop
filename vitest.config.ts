import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify('test'),
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 10000,
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
    },
  },
});
