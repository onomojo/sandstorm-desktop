import React, { useState, useEffect } from 'react';

interface MigrationModalProps {
  projectDir: string;
  missingVerifyScript: boolean;
  missingServiceLabels: boolean;
  legacyPortMappings?: boolean;
  ticketProviderUnconfigured?: boolean;
  onComplete: () => void;
  onDismiss: () => void;
}

export function MigrationModal({
  projectDir,
  missingVerifyScript,
  missingServiceLabels,
  legacyPortMappings,
  ticketProviderUnconfigured,
  onComplete,
  onDismiss,
}: MigrationModalProps) {
  const [verifyScript, setVerifyScript] = useState('');
  const [serviceDescriptions, setServiceDescriptions] = useState<Record<string, string>>({});
  const [ticketProvider, setTicketProvider] = useState<'github' | 'jira'>('github');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.sandstorm.projects.autoDetectVerify(projectDir).then((verifyResult) => {
      setVerifyScript(verifyResult.verifyScript);
      setServiceDescriptions(verifyResult.serviceDescriptions);
      setLoading(false);
    }).catch((err) => {
      setError(String(err));
      setLoading(false);
    });
  }, [projectDir]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await window.sandstorm.projects.saveMigration(
        projectDir,
        verifyScript,
        serviceDescriptions,
      );
      if (!result.success) {
        setError(result.error || 'Failed to save migration');
        return;
      }
      if (legacyPortMappings) {
        const portResult = await window.sandstorm.ports.cleanupLegacy(projectDir);
        if (!portResult.success) {
          setError(portResult.error || 'Failed to clean up legacy port mappings');
          return;
        }
      }
      if (ticketProviderUnconfigured) {
        await window.sandstorm.projectTicketConfig.set(projectDir, { provider: ticketProvider });
      }
      onComplete();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleServiceDescChange = (service: string, value: string) => {
    setServiceDescriptions((prev) => ({ ...prev, [service]: value }));
  };

  const needsItems = [
    missingVerifyScript && 'a verify script',
    missingServiceLabels && 'service descriptions',
    legacyPortMappings && 'legacy port mapping cleanup',
    ticketProviderUnconfigured && 'a ticket provider',
  ].filter(Boolean) as string[];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="migration-modal">
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border">
          <h2 className="text-base font-semibold text-sandstorm-text">Project Migration Needed</h2>
          <p className="text-xs text-sandstorm-muted mt-1">
            This project needs{' '}
            {needsItems.join(', ').replace(/, ([^,]*)$/, ' and $1')}{' '}
            to work with the stack system.
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-sandstorm-muted">Detecting project configuration...</div>
            </div>
          ) : (
            <>
              {/* Verify script editor */}
              {missingVerifyScript && (
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Verify Script (.sandstorm/verify.sh)
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    Commands that run after code review passes. Each line is a command — if any fails, verification fails.
                  </p>
                  <textarea
                    value={verifyScript}
                    onChange={(e) => setVerifyScript(e.target.value)}
                    rows={10}
                    className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent resize-y"
                    spellCheck={false}
                    data-testid="verify-script-editor"
                  />
                </div>
              )}

              {/* Service descriptions editor */}
              {missingServiceLabels && Object.keys(serviceDescriptions).length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Service Descriptions
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    Tells inner Claude what each service does and which commands are available.
                  </p>
                  <div className="space-y-2">
                    {Object.entries(serviceDescriptions).map(([service, desc]) => (
                      <div key={service} className="flex items-center gap-2">
                        <span className="text-xs font-mono text-sandstorm-accent w-20 shrink-0">{service}</span>
                        <input
                          type="text"
                          value={desc}
                          onChange={(e) => handleServiceDescChange(service, e.target.value)}
                          className="flex-1 bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                          placeholder="e.g., React frontend - Node.js 22, npm test, npm run build"
                          data-testid={`service-desc-${service}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Legacy port mappings notice */}
              {legacyPortMappings && (
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Legacy Port Mappings
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    This project has static port mappings. Saving will remove them and switch to on-demand port exposure.
                  </p>
                </div>
              )}

              {/* Ticket provider picker */}
              {ticketProviderUnconfigured && (
                <div data-testid="ticket-provider-section">
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Ticket Provider
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    Which issue tracker does this project use? This replaces the old per-project scripts — ticket operations are now built into Sandstorm Desktop.
                  </p>
                  <div className="flex gap-2">
                    {(['github', 'jira'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setTicketProvider(p)}
                        className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
                          ticketProvider === p
                            ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                            : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
                        }`}
                        data-testid={`ticket-provider-${p}`}
                      >
                        {p === 'github' ? 'GitHub Issues' : 'Jira'}
                      </button>
                    ))}
                  </div>
                  {ticketProvider === 'jira' && (
                    <p className="text-[10px] text-sandstorm-muted mt-2">
                      Configure Jira credentials in Project Settings → Ticketing after setup.
                    </p>
                  )}
                </div>
              )}

              {error && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-sandstorm-border flex items-center justify-end gap-3">
          <button
            onClick={onDismiss}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors"
            data-testid="migration-later-btn"
          >
            Later
          </button>
          <button
            onClick={handleSave}
            disabled={loading || saving}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 transition-all active:scale-[0.98] shadow-glow"
            data-testid="migration-save-btn"
          >
            {saving ? 'Saving...' : 'Set Up Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
