import React, { useState, useEffect } from 'react';
import { PROVIDER_METADATA, ProviderMeta } from '../../../shared/opencode-providers';
import { ConfigPane, ConfigPaneContext } from './types';

interface ProvidersPaneBodyProps {
  ctx: ConfigPaneContext;
}

function ProvidersPaneBody({ ctx }: ProvidersPaneBodyProps) {
  const { projectDir, providerSecrets, routing } = ctx;

  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removeWarnings, setRemoveWarnings] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadStatuses() {
      const results: Record<string, boolean> = {};
      await Promise.all(
        PROVIDER_METADATA.map(async (provider) => {
          const s = await providerSecrets.status(projectDir, provider.id);
          results[provider.id] = s.set;
        })
      );
      if (!cancelled) setStatuses(results);
    }
    loadStatuses();
    return () => { cancelled = true; };
  }, [projectDir]);

  const handleToggleExpand = (providerId: string) => {
    setRemoveWarnings((w) => { const next = { ...w }; delete next[providerId]; return next; });
    if (expanded === providerId) {
      setExpanded(null);
      setFormValues({});
      setErrors((e) => { const next = { ...e }; delete next[providerId]; return next; });
    } else {
      setExpanded(providerId);
      setFormValues({});
      setErrors((e) => { const next = { ...e }; delete next[providerId]; return next; });
    }
  };

  const handleSave = async (provider: ProviderMeta) => {
    const missingLabels = provider.fields
      .filter((f) => f.required && !formValues[f.key]?.trim())
      .map((f) => f.label);

    if (missingLabels.length > 0) {
      setErrors((e) => ({ ...e, [provider.id]: `Required: ${missingLabels.join(', ')}` }));
      return;
    }

    const bundle: Record<string, string> = {};
    for (const field of provider.fields) {
      if (formValues[field.key]?.trim()) {
        bundle[field.key] = formValues[field.key].trim();
      }
    }

    setSaving(provider.id);
    try {
      await providerSecrets.setBundle(projectDir, provider.id, bundle);
      setStatuses((s) => ({ ...s, [provider.id]: true }));
      setExpanded(null);
      setFormValues({});
      setErrors((e) => { const next = { ...e }; delete next[provider.id]; return next; });
    } finally {
      setSaving(null);
    }
  };

  const handleRemove = async (provider: ProviderMeta) => {
    setRemoving(provider.id);
    try {
      const effective = await routing.getEffective(projectDir);
      const affectedTouchpoints = Object.keys(effective).filter(
        (tp) => effective[tp].provider === provider.id
      );
      if (affectedTouchpoints.length > 0) {
        setRemoveWarnings((w) => ({ ...w, [provider.id]: affectedTouchpoints }));
      }
      await providerSecrets.remove(projectDir, provider.id);
      setStatuses((s) => ({ ...s, [provider.id]: false }));
      if (expanded === provider.id) {
        setExpanded(null);
        setFormValues({});
      }
    } finally {
      setRemoving(null);
    }
  };

  const statusesLoaded = Object.keys(statuses).length === PROVIDER_METADATA.length;
  const noneConfigured = statusesLoaded && PROVIDER_METADATA.every((p) => !statuses[p.id]);

  return (
    <div data-testid="providers-pane" className="space-y-3">
      {PROVIDER_METADATA.length === 0 ? (
        <p className="text-xs text-sandstorm-muted">No providers available.</p>
      ) : (
        <>
          {noneConfigured && (
            <p data-testid="providers-empty-prompt" className="text-xs text-sandstorm-muted mb-3">
              No providers are configured yet. Add credentials for at least one provider to enable model routing.
            </p>
          )}
          {PROVIDER_METADATA.map((provider) => {
            const isSet = statuses[provider.id] ?? false;
            const isExpanded = expanded === provider.id;
            const isSaving = saving === provider.id;
            const isRemoving = removing === provider.id;
            const error = errors[provider.id];

            return (
              <div
                key={provider.id}
                data-testid={`provider-card-${provider.id}`}
                className="border border-sandstorm-border rounded-lg overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-3 bg-sandstorm-surface">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-sandstorm-fg">{provider.label}</span>
                    <span
                      data-testid={`provider-status-${provider.id}`}
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        isSet
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-sandstorm-surface-2 text-sandstorm-muted'
                      }`}
                    >
                      {isSet ? 'Configured' : 'Not configured'}
                    </span>
                  </div>
                  <button
                    data-testid={`provider-expand-${provider.id}`}
                    className="text-xs text-sandstorm-muted hover:text-sandstorm-fg transition-colors px-2 py-1 rounded"
                    onClick={() => handleToggleExpand(provider.id)}
                  >
                    {isExpanded ? 'Cancel' : isSet ? 'Edit' : 'Configure'}
                  </button>
                </div>

                {removeWarnings[provider.id] && removeWarnings[provider.id].length > 0 && (
                  <p
                    data-testid={`provider-remove-warning-${provider.id}`}
                    className="px-4 py-2 text-xs text-yellow-400 border-t border-sandstorm-border"
                  >
                    Removed: touchpoints {removeWarnings[provider.id].join(', ')} will need a key.
                  </p>
                )}

                {isExpanded && (
                  <div
                    data-testid={`provider-form-${provider.id}`}
                    className="px-4 py-3 border-t border-sandstorm-border bg-sandstorm-surface-2 space-y-3"
                  >
                    {isSet && (
                      <p className="text-xs text-sandstorm-muted">
                        Credentials are already set. Enter new values to update them.
                      </p>
                    )}
                    {provider.fields.map((field) => (
                      <div key={field.key}>
                        <label className="block text-xs font-medium text-sandstorm-muted mb-1">
                          {field.label}
                          {field.required && <span className="text-red-400 ml-1">*</span>}
                        </label>
                        <input
                          data-testid={`provider-field-${provider.id}-${field.key}`}
                          type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                          className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
                          value={formValues[field.key] ?? ''}
                          onChange={(e) =>
                            setFormValues((v) => ({ ...v, [field.key]: e.target.value }))
                          }
                          placeholder={field.placeholder ?? ''}
                          autoComplete="off"
                        />
                      </div>
                    ))}

                    {error && (
                      <p data-testid={`provider-error-${provider.id}`} className="text-xs text-red-400">
                        {error}
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      <button
                        data-testid={`provider-save-${provider.id}`}
                        className="px-3 py-1.5 text-xs font-medium rounded bg-sandstorm-accent text-white hover:bg-sandstorm-accent/90 transition-colors disabled:opacity-50"
                        onClick={() => handleSave(provider)}
                        disabled={isSaving}
                      >
                        {isSaving ? 'Saving…' : 'Save'}
                      </button>
                      {isSet && (
                        <button
                          data-testid={`provider-remove-${provider.id}`}
                          className="px-3 py-1.5 text-xs font-medium rounded border border-sandstorm-border text-sandstorm-muted hover:text-red-400 hover:border-red-400/50 transition-colors disabled:opacity-50"
                          onClick={() => handleRemove(provider)}
                          disabled={isRemoving}
                        >
                          {isRemoving ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

export function buildProvidersPane(ctx: ConfigPaneContext): ConfigPane {
  return {
    id: 'providers',
    label: 'Providers',
    icon: <span className="text-sm">🔌</span>,
    render: () => <ProvidersPaneBody ctx={ctx} />,
  };
}
