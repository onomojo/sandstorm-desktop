import React, { useState, useEffect } from 'react';

type TicketProvider = 'github' | 'jira' | 'skeleton';

interface MigrationModalProps {
  projectDir: string;
  missingVerifyScript: boolean;
  missingServiceLabels: boolean;
  missingSpecQualityGate?: boolean;
  missingReviewPrompt?: boolean;
  legacyPortMappings?: boolean;
  missingUpdateScript?: boolean;
  missingCreatePrScript?: boolean;
  detectedTicketProvider?: TicketProvider;
  onComplete: () => void;
  onDismiss: () => void;
}

export function MigrationModal({
  projectDir,
  missingVerifyScript,
  missingServiceLabels,
  missingSpecQualityGate,
  missingReviewPrompt,
  legacyPortMappings,
  missingUpdateScript,
  missingCreatePrScript,
  detectedTicketProvider,
  onComplete,
  onDismiss,
}: MigrationModalProps) {
  const [verifyScript, setVerifyScript] = useState('');
  const [serviceDescriptions, setServiceDescriptions] = useState<Record<string, string>>({});
  const [specQualityGate, setSpecQualityGate] = useState('');
  const [reviewPrompt, setReviewPrompt] = useState('');
  // The two provider scripts (update-ticket.sh, create-pr.sh) are both per-
  // provider (github/jira/skeleton). Keep one picker — they ship from the
  // same template set.
  const [scriptProvider, setScriptProvider] = useState<TicketProvider>(detectedTicketProvider ?? 'github');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadVerify = window.sandstorm.projects.autoDetectVerify(projectDir);
    const loadGate = missingSpecQualityGate
      ? window.sandstorm.specGate.getDefault()
      : Promise.resolve('');
    const loadReviewPrompt = missingReviewPrompt
      ? window.sandstorm.reviewPrompt.getDefault()
      : Promise.resolve('');

    Promise.all([loadVerify, loadGate, loadReviewPrompt]).then(([verifyResult, gateContent, reviewPromptContent]) => {
      setVerifyScript(verifyResult.verifyScript);
      setServiceDescriptions(verifyResult.serviceDescriptions);
      setSpecQualityGate(gateContent);
      setReviewPrompt(reviewPromptContent);
      setLoading(false);
    }).catch((err) => {
      setError(String(err));
      setLoading(false);
    });
  }, [projectDir, missingSpecQualityGate, missingReviewPrompt]);

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
      // Save spec quality gate if it was missing
      if (missingSpecQualityGate && specQualityGate) {
        await window.sandstorm.specGate.save(projectDir, specQualityGate);
      }
      // Save review prompt if it was missing
      if (missingReviewPrompt && reviewPrompt) {
        await window.sandstorm.reviewPrompt.save(projectDir, reviewPrompt);
      }
      // Clean up legacy port mappings
      if (legacyPortMappings) {
        const portResult = await window.sandstorm.ports.cleanupLegacy(projectDir);
        if (!portResult.success) {
          setError(portResult.error || 'Failed to clean up legacy port mappings');
          return;
        }
      }
      // Install the provider scripts (update-ticket.sh #318, create-pr.sh
      // #320). Both pick from the same github / jira / skeleton template
      // set — one provider choice, one save path.
      if (missingUpdateScript) {
        const installRes = await window.sandstorm.projects.installUpdateScript(projectDir, scriptProvider);
        if (!installRes.success) {
          setError(installRes.error || 'Failed to install update-ticket.sh');
          return;
        }
      }
      if (missingCreatePrScript) {
        const installRes = await window.sandstorm.projects.installCreatePrScript(projectDir, scriptProvider);
        if (!installRes.success) {
          setError(installRes.error || 'Failed to install create-pr.sh');
          return;
        }
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="migration-modal">
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border">
          <h2 className="text-base font-semibold text-sandstorm-text">Project Migration Needed</h2>
          <p className="text-xs text-sandstorm-muted mt-1">
            This project needs
            {[
              missingVerifyScript && 'a verify script',
              missingServiceLabels && 'service descriptions',
              missingSpecQualityGate && 'a spec quality gate',
              missingReviewPrompt && 'a review prompt',
              legacyPortMappings && 'legacy port mapping cleanup',
              missingUpdateScript && 'an update-ticket script',
              missingCreatePrScript && 'a create-pr script',
            ].filter(Boolean).join(', ')
            .replace(/, ([^,]*)$/, ' and $1')}{' '}
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

              {/* Spec quality gate editor */}
              {missingSpecQualityGate && (
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Spec Quality Gate (.sandstorm/spec-quality-gate.md)
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    Defines what a "ready" ticket looks like before agent dispatch. Customize the criteria to match your project.
                  </p>
                  <textarea
                    value={specQualityGate}
                    onChange={(e) => setSpecQualityGate(e.target.value)}
                    rows={12}
                    className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent resize-y"
                    spellCheck={false}
                    data-testid="spec-quality-gate-editor"
                  />
                </div>
              )}

              {/* Legacy port mappings notice */}
              {legacyPortMappings && (
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Legacy Port Mappings
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    This project has static port mappings in its sandstorm compose file. Ports are now exposed on demand via proxy containers. Saving will remove the static port mappings.
                  </p>
                </div>
              )}

              {/* Provider scripts picker — single control for both
                  update-ticket.sh (#318) and create-pr.sh (#320) since
                  both pick from the same github / jira / skeleton template
                  set. */}
              {(missingUpdateScript || missingCreatePrScript) && (
                <div data-testid="provider-scripts-section">
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Provider Scripts{' '}
                    <span className="text-sandstorm-muted font-normal">
                      ({[
                        missingUpdateScript && '.sandstorm/scripts/update-ticket.sh',
                        missingCreatePrScript && '.sandstorm/scripts/create-pr.sh',
                      ].filter(Boolean).join(', ')})
                    </span>
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    {missingUpdateScript && missingCreatePrScript
                      ? 'Lets the refine step commit bodies back to your ticket system and lets Make PR open pull requests via your git host. Without these, both flows fail.'
                      : missingUpdateScript
                        ? 'Lets the refine step commit the refined body back to your ticket system. Without this, refinements are lost between sessions.'
                        : 'Lets Make PR open pull requests via your git host. Without this, the PR button fails.'}
                    {detectedTicketProvider && (
                      <> Auto-detected: <span className="font-mono text-sandstorm-text-secondary">{detectedTicketProvider}</span>.</>
                    )}
                  </p>
                  <div className="flex gap-2">
                    {(['github', 'jira', 'skeleton'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setScriptProvider(p)}
                        className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
                          scriptProvider === p
                            ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                            : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
                        }`}
                        data-testid={`script-provider-${p}`}
                      >
                        {p === 'github' && 'GitHub'}
                        {p === 'jira' && 'Jira'}
                        {p === 'skeleton' && 'Custom (edit later)'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Review prompt editor */}
              {missingReviewPrompt && (
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Review Prompt (.sandstorm/review-prompt.md)
                  </label>
                  <p className="text-[11px] text-sandstorm-muted mb-2">
                    Instructions for the review agent that evaluates code changes. Customize to match your project's standards.
                  </p>
                  <textarea
                    value={reviewPrompt}
                    onChange={(e) => setReviewPrompt(e.target.value)}
                    rows={12}
                    className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent resize-y"
                    spellCheck={false}
                    data-testid="review-prompt-editor"
                  />
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
