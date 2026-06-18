import React, { useState, useEffect, useRef } from 'react';
import {
  TOUCHPOINTS,
  TouchpointId,
  PRESETS,
  PresetId,
  AvailableModel,
  RoutingAssignment,
} from '../../../main/control-plane/routing';
import { ConfigPane, ConfigPaneContext } from './types';

const TOUCHPOINT_META: Record<TouchpointId, { label: string; description: string }> = {
  outer: { label: 'Outer orchestrator', description: 'Drives the chat session, plans & dispatches' },
  refine: { label: 'Refine', description: 'Turns a ticket into a detailed spec' },
  execution: { label: 'Execution', description: 'Inner worker that writes the code' },
  review: { label: 'Review', description: 'Reviews the diff for bugs & quality' },
  meta_review: { label: 'Meta-review', description: 'Final gate; reviews the reviewer' },
  merge_conflict: { label: 'Merge conflicts', description: 'Resolves rebase / merge conflicts' },
  pr_description: { label: 'PR description', description: 'Writes the PR title & body' },
};

const PRESET_META: Record<PresetId, { title: string; costHint: string; description: string }> = {
  max_quality: {
    title: 'Max quality',
    costHint: '~$0.90 / ticket',
    description: 'Opus everywhere reasoning matters. Best results, highest cost.',
  },
  balanced: {
    title: 'Balanced',
    costHint: '~$0.42 / ticket',
    description: 'Opus for review & orchestration, Sonnet for execution, Haiku for cheap steps.',
  },
  budget: {
    title: 'Budget',
    costHint: '~$0.11 / ticket',
    description: 'Haiku & local/open models wherever they hold up. Cheapest.',
  },
};

const PRESET_ORDER: PresetId[] = ['max_quality', 'balanced', 'budget'];

type BufferedState = {
  preset: PresetId | null;
  assignments: Partial<Record<TouchpointId, RoutingAssignment>>;
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function computeBadge(buffered: BufferedState): string | undefined {
  const overrideCount = Object.keys(buffered.assignments).length;
  if (buffered.preset !== null) {
    const title = PRESET_META[buffered.preset].title;
    if (overrideCount > 0) {
      return `${title} · ${overrideCount} override${overrideCount === 1 ? '' : 's'}`;
    }
    return title;
  }
  if (overrideCount > 0) {
    return 'Custom';
  }
  return undefined;
}

interface ModelsPaneBodyProps {
  ctx: ConfigPaneContext;
}

function ModelsPaneBody({ ctx }: ModelsPaneBodyProps) {
  const { projectDir, routing, onDirtyChange, registerSave } = ctx;

  const [baseline, setBaseline] = useState<BufferedState>({ preset: null, assignments: {} });
  const [buffered, setBuffered] = useState<BufferedState>({ preset: null, assignments: {} });
  const [customize, setCustomize] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [effectiveRouting, setEffectiveRouting] = useState<Record<string, { backend: string; model: string }>>({});

  const bufferedRef = useRef(buffered);
  bufferedRef.current = buffered;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [projectConfig, models, effective] = await Promise.all([
        routing.getProject(projectDir),
        routing.getAvailableModels(projectDir),
        routing.getEffective(projectDir),
      ]);
      if (cancelled) return;
      const initial: BufferedState = projectConfig
        ? {
            preset: (projectConfig.preset as PresetId | null),
            assignments: (projectConfig.assignments as Partial<Record<TouchpointId, RoutingAssignment>>),
          }
        : { preset: null, assignments: {} };
      setBaseline(initial);
      setBuffered(initial);
      setAvailableModels(models as AvailableModel[]);
      setEffectiveRouting(effective);
    }
    load();
    return () => { cancelled = true; };
  }, [projectDir]);

  useEffect(() => {
    registerSave(async () => {
      const current = bufferedRef.current;
      await routing.setProject(projectDir, {
        preset: current.preset,
        assignments: current.assignments,
      });
      setBaseline({ ...current });
    });
  }, [projectDir]);

  useEffect(() => {
    onDirtyChange(!deepEqual(buffered, baseline));
  }, [buffered, baseline]);

  function handlePresetClick(presetId: PresetId) {
    setBuffered({ preset: presetId, assignments: {} });
  }

  function handleToggleCustomize() {
    setCustomize((v) => !v);
  }

  function getDisplayAssignment(touchpoint: TouchpointId): { backend: string; model: string } | null {
    if (buffered.preset !== null && PRESETS[buffered.preset]) {
      return PRESETS[buffered.preset][touchpoint];
    }
    return effectiveRouting[touchpoint] ?? null;
  }

  function handleRowChange(touchpoint: TouchpointId, backend: string, model: string) {
    const display = getDisplayAssignment(touchpoint);
    const isPresetValue =
      buffered.preset !== null &&
      display?.backend === backend &&
      display?.model === model;

    if (isPresetValue) {
      setBuffered((prev) => {
        const next = { ...prev.assignments };
        delete next[touchpoint];
        return { ...prev, assignments: next };
      });
    } else {
      setBuffered((prev) => ({
        ...prev,
        assignments: {
          ...prev.assignments,
          [touchpoint]: { backend: backend as 'claude' | 'opencode', model },
        },
      }));
    }
  }

  const ccModels = availableModels.filter((m) => m.backend === 'claude');
  const ocModels = availableModels.filter((m) => m.backend === 'opencode');
  const hasOC = ocModels.length > 0;
  const overrideCount = Object.keys(buffered.assignments).length;

  return (
    <div className="space-y-6" data-testid="models-pane">
      {/* Preset cards */}
      <div>
        <h3 className="text-xs font-semibold text-sandstorm-text-secondary uppercase tracking-wide mb-3">
          Preset
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="preset-cards">
          {PRESET_ORDER.map((presetId) => {
            const meta = PRESET_META[presetId];
            const isActive = buffered.preset === presetId;
            return (
              <button
                key={presetId}
                onClick={() => handlePresetClick(presetId)}
                data-testid={`preset-card-${presetId}`}
                className={`text-left p-3 rounded-lg border transition-all ${
                  isActive
                    ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-text'
                    : 'border-sandstorm-border hover:border-sandstorm-border-light text-sandstorm-text-secondary hover:text-sandstorm-text'
                }`}
              >
                <div className="text-xs font-semibold mb-0.5">{meta.title}</div>
                <div className="text-[10px] text-sandstorm-muted mb-1">{meta.costHint}</div>
                <div className="text-[10px] leading-tight">{meta.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Customize per step toggle */}
      <div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-sandstorm-text">Customize per step</div>
            <div className="text-[10px] text-sandstorm-muted mt-0.5">
              Override individual touchpoints on top of the preset.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={customize}
            onClick={handleToggleCustomize}
            data-testid="customize-toggle"
            className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
              customize ? 'bg-sandstorm-accent' : 'bg-sandstorm-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                customize ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {!customize && overrideCount > 0 && (
          <div
            className="mt-2 text-[10px] text-sandstorm-muted"
            data-testid="overrides-hidden-hint"
          >
            {overrideCount} override{overrideCount === 1 ? '' : 's'} hidden
          </div>
        )}
      </div>

      {/* Touchpoint rows */}
      {customize && (
        <div data-testid="touchpoint-rows">
          <h3 className="text-xs font-semibold text-sandstorm-text-secondary uppercase tracking-wide mb-3">
            Per-step model
          </h3>
          <div className="space-y-2">
            {TOUCHPOINTS.map((touchpoint) => {
              const meta = TOUCHPOINT_META[touchpoint];
              const isOverridden = touchpoint in buffered.assignments;
              const current = isOverridden
                ? buffered.assignments[touchpoint]!
                : (getDisplayAssignment(touchpoint) ?? { backend: 'claude', model: 'auto' });

              // Build the list of models including any unknown stored model
              const storedInCatalog =
                !isOverridden ||
                availableModels.some(
                  (m) =>
                    m.backend === current.backend && m.model === current.model
                );

              return (
                <div
                  key={touchpoint}
                  className="flex items-center gap-3 py-2"
                  data-testid={`touchpoint-row-${touchpoint}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-sandstorm-text">
                      {meta.label}
                    </div>
                    <div className="text-[10px] text-sandstorm-muted truncate">
                      {meta.description}
                    </div>
                  </div>
                  {isOverridden && (
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded-full bg-sandstorm-accent/20 text-sandstorm-accent font-medium flex-shrink-0"
                      data-testid={`override-badge-${touchpoint}`}
                    >
                      overridden
                    </span>
                  )}
                  <select
                    value={`${current.backend}:${current.model}`}
                    onChange={(e) => {
                      const [b, m] = e.target.value.split(':');
                      handleRowChange(touchpoint, b, m);
                    }}
                    data-testid={`model-select-${touchpoint}`}
                    className="text-xs bg-sandstorm-surface border border-sandstorm-border rounded-lg px-2 py-1 text-sandstorm-text flex-shrink-0 max-w-[180px]"
                  >
                    {/* Unknown stored model not in catalog */}
                    {isOverridden && !storedInCatalog && (
                      <option
                        value={`${current.backend}:${current.model}`}
                        disabled
                        data-testid={`unknown-model-${touchpoint}`}
                      >
                        unknown ({current.model})
                      </option>
                    )}

                    {/* Claude Code group */}
                    {ccModels.length > 0 && (
                      <optgroup label="Claude Code" data-testid={`optgroup-claude-${touchpoint}`}>
                        {ccModels.map((m) => (
                          <option
                            key={`claude:${m.model}`}
                            value={`claude:${m.model}`}
                            disabled={!m.available}
                          >
                            {m.label} ({m.version}){!m.available ? ' — unavailable' : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* OpenCode group — hidden when no OC models */}
                    {hasOC && (
                      <optgroup label="OpenCode" data-testid={`optgroup-opencode-${touchpoint}`}>
                        {ocModels.map((m) => (
                          <option
                            key={`opencode:${m.model}`}
                            value={`opencode:${m.model}`}
                            disabled={!m.available}
                            title={
                              m.needsKey && !m.available
                                ? 'Needs API key — configure in Providers'
                                : undefined
                            }
                          >
                            {m.label} ({m.version}){!m.available ? ' — unavailable' : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export async function buildModelsPane(ctx: ConfigPaneContext): Promise<ConfigPane> {
  const projectConfig = await ctx.routing.getProject(ctx.projectDir);
  const initial: BufferedState = projectConfig
    ? {
        preset: (projectConfig.preset as PresetId | null),
        assignments: (projectConfig.assignments as Partial<Record<TouchpointId, RoutingAssignment>>),
      }
    : { preset: null, assignments: {} };
  const badge = computeBadge(initial);

  return {
    id: 'models',
    label: 'Models',
    icon: <span className="text-sm">⚙</span>,
    badge,
    render: () => <ModelsPaneBody ctx={ctx} />,
  };
}
