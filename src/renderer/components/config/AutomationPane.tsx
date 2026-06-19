import React, { useState, useEffect, useRef } from 'react';
import { ConfigPane, ConfigPaneContext } from './types';

export type AutomationLevel = 'manual' | 'assisted' | 'dark_factory';
export type MergeStrategy = 'squash' | 'merge' | 'rebase';

interface LevelMeta {
  id: AutomationLevel;
  title: string;
  description: string;
  subtext?: string;
  chips: string[];
  youMerge?: boolean;
}

export const AUTOMATION_LEVELS: LevelMeta[] = [
  {
    id: 'manual',
    title: 'Manual',
    description: 'You drive everything.',
    subtext: 'you spin stacks · you open PRs',
    chips: [],
  },
  {
    id: 'assisted',
    title: 'Assisted',
    description: 'Auto-spins a stack and implements on spec_ready; you review & merge the PR.',
    chips: ['✓ spin stack', '✓ implement', '✓ open PR'],
    youMerge: true,
  },
  {
    id: 'dark_factory',
    title: 'Dark Factory',
    description: 'Hands-off. Fully automated from spec_ready through merge. No human in the loop.',
    chips: ['✓ spin stack', '✓ implement', '✓ open PR', '✓ auto-merge'],
  },
];

export const MERGE_STRATEGIES: { id: MergeStrategy; label: string }[] = [
  { id: 'squash', label: 'Squash' },
  { id: 'merge', label: 'Merge' },
  { id: 'rebase', label: 'Rebase' },
];

interface AutomationConfig {
  level: AutomationLevel;
  merge_strategy: MergeStrategy;
}

function AutomationPaneBody({ ctx }: { ctx: ConfigPaneContext }) {
  const { projectDir, darkFactory, onDirtyChange, registerSave } = ctx;

  const [baseline, setBaseline] = useState<AutomationConfig>({ level: 'manual', merge_strategy: 'squash' });
  const [buffered, setBuffered] = useState<AutomationConfig>({ level: 'manual', merge_strategy: 'squash' });

  const bufferedRef = useRef(buffered);
  bufferedRef.current = buffered;

  useEffect(() => {
    let cancelled = false;
    darkFactory.getConfig(projectDir).then((cfg) => {
      if (cancelled) return;
      const config: AutomationConfig = {
        level: (cfg.level as AutomationLevel) || 'manual',
        merge_strategy: (cfg.merge_strategy as MergeStrategy) || 'squash',
      };
      setBaseline(config);
      setBuffered(config);
    });
    return () => { cancelled = true; };
  }, [projectDir]);

  useEffect(() => {
    const isDirty = JSON.stringify(buffered) !== JSON.stringify(baseline);
    onDirtyChange(isDirty);
  }, [buffered, baseline]);

  useEffect(() => {
    registerSave(async () => {
      const current = bufferedRef.current;
      await darkFactory.setConfig(projectDir, current);
      setBaseline(current);
      onDirtyChange(false);
    });
  }, [projectDir]);

  return (
    <div data-testid="automation-pane" className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-sandstorm-fg mb-1">Automation Level</h3>
        <p className="text-xs text-sandstorm-muted mb-3">
          Selecting Assisted or Dark Factory stores your preference but does not yet change pipeline behavior.
        </p>
        <div className="space-y-2">
          {AUTOMATION_LEVELS.map((lvl) => (
            <button
              key={lvl.id}
              data-testid={`level-card-${lvl.id}`}
              className={`w-full text-left p-3 rounded border transition-colors ${
                buffered.level === lvl.id
                  ? 'border-sandstorm-accent bg-sandstorm-accent/10'
                  : 'border-sandstorm-border bg-sandstorm-surface hover:border-sandstorm-muted'
              }`}
              onClick={() => setBuffered((b) => ({ ...b, level: lvl.id }))}
            >
              <div className="font-medium text-sm text-sandstorm-fg">{lvl.title}</div>
              <div className="text-xs text-sandstorm-muted mt-0.5">{lvl.description}</div>
              {lvl.subtext && (
                <div className="text-xs text-sandstorm-muted/70 mt-0.5">{lvl.subtext}</div>
              )}
              {(lvl.chips.length > 0 || lvl.youMerge) && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {lvl.chips.map((chip) => (
                    <span
                      key={chip}
                      className="text-xs px-1.5 py-0.5 rounded bg-sandstorm-accent/20 text-sandstorm-accent"
                    >
                      {chip}
                    </span>
                  ))}
                  {lvl.youMerge && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-sandstorm-surface-2 text-sandstorm-muted">
                      you merge
                    </span>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-sandstorm-fg mb-1">Merge Strategy</h3>
        <div className="flex rounded border border-sandstorm-border overflow-hidden">
          {MERGE_STRATEGIES.map((s) => (
            <button
              key={s.id}
              data-testid={`merge-strategy-${s.id}`}
              className={`flex-1 py-1.5 text-sm transition-colors ${
                buffered.merge_strategy === s.id
                  ? 'bg-sandstorm-accent text-white'
                  : 'bg-sandstorm-surface text-sandstorm-muted hover:bg-sandstorm-surface-2'
              }`}
              onClick={() => setBuffered((b) => ({ ...b, merge_strategy: s.id }))}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function buildAutomationPane(ctx: ConfigPaneContext): ConfigPane {
  return {
    id: 'automation',
    label: 'Automation',
    icon: <span className="text-sm">⚡</span>,
    render: () => <AutomationPaneBody ctx={ctx} />,
  };
}
