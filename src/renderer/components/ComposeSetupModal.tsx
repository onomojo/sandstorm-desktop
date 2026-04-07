import React, { useState, useEffect } from 'react';

interface ComposeSetupModalProps {
  projectDir: string;
  onComplete: () => void;
  onDismiss: () => void;
}

export function ComposeSetupModal({
  projectDir,
  onComplete,
  onDismiss,
}: ComposeSetupModalProps) {
  const [composeYaml, setComposeYaml] = useState('');
  const [composeFile, setComposeFile] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noProjectCompose, setNoProjectCompose] = useState(false);

  useEffect(() => {
    window.sandstorm.projects.generateCompose(projectDir).then((result) => {
      if (!result.success) {
        setError(result.error || 'Failed to generate compose configuration');
        setNoProjectCompose(result.noProjectCompose ?? false);
      } else {
        setComposeYaml(result.yaml || '');
        setComposeFile(result.composeFile || '');
      }
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
      const result = await window.sandstorm.projects.saveComposeSetup(
        projectDir,
        composeYaml,
        composeFile,
      );
      if (!result.success) {
        setError(result.error || 'Failed to save compose configuration');
        return;
      }
      onComplete();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="compose-setup-modal">
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border">
          <h2 className="text-base font-semibold text-sandstorm-text">
            {noProjectCompose ? 'Missing Docker Compose File' : 'Sandstorm Compose Setup'}
          </h2>
          <p className="text-xs text-sandstorm-muted mt-1">
            {noProjectCompose
              ? 'This project requires a docker-compose.yml file to work with Sandstorm.'
              : 'Your project is initialized but missing a Sandstorm Docker Compose configuration. A separate compose file is needed so Sandstorm can remap ports and run isolated stacks without conflicting with your project\u2019s own containers.'}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-sandstorm-muted" data-testid="compose-loading">Analyzing project compose file...</div>
            </div>
          ) : noProjectCompose ? (
            <div className="space-y-3">
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" data-testid="compose-no-project-error">
                {error}
              </div>
              <p className="text-xs text-sandstorm-muted">
                Sandstorm needs your project&apos;s docker-compose.yml to understand which services to include
                and which ports to remap. Please add a docker-compose.yml to your project root and try again.
              </p>
            </div>
          ) : (
            <>
              {composeFile && (
                <div className="text-xs text-sandstorm-muted">
                  Generated from: <span className="font-mono text-sandstorm-accent">{composeFile}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                  Sandstorm Docker Compose (.sandstorm/docker-compose.yml)
                </label>
                <p className="text-[11px] text-sandstorm-muted mb-2">
                  This override file remaps ports, pins shared image names, and adds the Claude workspace
                  service. Review and edit as needed before saving.
                </p>
                <textarea
                  value={composeYaml}
                  onChange={(e) => setComposeYaml(e.target.value)}
                  rows={18}
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent resize-y"
                  spellCheck={false}
                  data-testid="compose-yaml-editor"
                />
              </div>

              {error && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" data-testid="compose-save-error">
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
            data-testid="compose-later-btn"
          >
            {noProjectCompose ? 'Close' : 'Later'}
          </button>
          {!noProjectCompose && !loading && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 transition-all active:scale-[0.98] shadow-glow"
              data-testid="compose-save-btn"
            >
              {saving ? 'Saving...' : 'Save & Configure'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
