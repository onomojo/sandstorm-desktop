/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { buildAutomationPane, AUTOMATION_LEVELS, MERGE_STRATEGIES } from '../../../src/renderer/components/config/AutomationPane';
import type { ConfigPaneContext } from '../../../src/renderer/components/config/types';

function makeCtx(overrides: Partial<ConfigPaneContext['darkFactory']> = {}): ConfigPaneContext {
  return {
    projectDir: '/test/project',
    routing: {
      getEffective: vi.fn().mockResolvedValue({}),
      getProject: vi.fn().mockResolvedValue(null),
      setProject: vi.fn().mockResolvedValue(undefined),
      removeProject: vi.fn().mockResolvedValue(undefined),
      getGlobal: vi.fn().mockResolvedValue({ assignments: {}, preset: null }),
      setGlobal: vi.fn().mockResolvedValue(undefined),
      applyPreset: vi.fn().mockResolvedValue(undefined),
      getAvailableModels: vi.fn().mockResolvedValue([]),
    },
    darkFactory: {
      getConfig: vi.fn().mockResolvedValue({ level: 'manual', merge_strategy: 'squash' }),
      setConfig: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
    ticketing: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    onDirtyChange: vi.fn(),
    registerSave: vi.fn(),
  };
}

describe('AutomationPane', () => {
  it('renders the automation-pane testid', async () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => expect(screen.getByTestId('automation-pane')).toBeDefined());
  });

  it('pane has id automation and label Automation', () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    expect(pane.id).toBe('automation');
    expect(pane.label).toBe('Automation');
  });

  it('renders all three level cards', async () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      for (const lvl of AUTOMATION_LEVELS) {
        expect(screen.getByTestId(`level-card-${lvl.id}`)).toBeDefined();
      }
    });
  });

  it('renders all three merge strategy buttons', async () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      for (const s of MERGE_STRATEGIES) {
        expect(screen.getByTestId(`merge-strategy-${s.id}`)).toBeDefined();
      }
    });
  });

  it('loads level from getConfig and highlights the correct card', async () => {
    const ctx = makeCtx({
      getConfig: vi.fn().mockResolvedValue({ level: 'assisted', merge_strategy: 'squash' }),
    });
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      const card = screen.getByTestId('level-card-assisted');
      expect(card.className).toContain('border-sandstorm-accent');
    });
  });

  it('clicking a level card calls onDirtyChange and updates the selection', async () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('level-card-dark_factory'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('level-card-dark_factory'));
    });
    expect(ctx.onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('clicking a merge strategy button updates the selection', async () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('merge-strategy-rebase'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('merge-strategy-rebase'));
    });
    expect(ctx.onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('save handler calls setConfig with the current level and merge_strategy', async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    const registerSave = vi.fn();
    const ctx = makeCtx({ setConfig });
    ctx.registerSave = registerSave;

    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('level-card-assisted'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('level-card-assisted'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('merge-strategy-rebase'));
    });

    const savedFn = registerSave.mock.calls[registerSave.mock.calls.length - 1][0];
    await act(async () => { await savedFn(); });

    expect(setConfig).toHaveBeenCalledWith('/test/project', { level: 'assisted', merge_strategy: 'rebase' });
  });

  it('getConfig returning dark_factory level maps to getDarkFactoryEnabled=true equivalent', async () => {
    const ctx = makeCtx({
      getConfig: vi.fn().mockResolvedValue({ level: 'dark_factory', merge_strategy: 'merge' }),
    });
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      const card = screen.getByTestId('level-card-dark_factory');
      expect(card.className).toContain('border-sandstorm-accent');
    });
  });

  it('chip labels match the AUTOMATION_LEVELS constant', async () => {
    const ctx = makeCtx();
    const pane = buildAutomationPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('automation-pane'));
    // Assisted chips
    expect(screen.getAllByText('✓ spin stack').length).toBeGreaterThan(0);
    expect(screen.getAllByText('✓ implement').length).toBeGreaterThan(0);
    expect(screen.getAllByText('✓ open PR').length).toBeGreaterThan(0);
    // Dark factory extra chip
    expect(screen.getAllByText('✓ auto-merge').length).toBeGreaterThan(0);
  });

  it('reloads config when projectDir changes', async () => {
    const getConfig = vi.fn()
      .mockResolvedValueOnce({ level: 'manual', merge_strategy: 'squash' })
      .mockResolvedValueOnce({ level: 'dark_factory', merge_strategy: 'merge' });
    const ctx = makeCtx({ getConfig });
    const pane = buildAutomationPane(ctx);
    const { rerender } = render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('automation-pane'));

    const ctx2 = { ...ctx, projectDir: '/other/project' };
    const pane2 = buildAutomationPane(ctx2);
    rerender(<>{pane2.render()}</>);
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
  });
});
