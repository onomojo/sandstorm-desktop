import { Tray, Menu, BrowserWindow, Notification, nativeImage, app } from 'electron';
import path from 'path';
import { registry } from './index';

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow): void {
  // Create a simple tray icon (16x16 transparent for now — replaced by actual icon in resources)
  const iconPath = path.join(__dirname, '../../resources/icon.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    // Fallback: create a tiny icon
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Sandstorm Desktop');

  const updateMenu = (): void => {
    const stacks = registry.listStacks();
    const needsAttention = stacks.filter(
      (s) => s.status === 'completed' || s.status === 'failed'
    );

    const stackItems: Electron.MenuItemConstructorOptions[] = stacks.map((s) => {
      const statusEmoji =
        s.status === 'running'
          ? '\u{1F535}'
          : s.status === 'completed'
            ? '\u{1F7E2}'
            : s.status === 'failed'
              ? '\u{1F534}'
              : s.status === 'up' || s.status === 'idle'
                ? '\u{1F7E1}'
                : '\u{26AB}';

      return {
        label: `${statusEmoji} ${s.id} — ${s.status.toUpperCase()}`,
        click: () => {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('navigate:stack', s.id);
        },
      };
    });

    const menu = Menu.buildFromTemplate([
      {
        label: `Sandstorm Desktop${needsAttention.length > 0 ? ` (${needsAttention.length} need review)` : ''}`,
        enabled: false,
      },
      { type: 'separator' },
      ...(stackItems.length > 0
        ? stackItems
        : [{ label: 'No stacks running', enabled: false } as Electron.MenuItemConstructorOptions]),
      { type: 'separator' },
      {
        label: 'Show Dashboard',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);

    tray!.setContextMenu(menu);

    // Update badge/tooltip
    if (needsAttention.length > 0) {
      tray!.setToolTip(
        `Sandstorm Desktop — ${needsAttention.length} stack(s) need review`
      );
    } else {
      tray!.setToolTip('Sandstorm Desktop');
    }
  };

  // Update menu periodically
  updateMenu();
  setInterval(updateMenu, 5000);

  tray.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

export function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}
