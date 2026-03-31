import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify('test'),
  },
  plugins: [
    {
      name: 'build-version-stub',
      resolveId(id) {
        if (id.endsWith('build-version.txt?raw') || id.endsWith('build-version.txt')) {
          return '\0build-version-stub';
        }
      },
      load(id) {
        if (id === '\0build-version-stub') {
          return 'export default "test-build";';
        }
      },
    },
  ],
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 10000,
    cache: false,
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
    },
  },
});
