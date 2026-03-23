import React, { useEffect, useState, useCallback } from 'react';

interface ProjectContextProps {
  projectDir: string;
  onClose: () => void;
}

type Tab = 'instructions' | 'skills' | 'settings';

export function ProjectContext({ projectDir, onClose }: ProjectContextProps) {
  const [activeTab, setActiveTab] = useState<Tab>('instructions');
  const [instructions, setInstructions] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [settings, setSettings] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState('');
  const [newSkillName, setNewSkillName] = useState('');
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadContext = useCallback(async () => {
    const ctx = await window.sandstorm.context.get(projectDir);
    setInstructions(ctx.instructions);
    setSkills(ctx.skills);
    setSettings(ctx.settings);
    setDirty(false);
  }, [projectDir]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  const loadSkill = useCallback(
    async (name: string) => {
      const content = await window.sandstorm.context.getSkill(projectDir, name);
      setSelectedSkill(name);
      setSkillContent(content);
      setDirty(false);
    },
    [projectDir]
  );

  const saveInstructions = async () => {
    setSaving(true);
    await window.sandstorm.context.saveInstructions(projectDir, instructions);
    setSaving(false);
    setDirty(false);
  };

  const saveSettings = async () => {
    setSaving(true);
    await window.sandstorm.context.saveSettings(projectDir, settings);
    setSaving(false);
    setDirty(false);
  };

  const saveSkill = async () => {
    if (!selectedSkill) return;
    setSaving(true);
    await window.sandstorm.context.saveSkill(projectDir, selectedSkill, skillContent);
    setSaving(false);
    setDirty(false);
  };

  const createSkill = async () => {
    const name = newSkillName.trim().replace(/\.md$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!name) return;
    await window.sandstorm.context.saveSkill(projectDir, name, `# ${name}\n\nDescribe this skill...\n`);
    setNewSkillName('');
    setShowNewSkill(false);
    await loadContext();
    await loadSkill(name);
  };

  const deleteSkill = async (name: string) => {
    await window.sandstorm.context.deleteSkill(projectDir, name);
    if (selectedSkill === name) {
      setSelectedSkill(null);
      setSkillContent('');
    }
    await loadContext();
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'instructions', label: 'Instructions' },
    { id: 'skills', label: 'Skills' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl shadow-2xl w-[700px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-sandstorm-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-sandstorm-text">Custom Context</h2>
            <p className="text-xs text-sandstorm-muted mt-0.5">
              Personal overrides for this project (not committed to git)
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-sandstorm-border shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setDirty(false);
              }}
              className={`px-4 py-2.5 text-xs font-medium transition-colors relative ${
                activeTab === tab.id
                  ? 'text-sandstorm-accent'
                  : 'text-sandstorm-muted hover:text-sandstorm-text'
              }`}
            >
              {tab.label}
              {tab.id === 'skills' && skills.length > 0 && (
                <span className="ml-1.5 text-[10px] bg-sandstorm-accent/15 text-sandstorm-accent px-1.5 py-0.5 rounded-full">
                  {skills.length}
                </span>
              )}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-sandstorm-accent" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {activeTab === 'instructions' && (
            <div className="p-5 flex flex-col h-full">
              <p className="text-xs text-sandstorm-muted mb-3">
                Custom instructions injected as a personal CLAUDE.md overlay for inner Claude agents.
                These are additive to the project&apos;s .claude/ settings.
              </p>
              <textarea
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value);
                  setDirty(true);
                }}
                placeholder={'# My Custom Instructions\n\nAdd rules, preferences, or context here...\n\nExample:\n- Always run tests before committing\n- Use TDD approach\n- Focus on performance'}
                className="flex-1 min-h-[280px] w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg p-3 text-sm text-sandstorm-text font-mono resize-none focus:outline-none focus:border-sandstorm-accent/50 placeholder:text-sandstorm-muted/50"
              />
              <div className="flex justify-end mt-3">
                <button
                  onClick={saveInstructions}
                  disabled={saving || !dirty}
                  className="px-4 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-all"
                >
                  {saving ? 'Saving...' : 'Save Instructions'}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="flex h-full min-h-[350px]">
              {/* Skill list sidebar */}
              <div className="w-48 border-r border-sandstorm-border flex flex-col shrink-0">
                <div className="p-3 flex items-center justify-between border-b border-sandstorm-border">
                  <span className="text-xs font-medium text-sandstorm-muted">Skills</span>
                  <button
                    onClick={() => setShowNewSkill(true)}
                    className="text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors"
                    title="Add skill"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
                {showNewSkill && (
                  <div className="p-2 border-b border-sandstorm-border">
                    <input
                      value={newSkillName}
                      onChange={(e) => setNewSkillName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') createSkill();
                        if (e.key === 'Escape') {
                          setShowNewSkill(false);
                          setNewSkillName('');
                        }
                      }}
                      placeholder="skill-name"
                      autoFocus
                      className="w-full bg-sandstorm-bg border border-sandstorm-border rounded px-2 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:border-sandstorm-accent/50"
                    />
                  </div>
                )}
                <div className="flex-1 overflow-y-auto">
                  {skills.length === 0 && !showNewSkill && (
                    <p className="text-xs text-sandstorm-muted p-3">No custom skills</p>
                  )}
                  {skills.map((name) => (
                    <div
                      key={name}
                      className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer group ${
                        selectedSkill === name
                          ? 'bg-sandstorm-accent/10 text-sandstorm-accent'
                          : 'text-sandstorm-text-secondary hover:bg-sandstorm-surface-hover'
                      }`}
                      onClick={() => loadSkill(name)}
                    >
                      <span className="truncate">{name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSkill(name);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-sandstorm-muted hover:text-red-400 transition-all"
                        title="Delete skill"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Skill editor */}
              <div className="flex-1 flex flex-col p-4">
                {selectedSkill ? (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-sandstorm-text font-mono">
                        {selectedSkill}.md
                      </span>
                    </div>
                    <textarea
                      value={skillContent}
                      onChange={(e) => {
                        setSkillContent(e.target.value);
                        setDirty(true);
                      }}
                      className="flex-1 min-h-[250px] w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg p-3 text-sm text-sandstorm-text font-mono resize-none focus:outline-none focus:border-sandstorm-accent/50"
                    />
                    <div className="flex justify-end mt-3">
                      <button
                        onClick={saveSkill}
                        disabled={saving || !dirty}
                        className="px-4 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-all"
                      >
                        {saving ? 'Saving...' : 'Save Skill'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-sandstorm-muted text-xs">
                    Select a skill or create a new one
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="p-5 flex flex-col h-full">
              <p className="text-xs text-sandstorm-muted mb-3">
                Custom settings.json overrides for the inner Claude agent. Must be valid JSON.
              </p>
              <textarea
                value={settings}
                onChange={(e) => {
                  setSettings(e.target.value);
                  setDirty(true);
                }}
                placeholder='{"permissions": {"allow": ["Bash(npm test)", "Read"]}, "env": {"DEBUG": "true"}}'
                className="flex-1 min-h-[280px] w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg p-3 text-sm text-sandstorm-text font-mono resize-none focus:outline-none focus:border-sandstorm-accent/50 placeholder:text-sandstorm-muted/50"
              />
              <div className="flex justify-end mt-3">
                <button
                  onClick={saveSettings}
                  disabled={saving || !dirty}
                  className="px-4 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-all"
                >
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
