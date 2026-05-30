import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useAppStore } from './store';
import './index.css';

// Exposed for Playwright integration tests to seed/inspect renderer state.
// Mirrors the React DevTools view of the same store — no extra surface area for prod.
(window as unknown as { __useAppStore?: typeof useAppStore }).__useAppStore = useAppStore;

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
