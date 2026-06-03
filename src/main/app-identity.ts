/**
 * The Electron app name used to resolve `app.getPath('userData')`.
 *
 * MUST remain `'sandstorm-desktop'`. Electron derives the userData directory
 * (`~/.config/<name>` on Linux, equivalents elsewhere) from `app.getName()`,
 * which defaults to the package.json `name` field. In #485 the package was
 * renamed `sandstorm-desktop` -> `sandstorm` to change the product/artifact
 * name; that silently moved userData to `~/.config/sandstorm`, so every
 * existing project and ticket-provider config became invisible (a fresh,
 * empty SQLite DB was created instead).
 *
 * Pinning the name here via `app.setName(APP_USER_DATA_NAME)` decouples the
 * data directory from the package/product name, so a future rename can never
 * strand user data again. Do not change this value.
 */
export const APP_USER_DATA_NAME = 'sandstorm-desktop';
