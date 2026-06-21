import React, { useState, useEffect, useMemo } from 'react';
import {
  PROVIDER_METADATA,
  buildProviderMetaFromCatalog,
  deriveFieldsFromCatalogProvider,
  type ProviderMeta,
  type CatalogProvider,
  type CatalogProviderList,
} from '../../../shared/opencode-providers';
import { ConfigPane, ConfigPaneContext } from './types';

interface ProvidersPaneBodyProps {
  ctx: ConfigPaneContext;
}

function ProvidersPaneBody({ ctx }: ProvidersPaneBodyProps) {
  const { projectDir, providerSecrets, routing } = ctx;

  const [catalog, setCatalog] = useState<CatalogProviderList | null>(null);
  const [configuredIds, setConfiguredIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removeWarnings, setRemoveWarnings] = useState<Record<string, string[]>>({});
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  // Load catalog and configured providers
  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Load configured providers
      const configured = await window.sandstorm.providers.configured(projectDir);
      if (!cancelled) setConfiguredIds(configured ?? []);

      // Load catalog
      setLoadingCatalog(true);
      try {
        const catalogData = await window.sandstorm.providers.catalog();
        if (!cancelled && catalogData) {
          setCatalog(catalogData);
        }
      } finally {
        if (!cancelled) setLoadingCatalog(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [projectDir]);

  // Build the ProviderMeta for each configured provider
  const configuredMetas = useMemo<ProviderMeta[]>(() => {
    return configuredIds.map((id) => {
      const known = PROVIDER_METADATA.find((p) => p.id === id);
      if (known) return known;
      const catalogEntry = catalog?.all.find((p) => p.id === id);
      if (catalogEntry) return buildProviderMetaFromCatalog(catalogEntry);
      // Fallback for providers not in catalog
      return { id, label: id, fields: [] };
    });
  }, [configuredIds, catalog]);

  // Catalog providers not yet configured, filtered by search
  const availableCatalogProviders = useMemo<CatalogProvider[]>(() => {
    if (!catalog) return [];
    return catalog.all.filter(
      (p) =>
        !configuredIds.includes(p.id) &&
        (catalogSearch === '' ||
          p.id.toLowerCase().includes(catalogSearch.toLowerCase()) ||
          p.name.toLowerCase().includes(catalogSearch.toLowerCase()))
    );
  }, [catalog, configuredIds, catalogSearch]);

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
      setConfiguredIds((ids) => ids.includes(provider.id) ? ids : [...ids, provider.id]);
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
      setConfiguredIds((ids) => ids.filter((id) => id !== provider.id));
      if (expanded === provider.id) {
        setExpanded(null);
        setFormValues({});
      }
    } finally {
      setRemoving(null);
    }
  };

  const handleAddFromCatalog = (catalogProvider: CatalogProvider) => {
    setShowCatalogPicker(false);
    setCatalogSearch('');
    const meta = buildProviderMetaFromCatalog(catalogProvider);
    // Pre-populate formValues with empty strings for all fields
    const initial: Record<string, string> = {};
    for (const f of meta.fields) initial[f.key] = '';
    setFormValues(initial);
    setExpanded(catalogProvider.id);
  };

  const nConfigured = configuredIds.length;
  const nNeedsKey = catalog
    ? catalog.all.filter((p) => !configuredIds.includes(p.id)).length
    : 0;

  return (
    <div data-testid="providers-pane" className="space-y-3">
      {/* Rail subtitle */}
      <p className="text-xs text-sandstorm-muted">
        {nConfigured} configured{catalog ? ` · ${nNeedsKey} available` : ''}
      </p>

      {/* Configured provider rows */}
      {configuredMetas.length === 0 && !showCatalogPicker && (
        <p data-testid="providers-empty-prompt" className="text-xs text-sandstorm-muted mb-3">
          No providers are configured yet. Add credentials for at least one provider to enable model routing.
        </p>
      )}

      {/* Pane-level routing warnings (shown after provider is removed) */}
      {Object.entries(removeWarnings).map(([providerId, touchpoints]) =>
        touchpoints.length > 0 ? (
          <p
            key={providerId}
            data-testid={`provider-remove-warning-${providerId}`}
            className="px-4 py-2 text-xs text-yellow-400 border border-sandstorm-border rounded"
          >
            Removed: touchpoints {touchpoints.join(', ')} will need a key.
          </p>
        ) : null
      )}

      {configuredMetas.map((provider) => {
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
                {/* Status dot */}
                <span
                  data-testid={`provider-status-dot-${provider.id}`}
                  className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0"
                  title="Configured"
                />
                <span className="text-sm font-medium text-sandstorm-fg">{provider.label}</span>
                <span
                  data-testid={`provider-status-${provider.id}`}
                  className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400"
                >
                  Configured
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  data-testid={`provider-expand-${provider.id}`}
                  className="text-xs text-sandstorm-muted hover:text-sandstorm-fg transition-colors px-2 py-1 rounded"
                  onClick={() => handleToggleExpand(provider.id)}
                >
                  {isExpanded ? 'Cancel' : 'Edit'}
                </button>
                <button
                  data-testid={`provider-remove-${provider.id}`}
                  className="text-xs text-sandstorm-muted hover:text-red-400 transition-colors px-2 py-1 rounded disabled:opacity-50"
                  onClick={() => handleRemove(provider)}
                  disabled={isRemoving}
                >
                  {isRemoving ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>

            {isExpanded && (
              <div
                data-testid={`provider-form-${provider.id}`}
                className="px-4 py-3 border-t border-sandstorm-border bg-sandstorm-surface-2 space-y-3"
              >
                <p className="text-xs text-sandstorm-muted">
                  Credentials are already set. Enter new values to update them.
                </p>
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
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* New provider form (when adding from catalog) */}
      {expanded && !configuredIds.includes(expanded) && (() => {
        const catalogEntry = catalog?.all.find((p) => p.id === expanded);
        if (!catalogEntry) return null;
        const meta = buildProviderMetaFromCatalog(catalogEntry);
        const error = errors[expanded];
        const isSaving = saving === expanded;

        return (
          <div
            key={expanded}
            data-testid={`provider-card-${expanded}`}
            className="border border-sandstorm-border rounded-lg overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-3 bg-sandstorm-surface">
              <div className="flex items-center gap-3">
                <span
                  data-testid={`provider-status-dot-${expanded}`}
                  className="w-2 h-2 rounded-full bg-sandstorm-muted flex-shrink-0"
                  title="Not configured"
                />
                <span className="text-sm font-medium text-sandstorm-fg">{meta.label}</span>
              </div>
              <button
                className="text-xs text-sandstorm-muted hover:text-sandstorm-fg transition-colors px-2 py-1 rounded"
                onClick={() => { setExpanded(null); setFormValues({}); }}
              >
                Cancel
              </button>
            </div>

            <div
              data-testid={`provider-form-${expanded}`}
              className="px-4 py-3 border-t border-sandstorm-border bg-sandstorm-surface-2 space-y-3"
            >
              {meta.fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-sandstorm-muted mb-1">
                    {field.label}
                    {field.required && <span className="text-red-400 ml-1">*</span>}
                  </label>
                  <input
                    data-testid={`provider-field-${expanded}-${field.key}`}
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
                <p data-testid={`provider-error-${expanded}`} className="text-xs text-red-400">
                  {error}
                </p>
              )}

              <button
                data-testid={`provider-save-${expanded}`}
                className="px-3 py-1.5 text-xs font-medium rounded bg-sandstorm-accent text-white hover:bg-sandstorm-accent/90 transition-colors disabled:opacity-50"
                onClick={() => handleSave(meta)}
                disabled={isSaving}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Catalog picker */}
      {showCatalogPicker ? (
        <div
          data-testid="catalog-picker"
          className="border border-sandstorm-border rounded-lg overflow-hidden"
        >
          <div className="px-4 py-3 bg-sandstorm-surface border-b border-sandstorm-border flex items-center justify-between">
            <span className="text-xs font-medium text-sandstorm-muted">Add a provider</span>
            <button
              data-testid="catalog-picker-close"
              className="text-xs text-sandstorm-muted hover:text-sandstorm-fg"
              onClick={() => { setShowCatalogPicker(false); setCatalogSearch(''); }}
            >
              Cancel
            </button>
          </div>
          <div className="px-4 py-2 border-b border-sandstorm-border">
            <input
              data-testid="catalog-search"
              type="text"
              className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
              placeholder="Search providers…"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              autoFocus
            />
          </div>
          {loadingCatalog ? (
            <p className="px-4 py-3 text-xs text-sandstorm-muted">Loading catalog…</p>
          ) : availableCatalogProviders.length === 0 ? (
            <p className="px-4 py-3 text-xs text-sandstorm-muted">No providers found.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {availableCatalogProviders.map((p) => (
                <button
                  key={p.id}
                  data-testid={`catalog-provider-${p.id}`}
                  className="w-full text-left px-4 py-2.5 hover:bg-sandstorm-surface-2 transition-colors flex items-center justify-between group"
                  onClick={() => handleAddFromCatalog(p)}
                >
                  <div>
                    <span className="text-sm text-sandstorm-fg">{p.name}</span>
                    <span className="ml-2 text-xs text-sandstorm-muted">{p.id}</span>
                  </div>
                  {p.env.length > 0 && (
                    <span className="text-xs text-sandstorm-muted opacity-0 group-hover:opacity-100">
                      {p.env.length} env {p.env.length === 1 ? 'var' : 'vars'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          data-testid="add-provider-button"
          className="w-full border border-dashed border-sandstorm-border rounded-lg px-4 py-3 text-xs text-sandstorm-muted hover:text-sandstorm-fg hover:border-sandstorm-fg/40 transition-colors text-left"
          onClick={() => setShowCatalogPicker(true)}
        >
          + Add provider
        </button>
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
