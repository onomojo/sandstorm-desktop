import React, { useState, useEffect, useCallback } from 'react';
import { PROVIDER_METADATA, getProviderMeta } from '../../shared/opencode-providers';

const GLOBAL_BACKEND_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
] as const;

interface GlobalBackendConfigProps {
  surface: 'inner' | 'outer';
  backend: string;
  onBackendChange: (v: string) => void;
  provider: string;
  onProviderChange: (v: string) => void;
  model: string;
  onModelChange: (v: string) => void;
  credBundle: Record<string, string>;
  onCredBundleChange: (bundle: Record<string, string>) => void;
  credSet: boolean;
}

function GlobalBackendConfig({
  surface,
  backend,
  onBackendChange,
  provider,
  onProviderChange,
  model,
  onModelChange,
  credBundle,
  onCredBundleChange,
  credSet,
}: GlobalBackendConfigProps) {
  const prefix = `global-${surface}-backend`;
  const providerMeta = getProviderMeta(provider);

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        {GLOBAL_BACKEND_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onBackendChange(opt.id)}
            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              backend === opt.id
                ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
            }`}
            data-testid={`${prefix}-${opt.id}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {backend === 'opencode' && (
        <div className="space-y-2 pl-1 pt-1" data-testid={`${prefix}-opencode-fields`}>
          <div>
            <label className="block text-[10px] font-medium text-sandstorm-text-secondary mb-1">Provider</label>
            <select
              value={provider}
              onChange={(e) => { onProviderChange(e.target.value); onCredBundleChange({}); }}
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
              data-testid={`${prefix}-provider`}
            >
              {PROVIDER_METADATA.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-sandstorm-text-secondary mb-1">Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder="e.g. anthropic/claude-sonnet-4-6"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
              data-testid={`${prefix}-model`}
            />
          </div>
          <div className="space-y-1.5" data-testid={`${prefix}-cred-fields`}>
            <label className="block text-[10px] font-medium text-sandstorm-text-secondary">
              Credentials
              <span className="ml-2 font-normal text-sandstorm-muted" data-testid={`${prefix}-cred-status`}>
                {credSet ? '(Set)' : '(Not set)'}
              </span>
            </label>
            {providerMeta ? (
              providerMeta.fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-[10px] text-sandstorm-muted mb-0.5">
                    {field.label}{field.required ? ' *' : ''}
                  </label>
                  <input
                    type={field.type === 'password' ? 'password' : 'text'}
                    value={credBundle[field.key] ?? ''}
                    onChange={(e) => {
                      onCredBundleChange({ ...credBundle, [field.key]: e.target.value });
                    }}
                    placeholder={credSet ? 'Enter new value to update' : (field.placeholder ?? '')}
                    className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                    data-testid={`${prefix}-cred-${field.key}`}
                    autoComplete="new-password"
                  />
                </div>
              ))
            ) : (
              <input
                type="password"
                value={credBundle['apiKey'] ?? ''}
                onChange={(e) => onCredBundleChange({ ...credBundle, apiKey: e.target.value })}
                placeholder={credSet ? 'Enter new value to update' : 'Enter API key'}
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                data-testid={`${prefix}-cred-input`}
                autoComplete="new-password"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function GlobalSettingsModal({ onClose }: { onClose: () => void }) {
  const [innerBackend, setInnerBackend] = useState('claude');
  const [innerProvider, setInnerProvider] = useState('anthropic');
  const [innerModel, setInnerModel] = useState('');
  const [innerCredBundle, setInnerCredBundle] = useState<Record<string, string>>({});
  const [innerCredSet, setInnerCredSet] = useState(false);

  const [outerBackend, setOuterBackend] = useState('claude');
  const [outerProvider, setOuterProvider] = useState('anthropic');
  const [outerModel, setOuterModel] = useState('');
  const [outerCredBundle, setOuterCredBundle] = useState<Record<string, string>>({});
  const [outerCredSet, setOuterCredSet] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [settings, innerStatus, outerStatus] = await Promise.all([
        window.sandstorm.backendSettings.getGlobal(),
        window.sandstorm.backendSettings.secretStatus('global', 'inner'),
        window.sandstorm.backendSettings.secretStatus('global', 'outer'),
      ]);
      if (cancelled) return;
      setInnerBackend(settings.inner_backend ?? 'claude');
      setInnerProvider(settings.inner_provider ?? 'anthropic');
      setInnerModel(settings.inner_model ?? '');
      setOuterBackend(settings.outer_backend ?? 'claude');
      setOuterProvider(settings.outer_provider ?? 'anthropic');
      setOuterModel(settings.outer_model ?? '');
      setInnerCredSet(innerStatus.set);
      setOuterCredSet(outerStatus.set);
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await window.sandstorm.backendSettings.setGlobal({
        inner_backend: innerBackend,
        inner_provider: innerBackend === 'opencode' ? (innerProvider || null) : null,
        inner_model: innerBackend === 'opencode' ? (innerModel || null) : null,
        outer_backend: outerBackend,
        outer_provider: outerBackend === 'opencode' ? (outerProvider || null) : null,
        outer_model: outerBackend === 'opencode' ? (outerModel || null) : null,
      });
      if (innerBackend === 'opencode' && Object.values(innerCredBundle).some(Boolean)) {
        await window.sandstorm.backendSettings.setSecretBundle('global', 'inner', innerCredBundle);
        setInnerCredBundle({});
        setInnerCredSet(true);
      }
      if (outerBackend === 'opencode' && Object.values(outerCredBundle).some(Boolean)) {
        await window.sandstorm.backendSettings.setSecretBundle('global', 'outer', outerCredBundle);
        setOuterCredBundle({});
        setOuterCredSet(true);
      }
      setDirty(false);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [innerBackend, innerProvider, innerModel, innerCredBundle, outerBackend, outerProvider, outerModel, outerCredBundle, onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[540px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Settings</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">Configure global backend defaults</p>
          </div>
          <button
            onClick={onClose}
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
          <button
            className="px-4 py-2.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px border-sandstorm-accent text-sandstorm-accent bg-sandstorm-surface"
            data-testid="model-settings-tab-global"
          >
            Global Defaults
          </button>
          <button
            disabled
            className="px-4 py-2.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px border-transparent text-sandstorm-muted/40 cursor-not-allowed"
            data-testid="model-settings-tab-project"
          >
            Project
          </button>
          <button
            disabled
            className="px-4 py-2.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px border-transparent text-sandstorm-muted/40 cursor-not-allowed"
            data-testid="model-settings-tab-ticketing"
          >
            Ticketing
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5">
          <div>
            <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
              Inner Agent Backend
            </label>
            <p className="text-[10px] text-sandstorm-muted mb-2">
              Backend used for stack execution (inner agent)
            </p>
            <GlobalBackendConfig
              surface="inner"
              backend={innerBackend}
              onBackendChange={(v) => { setInnerBackend(v); setDirty(true); }}
              provider={innerProvider}
              onProviderChange={(v) => { setInnerProvider(v); setDirty(true); }}
              model={innerModel}
              onModelChange={(v) => { setInnerModel(v); setDirty(true); }}
              credBundle={innerCredBundle}
              onCredBundleChange={(b) => { setInnerCredBundle(b); setDirty(true); }}
              credSet={innerCredSet}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
              Outer Agent Backend
            </label>
            <p className="text-[10px] text-sandstorm-muted mb-2">
              Backend used for orchestration (outer agent)
            </p>
            <GlobalBackendConfig
              surface="outer"
              backend={outerBackend}
              onBackendChange={(v) => { setOuterBackend(v); setDirty(true); }}
              provider={outerProvider}
              onProviderChange={(v) => { setOuterProvider(v); setDirty(true); }}
              model={outerModel}
              onModelChange={(v) => { setOuterModel(v); setDirty(true); }}
              credBundle={outerCredBundle}
              onCredBundleChange={(b) => { setOuterCredBundle(b); setDirty(true); }}
              credSet={outerCredSet}
            />
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
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
