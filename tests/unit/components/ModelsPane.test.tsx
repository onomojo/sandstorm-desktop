/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { buildModelsPane } from '../../../src/renderer/components/config/ModelsPane';
import { TOUCHPOINTS } from '../../../src/main/control-plane/routing';
import { ConfigPaneContext, ModelRoutingApi } from '../../../src/renderer/components/config/types';

afterEach(cleanup);

const CC_MODELS = [
  { backend: 'claude', model: 'opus', label: 'Opus 4.8', version: 'claude-opus-4-8', provider: 'anthropic', available: true },
  { backend: 'claude', model: 'sonnet', label: 'Sonnet 4.6', version: 'claude-sonnet-4-6', provider: 'anthropic', available: true },
  { backend: 'claude', model: 'haiku', label: 'Haiku 4.5', version: 'claude-haiku-4-5', provider: 'anthropic', available: true },
];

const CC_MODELS_WITH_OC = [
  ...CC_MODELS,
  { backend: 'opencode', model: 'gpt-4o', label: 'GPT-4o', version: 'gpt-4o-2024-11', provider: 'openai', available: true },
];

const CC_MODELS_WITH_OC_DISABLED = [
  ...CC_MODELS,
  { backend: 'opencode', model: 'gpt-4o', label: 'GPT-4o', version: 'gpt-4o-2024-11', provider: 'openai', available: false },
];

function makeRouting(overrides: Partial<ModelRoutingApi> = {}): ModelRoutingApi {
  return {
    getEffective: vi.fn().mockResolvedValue({
      outer: { backend: 'claude', model: 'opus' },
      refine: { backend: 'claude', model: 'sonnet' },
      execution: { backend: 'claude', model: 'sonnet' },
      review: { backend: 'claude', model: 'opus' },
      meta_review: { backend: 'claude', model: 'opus' },
      merge_conflict: { backend: 'claude', model: 'sonnet' },
      pr_description: { backend: 'claude', model: 'haiku' },
    }),
    getProject: vi.fn().mockResolvedValue(null),
    setProject: vi.fn().mockResolvedValue(undefined),
    removeProject: vi.fn().mockResolvedValue(undefined),
    getGlobal: vi.fn().mockResolvedValue({ assignments: {}, preset: null }),
    setGlobal: vi.fn().mockResolvedValue(undefined),
    applyPreset: vi.fn().mockResolvedValue(undefined),
    getAvailableModels: vi.fn().mockResolvedValue(CC_MODELS),
    ...overrides,
  };
}

function makeCtx(routing: ModelRoutingApi, overrides: Partial<ConfigPaneContext> = {}): ConfigPaneContext {
  return {
    projectDir: '/test/project',
    routing,
    onDirtyChange: vi.fn(),
    registerSave: vi.fn(),
    ...overrides,
  };
}

// Render the pane and flush all pending async effects (load completes before returning).
async function renderPane(ctx: ConfigPaneContext) {
  const pane = await buildModelsPane(ctx);
  await act(async () => {
    render(<>{pane.render()}</>);
    // Yield past all microtasks so the async useEffect load resolves before we interact.
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe('ModelsPane', () => {
  describe('preset cards', () => {
    it('renders 3 preset cards with verbatim copy', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);

      expect(screen.getByTestId('preset-card-max_quality')).toBeDefined();
      expect(screen.getByTestId('preset-card-balanced')).toBeDefined();
      expect(screen.getByTestId('preset-card-budget')).toBeDefined();

      expect(screen.getByText('Max quality')).toBeDefined();
      expect(screen.getByText('~$0.90 / ticket')).toBeDefined();
      expect(screen.getByText('Opus everywhere reasoning matters. Best results, highest cost.')).toBeDefined();

      expect(screen.getByText('Balanced')).toBeDefined();
      expect(screen.getByText('~$0.42 / ticket')).toBeDefined();
      expect(screen.getByText('Opus for review & orchestration, Sonnet for execution, Haiku for cheap steps.')).toBeDefined();

      expect(screen.getByText('Budget')).toBeDefined();
      expect(screen.getByText('~$0.11 / ticket')).toBeDefined();
      expect(screen.getByText('Haiku & local/open models wherever they hold up. Cheapest.')).toBeDefined();
    });

    it('clicking a preset card selects it and marks dirty with no IPC call', async () => {
      const routing = makeRouting();
      const onDirtyChange = vi.fn();
      const ctx = makeCtx(routing, { onDirtyChange });
      await renderPane(ctx);

      onDirtyChange.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByTestId('preset-card-balanced'));
      });

      expect(routing.setProject).not.toHaveBeenCalled();
      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it('preset card is highlighted when active', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({ preset: 'budget', assignments: {} }),
      });
      const ctx = makeCtx(routing);
      await renderPane(ctx);

      const card = screen.getByTestId('preset-card-budget');
      expect(card.className).toContain('border-sandstorm-accent');
    });

    it('no preset card highlighted when project has no preset', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);

      const maxCard = screen.getByTestId('preset-card-max_quality');
      const balancedCard = screen.getByTestId('preset-card-balanced');
      const budgetCard = screen.getByTestId('preset-card-budget');
      expect(maxCard.className).not.toContain('border-sandstorm-accent');
      expect(balancedCard.className).not.toContain('border-sandstorm-accent');
      expect(budgetCard.className).not.toContain('border-sandstorm-accent');
    });

    it('preset click clears buffered overrides', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({
          preset: 'balanced',
          assignments: { execution: { backend: 'claude', model: 'opus' } },
        }),
      });
      const ctx = makeCtx(routing);
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      expect(screen.getByTestId('override-badge-execution')).toBeDefined();

      await act(async () => {
        fireEvent.click(screen.getByTestId('preset-card-max_quality'));
      });

      expect(screen.queryByTestId('override-badge-execution')).toBeNull();
    });
  });

  describe('customize toggle', () => {
    it('toggle is off by default', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);
      const toggle = screen.getByTestId('customize-toggle');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });

    it('toggle reveals 7 touchpoint rows in TOUCHPOINTS order', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      const rows = screen.getAllByTestId(/^touchpoint-row-/);
      expect(rows).toHaveLength(7);
      expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(
        TOUCHPOINTS.map((t) => `touchpoint-row-${t}`)
      );
    });

    it('touchpoint rows show verbatim labels', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      expect(screen.getByText('Outer orchestrator')).toBeDefined();
      expect(screen.getByText('Refine')).toBeDefined();
      expect(screen.getByText('Execution')).toBeDefined();
      expect(screen.getByText('Review')).toBeDefined();
      expect(screen.getByText('Meta-review')).toBeDefined();
      expect(screen.getByText('Merge conflicts')).toBeDefined();
      expect(screen.getByText('PR description')).toBeDefined();
    });

    it('toggle off with overrides shows "N overrides hidden" hint and retains them', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({
          preset: null,
          assignments: {
            execution: { backend: 'claude', model: 'opus' },
            review: { backend: 'claude', model: 'sonnet' },
          },
        }),
      });
      const ctx = makeCtx(routing);
      await renderPane(ctx);

      // Toggle is off by default; overrides are loaded in buffered state → hint shows
      const hint = screen.getByTestId('overrides-hidden-hint');
      expect(hint.textContent).toContain('2 overrides hidden');
    });

    it('no hint shown when toggle off and no overrides', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);
      expect(screen.queryByTestId('overrides-hidden-hint')).toBeNull();
    });
  });

  describe('model dropdowns', () => {
    it('rows list injected CC models; OC group absent when no OC entries', async () => {
      const ctx = makeCtx(makeRouting());
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      expect(screen.queryByTestId('optgroup-opencode-outer')).toBeNull();
      expect(screen.getByTestId('optgroup-claude-outer')).toBeDefined();
    });

    it('OC group appears when fixtures contain OC entries', async () => {
      const routing = makeRouting({
        getAvailableModels: vi.fn().mockResolvedValue(CC_MODELS_WITH_OC),
      });
      const ctx = makeCtx(routing);
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      expect(screen.getByTestId('optgroup-opencode-outer')).toBeDefined();
    });

    it('OC rows are disabled when available:false', async () => {
      const routing = makeRouting({
        getAvailableModels: vi.fn().mockResolvedValue(CC_MODELS_WITH_OC_DISABLED),
      });
      const ctx = makeCtx(routing);
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      const select = screen.getByTestId('model-select-outer') as HTMLSelectElement;
      const ocOption = Array.from(select.options).find((o) => o.value === 'opencode:gpt-4o');
      expect(ocOption).toBeDefined();
      expect(ocOption!.disabled).toBe(true);
    });

    it('changing a row marks it overridden and dirty, with no immediate IPC', async () => {
      const routing = makeRouting();
      const onDirtyChange = vi.fn();
      const ctx = makeCtx(routing, { onDirtyChange });
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      onDirtyChange.mockClear();

      await act(async () => {
        const select = screen.getByTestId('model-select-execution') as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'claude:opus' } });
      });

      expect(routing.setProject).not.toHaveBeenCalled();
      expect(screen.getByTestId('override-badge-execution')).toBeDefined();
      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it('unknown stored model renders as disabled "unknown (<id>)" entry', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({
          preset: null,
          assignments: { outer: { backend: 'claude', model: 'unknown-model-xyz' } },
        }),
      });
      const ctx = makeCtx(routing);
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      const unknownOpt = screen.getByTestId('unknown-model-outer') as HTMLOptionElement;
      expect(unknownOpt).toBeDefined();
      expect(unknownOpt.disabled).toBe(true);
      expect(unknownOpt.textContent).toContain('unknown');
      expect(unknownOpt.textContent).toContain('unknown-model-xyz');
    });
  });

  describe('save handler', () => {
    it('registerSave is called on mount', async () => {
      const registerSave = vi.fn();
      const ctx = makeCtx(makeRouting(), { registerSave });
      await renderPane(ctx);
      expect(registerSave).toHaveBeenCalledOnce();
    });

    it('save handler calls setProject exactly once with buffered state', async () => {
      const routing = makeRouting();
      const registerSave = vi.fn();
      const ctx = makeCtx(routing, { registerSave });
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('preset-card-balanced'));
      });

      const saveFn = registerSave.mock.calls[0][0] as () => Promise<void>;
      await act(async () => {
        await saveFn();
      });

      expect(routing.setProject).toHaveBeenCalledOnce();
      expect(routing.setProject).toHaveBeenCalledWith('/test/project', {
        preset: 'balanced',
        assignments: {},
      });
    });

    it('save handler captures latest buffered state via ref', async () => {
      const routing = makeRouting();
      const registerSave = vi.fn();
      const ctx = makeCtx(routing, { registerSave });
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('customize-toggle'));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('preset-card-max_quality'));
      });

      await act(async () => {
        const select = screen.getByTestId('model-select-execution') as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'claude:haiku' } });
      });

      const saveFn = registerSave.mock.calls[0][0] as () => Promise<void>;
      await act(async () => {
        await saveFn();
      });

      expect(routing.setProject).toHaveBeenCalledWith('/test/project', {
        preset: 'max_quality',
        assignments: { execution: { backend: 'claude', model: 'haiku' } },
      });
    });

    it('dirty resets to false after save', async () => {
      const routing = makeRouting();
      const registerSave = vi.fn();
      const onDirtyChange = vi.fn();
      const ctx = makeCtx(routing, { registerSave, onDirtyChange });
      await renderPane(ctx);

      await act(async () => {
        fireEvent.click(screen.getByTestId('preset-card-balanced'));
      });

      onDirtyChange.mockClear();

      const saveFn = registerSave.mock.calls[0][0] as () => Promise<void>;
      await act(async () => {
        await saveFn();
      });

      expect(onDirtyChange).toHaveBeenCalledWith(false);
    });
  });

  describe('badge', () => {
    it('badge is preset title when preset set with no overrides', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({ preset: 'balanced', assignments: {} }),
      });
      const pane = await buildModelsPane(makeCtx(routing));
      expect(pane.badge).toBe('Balanced');
    });

    it('badge is preset title with override count (plural) when preset set with multiple overrides', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({
          preset: 'max_quality',
          assignments: {
            execution: { backend: 'claude', model: 'haiku' },
            review: { backend: 'claude', model: 'sonnet' },
          },
        }),
      });
      const pane = await buildModelsPane(makeCtx(routing));
      expect(pane.badge).toBe('Max quality · 2 overrides');
    });

    it('badge is preset title with singular "override" when exactly one override', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({
          preset: 'budget',
          assignments: { execution: { backend: 'claude', model: 'opus' } },
        }),
      });
      const pane = await buildModelsPane(makeCtx(routing));
      expect(pane.badge).toBe('Budget · 1 override');
    });

    it('badge is "Custom" when overrides exist with no preset', async () => {
      const routing = makeRouting({
        getProject: vi.fn().mockResolvedValue({
          preset: null,
          assignments: { execution: { backend: 'claude', model: 'opus' } },
        }),
      });
      const pane = await buildModelsPane(makeCtx(routing));
      expect(pane.badge).toBe('Custom');
    });

    it('badge is undefined when no preset and no overrides', async () => {
      const routing = makeRouting({ getProject: vi.fn().mockResolvedValue(null) });
      const pane = await buildModelsPane(makeCtx(routing));
      expect(pane.badge).toBeUndefined();
    });
  });

  describe('cross-project isolation', () => {
    it('rebuilding with a different projectDir loads fresh state', async () => {
      const routingA = makeRouting({
        getProject: vi.fn().mockResolvedValue({ preset: 'balanced', assignments: {} }),
      });
      const ctxA = makeCtx(routingA, { projectDir: '/project/a' });
      const paneA = await buildModelsPane(ctxA);
      let unmountA!: () => void;
      await act(async () => {
        const result = render(<>{paneA.render()}</>);
        unmountA = result.unmount;
        await new Promise<void>((r) => setTimeout(r, 0));
      });

      const balancedCard = screen.getByTestId('preset-card-balanced');
      expect(balancedCard.className).toContain('border-sandstorm-accent');

      unmountA();

      const routingB = makeRouting({
        getProject: vi.fn().mockResolvedValue({ preset: 'budget', assignments: {} }),
      });
      const ctxB = makeCtx(routingB, { projectDir: '/project/b' });
      await renderPane(ctxB);

      const budgetCard = screen.getByTestId('preset-card-budget');
      expect(budgetCard.className).toContain('border-sandstorm-accent');
      const balancedCardB = screen.getByTestId('preset-card-balanced');
      expect(balancedCardB.className).not.toContain('border-sandstorm-accent');
    });
  });
});
