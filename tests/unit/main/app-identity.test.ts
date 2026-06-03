import { describe, it, expect } from 'vitest';
import { APP_USER_DATA_NAME } from '../../../src/main/app-identity';

/**
 * Regression guard for #485: renaming the package.json `name` to 'sandstorm'
 * moved Electron's userData dir from ~/.config/sandstorm-desktop to
 * ~/.config/sandstorm, hiding every existing project and ticket config behind
 * a fresh empty DB. The main process pins app.setName(APP_USER_DATA_NAME) to
 * decouple the data directory from the package/product name. Locking the value
 * here means any future rename of this constant fails CI loudly instead of
 * silently stranding user data.
 */
describe('APP_USER_DATA_NAME', () => {
  it("is pinned to 'sandstorm-desktop' so userData never moves on rename", () => {
    expect(APP_USER_DATA_NAME).toBe('sandstorm-desktop');
  });
});
