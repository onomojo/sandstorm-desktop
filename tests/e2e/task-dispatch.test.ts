import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['dist/main/index.js'],
  });
});

test.afterAll(async () => {
  await app?.close();
});

// Note: Full task dispatch tests require a running stack with Docker
// These tests verify the UI elements exist

test('app window has correct title', async () => {
  const window = await app.firstWindow();
  const title = await window.title();
  expect(title).toBe('Sandstorm Desktop');
});
