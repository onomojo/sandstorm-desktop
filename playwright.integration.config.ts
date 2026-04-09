import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/integration',
  testMatch: '*.spec.ts',
  timeout: 120000,
  retries: 0,
  workers: 1,
  use: {
    trace: 'on-first-retry',
  },
});
