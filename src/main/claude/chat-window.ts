import { BrowserWindow } from 'electron';
import path from 'path';

let chatWindow: BrowserWindow | null = null;

export function openChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return chatWindow;
  }

  chatWindow = new BrowserWindow({
    width: 800,
    height: 700,
    title: 'Sandstorm — Claude Chat',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    chatWindow.loadURL('http://localhost:5173/#/chat');
  } else {
    chatWindow.loadFile(path.join(__dirname, '../../renderer/index.html'), {
      hash: '/chat',
    });
  }

  chatWindow.on('closed', () => {
    chatWindow = null;
  });

  return chatWindow;
}

export function getChatWindow(): BrowserWindow | null {
  return chatWindow && !chatWindow.isDestroyed() ? chatWindow : null;
}
