/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import App from '../../../src/renderer/App';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('App', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    // App calls docker.status on mount
    (api as any).docker = {
      status: () => Promise.resolve({ connected: true }),
    };
    Object.defineProperty(window, 'sandstorm', {
      value: api,
      writable: true,
      configurable: true,
    });
    useAppStore.setState({
      stacks: [],
      stackHistory: [],
      stackMetrics: {},
      projects: [],
      activeProjectId: null,
      selectedStackId: null,
      showNewStackDialog: false,
      showOpenProjectDialog: false,
      dockerConnected: true,
      error: null,
    });
    // Mock navigator.platform
    Object.defineProperty(navigator, 'platform', {
      value: 'Linux',
      writable: true,
      configurable: true,
    });
  });

  it('displays the git commit hash in the titlebar', () => {
    render(<App />);
    // __GIT_COMMIT__ is defined as 'test' in vitest.config.ts
    expect(screen.getByTitle('Build: test')).toBeDefined();
    expect(screen.getByTitle('Build: test').textContent).toBe('test');
  });

  it('renders the Sandstorm title', () => {
    render(<App />);
    expect(screen.getByText('Sandstorm')).toBeDefined();
  });
});
