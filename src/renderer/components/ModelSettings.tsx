import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore, ModelSettings as ModelSettingsType } from '../store';

type Tab = 'global' | 'project';

const INNER_MODEL_OPTIONS = [
  { id: 'auto', label: 'Auto', desc: 'Outer Claude triages' },
  { id: 'sonnet', label: 'Sonnet', desc: 'Fast & efficient' },
  { id: 'opus', label: 'Opus', desc: 'Most capable' },
] as const;

const OUTER_MODEL_OPTIONS = [
  { id: 'sonnet', label: 'Sonnet', desc: 'Fast & efficient' },
  { id: 'opus', label: 'Opus', desc: 'Most capable' },
] as const;

const PROJECT_INNER_OPTIONS = [
  { id: 'global', label: 'Use Global Default', desc: '' },
  ...INNER_MODEL_OPTIONS,
] as const;

const PROJECT_OUTER_OPTIONS = [
  { id: 'global', label: 'Use Global Default', desc: '' },
  ...OUTER_MODEL_OPTIONS,
] as const;

function ModelButton({
  id,
  label,
  desc,
  selected,
  onClick,
  testId,
}: {
  id: string;
  label: string;
  desc: string;
  selected: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
        selected
          ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
          : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
      }`}
      data-testid={testId ?? `model-setting-${id}`}
    >
      {label}
      {desc && <span className="text-[10px] block text-sandstorm-muted mt-0.5">{desc}</span>}
    </button>
  );
}

export function ModelSettingsModal() {
  const {
    setShowModelSettings,
    globalModelSettings,
    refreshGlobalModelSettings,
    setGlobalModelSettings,
    activeProject,
    getProjectModelSettings,
    setProjectModelSettings,
  } = useAppStore();

  const project = activeProject();
  const [activeTab, setActiveTab] = useState<Tab>(project ? 'project' : 'global');

  // Global settings state
  const [globalInner, setGlobalInner] = useState(globalModelSettings.inner_model);
  const [globalOuter, setGlobalOuter] = useState(globalModelSettings.outer_model);
  const [globalDirty, setGlobalDirty] = useState(false);

  // Project settings state
  const [projectInner, setProjectInner] = useState('global');
  const [projectOuter, setProjectOuter] = useState('global');
  const [projectDirty, setProjectDirty] = useState(false);
  const [projectLoaded, setProjectLoaded] = useState(false);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    refreshGlobalModelSettings();
  }, [refreshGlobalModelSettings]);

  useEffect(() => {
    setGlobalInner(globalModelSettings.inner_model);
    setGlobalOuter(globalModelSettings.outer_model);
  }, [globalModelSettings]);

  const loadProjectSettings = useCallback(async () => {
    if (!project) return;
    const settings = await getProjectModelSettings(project.directory);
    if (settings) {
      setProjectInner(settings.inner_model);
      setProjectOuter(settings.outer_model);
    } else {
      setProjectInner('global');
      setProjectOuter('global');
    }
    setProjectLoaded(true);
    setProjectDirty(false);
  }, [project, getProjectModelSettings]);

  useEffect(() => {
    loadProjectSettings();
  }, [loadProjectSettings]);

  const handleSaveGlobal = async () => {
    setSaving(true);
    try {
      await setGlobalModelSettings({ inner_model: globalInner, outer_model: globalOuter });
      setGlobalDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProject = async () => {
    if (!project) return;
    setSaving(true);
    try {
      await setProjectModelSettings(project.directory, {
        inner_model: projectInner,
        outer_model: projectOuter,
      });
      setProjectDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: Tab; label: string; disabled?: boolean }[] = [
    { id: 'global', label: 'Global Defaults' },
    { id: 'project', label: project ? `Project: ${project.name}` : 'Project', disabled: !project },
  ];

  const effectiveInner = projectInner === 'global' ? globalInner : projectInner;
  const effectiveOuter = projectOuter === 'global' ? globalOuter : projectOuter;

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) setShowModelSettings(false); }}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[520px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Model Settings</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">Configure default models for inner and outer Claude</p>
          </div>
          <button
            onClick={() => setShowModelSettings(false)}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover"
            data-testid="model-settings-close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-4 flex gap-1 border-b border-sandstorm-border">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => !tab.disabled && setActiveTab(tab.id)}
              disabled={tab.disabled}
              className={`px-4 py-2.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px ${
                activeTab === tab.id
                  ? 'border-sandstorm-accent text-sandstorm-accent bg-sandstorm-surface'
                  : tab.disabled
                    ? 'border-transparent text-sandstorm-muted/40 cursor-not-allowed'
                    : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text'
              }`}
              data-testid={`model-settings-tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5">
          {activeTab === 'global' && (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Default Inner Model
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Model used for stack execution (inner Claude agent)
                </p>
                <div className="flex gap-2">
                  {INNER_MODEL_OPTIONS.map((m) => (
                    <ModelButton
                      key={m.id}
                      id={m.id}
                      label={m.label}
                      desc={m.desc}
                      selected={globalInner === m.id}
                      onClick={() => { setGlobalInner(m.id); setGlobalDirty(true); }}
                      testId={`global-inner-${m.id}`}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Default Outer Model
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Model used for orchestration (outer Claude)
                </p>
                <div className="flex gap-2">
                  {OUTER_MODEL_OPTIONS.map((m) => (
                    <ModelButton
                      key={m.id}
                      id={m.id}
                      label={m.label}
                      desc={m.desc}
                      selected={globalOuter === m.id}
                      onClick={() => { setGlobalOuter(m.id); setGlobalDirty(true); }}
                      testId={`global-outer-${m.id}`}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {activeTab === 'project' && project && projectLoaded && (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Inner Model Override
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Override the global default for this project
                </p>
                <div className="flex gap-2 flex-wrap">
                  {PROJECT_INNER_OPTIONS.map((m) => (
                    <ModelButton
                      key={m.id}
                      id={m.id}
                      label={m.label}
                      desc={m.desc}
                      selected={projectInner === m.id}
                      onClick={() => { setProjectInner(m.id); setProjectDirty(true); }}
                      testId={`project-inner-${m.id}`}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Outer Model Override
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Override the global default for this project
                </p>
                <div className="flex gap-2 flex-wrap">
                  {PROJECT_OUTER_OPTIONS.map((m) => (
                    <ModelButton
                      key={m.id}
                      id={m.id}
                      label={m.label}
                      desc={m.desc}
                      selected={projectOuter === m.id}
                      onClick={() => { setProjectOuter(m.id); setProjectDirty(true); }}
                      testId={`project-outer-${m.id}`}
                    />
                  ))}
                </div>
              </div>

              {/* Effective model summary */}
              <div className="bg-sandstorm-bg border border-sandstorm-border rounded-lg px-4 py-3">
                <p className="text-[11px] font-medium text-sandstorm-text-secondary mb-1.5">Effective Models</p>
                <div className="flex gap-4 text-[11px]">
                  <span className="text-sandstorm-muted">
                    Inner: <span className="text-sandstorm-text font-medium" data-testid="effective-inner">{effectiveInner}</span>
                  </span>
                  <span className="text-sandstorm-muted">
                    Outer: <span className="text-sandstorm-text font-medium" data-testid="effective-outer">{effectiveOuter}</span>
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={() => setShowModelSettings(false)}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={activeTab === 'global' ? handleSaveGlobal : handleSaveProject}
            disabled={saving || (activeTab === 'global' ? !globalDirty : !projectDirty)}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
            data-testid="model-settings-save"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
