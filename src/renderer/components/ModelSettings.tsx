import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore, ModelSettings as ModelSettingsType, ProjectTicketConfig } from '../store';

type Tab = 'global' | 'project' | 'ticketing';

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

const GLOBAL_BACKEND_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
] as const;

const PROJECT_BACKEND_OPTIONS = [
  { id: 'global', label: 'Use Global Default' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
] as const;

const OPENCODE_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'amazon-bedrock', label: 'Amazon Bedrock' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'openrouter', label: 'OpenRouter' },
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

function BackendSelector({
  scope,
  backend,
  onBackendChange,
  provider,
  onProviderChange,
  model,
  onModelChange,
  credInput,
  onCredInputChange,
  credSet,
  testId,
}: {
  scope: 'global' | 'project';
  backend: string;
  onBackendChange: (v: string) => void;
  provider: string;
  onProviderChange: (v: string) => void;
  model: string;
  onModelChange: (v: string) => void;
  credInput: string;
  onCredInputChange: (v: string) => void;
  credSet: boolean;
  testId: string;
}) {
  const options = scope === 'global' ? GLOBAL_BACKEND_OPTIONS : PROJECT_BACKEND_OPTIONS;
  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => { onBackendChange(opt.id); }}
            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              backend === opt.id
                ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
            }`}
            data-testid={`${testId}-${opt.id}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {backend === 'opencode' && (
        <div className="space-y-2 pl-1 pt-1" data-testid={`${testId}-opencode-fields`}>
          <div>
            <label className="block text-[10px] font-medium text-sandstorm-text-secondary mb-1">Provider</label>
            <select
              value={provider}
              onChange={(e) => { onProviderChange(e.target.value); }}
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
              data-testid={`${testId}-provider`}
            >
              {OPENCODE_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-sandstorm-text-secondary mb-1">Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => { onModelChange(e.target.value); }}
              placeholder="e.g. claude-sonnet-4-5"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
              data-testid={`${testId}-model`}
            />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-sandstorm-text-secondary mb-1">
              API Credential
              <span className="ml-2 font-normal text-sandstorm-muted" data-testid={`${testId}-cred-status`}>
                {credSet ? '(Set)' : '(Not set)'}
              </span>
            </label>
            <input
              type="password"
              value={credInput}
              onChange={(e) => { onCredInputChange(e.target.value); }}
              placeholder={credSet ? 'Enter new value to update' : 'Enter API key'}
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
              data-testid={`${testId}-cred-input`}
              autoComplete="new-password"
            />
          </div>
        </div>
      )}
    </div>
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
    getProjectTicketConfig,
    setProjectTicketConfig,
    getDarkFactoryEnabled,
    setDarkFactoryEnabled,
    globalBackendSettings,
    refreshGlobalBackendSettings,
    setGlobalBackendSettings,
    getProjectBackendSettings,
    setProjectBackendSettings,
    getEffectiveBackend,
    setBackendSecret,
    getBackendSecretStatus,
  } = useAppStore();

  const project = activeProject();
  const [activeTab, setActiveTab] = useState<Tab>(project ? 'project' : 'global');

  // Global settings state
  const [globalInner, setGlobalInner] = useState(globalModelSettings.inner_model);
  const [globalOuter, setGlobalOuter] = useState(globalModelSettings.outer_model);
  const [globalDirty, setGlobalDirty] = useState(false);

  // Global backend state
  const [globalInnerBackend, setGlobalInnerBackend] = useState<string>(globalBackendSettings.inner_backend ?? 'claude');
  const [globalInnerProvider, setGlobalInnerProvider] = useState<string>(globalBackendSettings.inner_provider ?? 'anthropic');
  const [globalInnerModel, setGlobalInnerModel] = useState<string>(globalBackendSettings.inner_model ?? '');
  const [globalInnerCredInput, setGlobalInnerCredInput] = useState('');
  const [globalInnerCredSet, setGlobalInnerCredSet] = useState(false);
  const [globalOuterBackend, setGlobalOuterBackend] = useState<string>(globalBackendSettings.outer_backend ?? 'claude');
  const [globalOuterProvider, setGlobalOuterProvider] = useState<string>(globalBackendSettings.outer_provider ?? 'anthropic');
  const [globalOuterModel, setGlobalOuterModel] = useState<string>(globalBackendSettings.outer_model ?? '');
  const [globalOuterCredInput, setGlobalOuterCredInput] = useState('');
  const [globalOuterCredSet, setGlobalOuterCredSet] = useState(false);
  const [globalBackendLoaded, setGlobalBackendLoaded] = useState(false);

  // Project model settings state
  const [projectInner, setProjectInner] = useState('global');
  const [projectOuter, setProjectOuter] = useState('global');
  const [projectDirty, setProjectDirty] = useState(false);
  const [projectLoaded, setProjectLoaded] = useState(false);

  // Project backend state
  const [projectInnerBackend, setProjectInnerBackend] = useState<string>('global');
  const [projectInnerProvider, setProjectInnerProvider] = useState<string>('anthropic');
  const [projectInnerModel, setProjectInnerModel] = useState<string>('');
  const [projectInnerCredInput, setProjectInnerCredInput] = useState('');
  const [projectInnerCredSet, setProjectInnerCredSet] = useState(false);
  const [projectOuterBackend, setProjectOuterBackend] = useState<string>('global');
  const [projectOuterProvider, setProjectOuterProvider] = useState<string>('anthropic');
  const [projectOuterModel, setProjectOuterModel] = useState<string>('');
  const [projectOuterCredInput, setProjectOuterCredInput] = useState('');
  const [projectOuterCredSet, setProjectOuterCredSet] = useState(false);
  const [projectBackendLoaded, setProjectBackendLoaded] = useState(false);

  // Effective backend for summary
  const [effectiveInnerBackend, setEffectiveInnerBackend] = useState<{ backend: 'claude' | 'opencode'; provider?: string; model?: string } | null>(null);
  const [effectiveOuterBackend, setEffectiveOuterBackend] = useState<{ backend: 'claude' | 'opencode'; provider?: string; model?: string } | null>(null);

  // Dark factory state
  const [darkFactoryEnabled, setDarkFactoryEnabledLocal] = useState(false);
  const [darkFactoryLoaded, setDarkFactoryLoaded] = useState(false);

  // Ticket config state
  const [ticketProvider, setTicketProvider] = useState<'github' | 'jira'>('github');
  const [jiraUrl, setJiraUrl] = useState('');
  const [jiraUsername, setJiraUsername] = useState('');
  const [jiraApiToken, setJiraApiToken] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');
  const [jiraIssueType, setJiraIssueType] = useState('');
  const [ticketPrefix, setTicketPrefix] = useState('');
  const [ticketDirty, setTicketDirty] = useState(false);
  const [ticketLoaded, setTicketLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  type TestConnState = 'idle' | 'testing' | 'success-with-count' | 'auth-fail' | 'jql-empty';
  interface TestConnResult {
    auth: { ok: true; displayName: string } | { ok: false; status?: number; message: string };
    jql: { ok: true; count: number; hasMore: boolean } | { ok: false; status?: number; message: string } | null;
  }
  const [testConnState, setTestConnState] = useState<TestConnState>('idle');
  const [testConnResult, setTestConnResult] = useState<TestConnResult | null>(null);

  useEffect(() => {
    refreshGlobalModelSettings();
  }, [refreshGlobalModelSettings]);

  useEffect(() => {
    setGlobalInner(globalModelSettings.inner_model);
    setGlobalOuter(globalModelSettings.outer_model);
  }, [globalModelSettings]);

  const loadGlobalBackendSettings = useCallback(async () => {
    await refreshGlobalBackendSettings();
    const settings = useAppStore.getState().globalBackendSettings;
    setGlobalInnerBackend(settings.inner_backend ?? 'claude');
    setGlobalInnerProvider(settings.inner_provider ?? 'anthropic');
    setGlobalInnerModel(settings.inner_model ?? '');
    setGlobalOuterBackend(settings.outer_backend ?? 'claude');
    setGlobalOuterProvider(settings.outer_provider ?? 'anthropic');
    setGlobalOuterModel(settings.outer_model ?? '');

    const [innerStatus, outerStatus] = await Promise.all([
      getBackendSecretStatus('global', 'inner'),
      getBackendSecretStatus('global', 'outer'),
    ]);
    setGlobalInnerCredSet(innerStatus.set);
    setGlobalOuterCredSet(outerStatus.set);
    setGlobalBackendLoaded(true);
  }, [refreshGlobalBackendSettings, getBackendSecretStatus]);

  useEffect(() => {
    loadGlobalBackendSettings();
  }, [loadGlobalBackendSettings]);

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
    const dfEnabled = await getDarkFactoryEnabled(project.directory);
    setDarkFactoryEnabledLocal(dfEnabled);
    setDarkFactoryLoaded(true);
    setProjectLoaded(true);
    setProjectDirty(false);
  }, [project, getProjectModelSettings, getDarkFactoryEnabled]);

  const loadProjectBackendSettings = useCallback(async () => {
    if (!project) return;
    const settings = await getProjectBackendSettings(project.directory);
    if (settings) {
      setProjectInnerBackend(settings.inner_backend ?? 'global');
      setProjectInnerProvider(settings.inner_provider ?? 'anthropic');
      setProjectInnerModel(settings.inner_model ?? '');
      setProjectOuterBackend(settings.outer_backend ?? 'global');
      setProjectOuterProvider(settings.outer_provider ?? 'anthropic');
      setProjectOuterModel(settings.outer_model ?? '');
    } else {
      setProjectInnerBackend('global');
      setProjectInnerProvider('anthropic');
      setProjectInnerModel('');
      setProjectOuterBackend('global');
      setProjectOuterProvider('anthropic');
      setProjectOuterModel('');
    }

    const [innerStatus, outerStatus] = await Promise.all([
      getBackendSecretStatus(project.directory, 'inner'),
      getBackendSecretStatus(project.directory, 'outer'),
    ]);
    setProjectInnerCredSet(innerStatus.set);
    setProjectOuterCredSet(outerStatus.set);
    setProjectBackendLoaded(true);
  }, [project, getProjectBackendSettings, getBackendSecretStatus]);

  const loadEffectiveBackend = useCallback(async () => {
    if (!project) return;
    const [inner, outer] = await Promise.all([
      getEffectiveBackend(project.directory, 'inner'),
      getEffectiveBackend(project.directory, 'outer'),
    ]);
    setEffectiveInnerBackend(inner);
    setEffectiveOuterBackend(outer);
  }, [project, getEffectiveBackend]);

  const loadTicketConfig = useCallback(async () => {
    if (!project) return;
    const config = await getProjectTicketConfig(project.directory);
    if (config) {
      setTicketProvider(config.provider);
      setJiraUrl(config.jira_url ?? '');
      setJiraUsername(config.jira_username ?? '');
      setJiraApiToken(config.jira_api_token ?? '');
      setJiraProjectKey(config.jira_project_key ?? '');
      setJiraIssueType(config.jira_issue_type ?? '');
      setTicketPrefix(config.ticket_prefix ?? '');
    } else {
      setTicketProvider('github');
      setJiraUrl('');
      setJiraUsername('');
      setJiraApiToken('');
      setJiraProjectKey('');
      setJiraIssueType('');
      setTicketPrefix('');
    }
    setTicketLoaded(true);
    setTicketDirty(false);
  }, [project, getProjectTicketConfig]);

  useEffect(() => {
    loadProjectSettings();
    loadProjectBackendSettings();
    loadEffectiveBackend();
    loadTicketConfig();
  }, [loadProjectSettings, loadProjectBackendSettings, loadEffectiveBackend, loadTicketConfig]);

  const handleSaveGlobal = async () => {
    setSaving(true);
    setError(null);
    try {
      await setGlobalModelSettings({ inner_model: globalInner, outer_model: globalOuter });
      await setGlobalBackendSettings({
        inner_backend: globalInnerBackend,
        inner_provider: globalInnerBackend === 'opencode' ? (globalInnerProvider || null) : null,
        inner_model: globalInnerBackend === 'opencode' ? (globalInnerModel || null) : null,
        outer_backend: globalOuterBackend,
        outer_provider: globalOuterBackend === 'opencode' ? (globalOuterProvider || null) : null,
        outer_model: globalOuterBackend === 'opencode' ? (globalOuterModel || null) : null,
      });
      if (globalInnerBackend === 'opencode' && globalInnerCredInput) {
        await setBackendSecret('global', 'inner', globalInnerCredInput);
        setGlobalInnerCredInput('');
        setGlobalInnerCredSet(true);
      }
      if (globalOuterBackend === 'opencode' && globalOuterCredInput) {
        await setBackendSecret('global', 'outer', globalOuterCredInput);
        setGlobalOuterCredInput('');
        setGlobalOuterCredSet(true);
      }
      setGlobalDirty(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProject = async () => {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      await setProjectModelSettings(project.directory, {
        inner_model: projectInner,
        outer_model: projectOuter,
      });
      await setDarkFactoryEnabled(project.directory, darkFactoryEnabled);
      await setProjectBackendSettings(project.directory, {
        inner_backend: projectInnerBackend,
        inner_provider: projectInnerBackend === 'opencode' ? (projectInnerProvider || null) : null,
        inner_model: projectInnerBackend === 'opencode' ? (projectInnerModel || null) : null,
        outer_backend: projectOuterBackend,
        outer_provider: projectOuterBackend === 'opencode' ? (projectOuterProvider || null) : null,
        outer_model: projectOuterBackend === 'opencode' ? (projectOuterModel || null) : null,
      });
      if (projectInnerBackend === 'opencode' && projectInnerCredInput) {
        await setBackendSecret(project.directory, 'inner', projectInnerCredInput);
        setProjectInnerCredInput('');
        setProjectInnerCredSet(true);
      }
      if (projectOuterBackend === 'opencode' && projectOuterCredInput) {
        await setBackendSecret(project.directory, 'outer', projectOuterCredInput);
        setProjectOuterCredInput('');
        setProjectOuterCredSet(true);
      }
      await loadEffectiveBackend();
      setProjectDirty(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTicket = async () => {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      const config: ProjectTicketConfig = {
        provider: ticketProvider,
        jira_url: ticketProvider === 'jira' ? jiraUrl.trim() || null : null,
        jira_username: ticketProvider === 'jira' ? jiraUsername.trim() || null : null,
        jira_api_token: ticketProvider === 'jira' ? jiraApiToken.trim() || null : null,
        jira_project_key: ticketProvider === 'jira' ? jiraProjectKey.trim() || null : null,
        jira_issue_type: ticketProvider === 'jira' ? jiraIssueType.trim() || null : null,
        ticket_prefix: ticketPrefix.trim() || null,
      };
      await setProjectTicketConfig(project.directory, config);
      setTicketDirty(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTestConnState('testing');
    setTestConnResult(null);
    try {
      const result = await window.sandstorm.tickets.testJiraConnection({
        jiraUrl: jiraUrl.trim(),
        jiraUsername: jiraUsername.trim(),
        jiraApiToken: jiraApiToken.trim(),
      });
      setTestConnResult(result);
      if (!result.auth.ok) {
        setTestConnState('auth-fail');
      } else if (result.jql && result.jql.ok && result.jql.count === 0) {
        setTestConnState('jql-empty');
      } else {
        setTestConnState('success-with-count');
      }
    } catch {
      setTestConnState('auth-fail');
      setTestConnResult({ auth: { ok: false, message: 'Connection failed' }, jql: null });
    }
  };

  const handleSave = () => {
    if (activeTab === 'global') return handleSaveGlobal();
    if (activeTab === 'project') return handleSaveProject();
    return handleSaveTicket();
  };

  const isDirty =
    activeTab === 'global' ? globalDirty :
    activeTab === 'project' ? projectDirty :
    ticketDirty;

  const tabs: { id: Tab; label: string; disabled?: boolean }[] = [
    { id: 'global', label: 'Global Defaults' },
    { id: 'project', label: project ? `Project: ${project.name}` : 'Project', disabled: !project },
    { id: 'ticketing', label: 'Ticketing', disabled: !project },
  ];

  const effectiveInner = projectInner === 'global' ? globalInner : projectInner;
  const effectiveOuter = projectOuter === 'global' ? globalOuter : projectOuter;

  function formatEffectiveBackendSummary(eb: { backend: 'claude' | 'opencode'; provider?: string; model?: string } | null, claudeModel: string) {
    if (!eb) return claudeModel;
    if (eb.backend === 'claude') return claudeModel;
    const parts = ['OpenCode'];
    if (eb.provider) parts.push(eb.provider);
    if (eb.model) parts.push(eb.model);
    return parts.join(' / ');
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) setShowModelSettings(false); }}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[540px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Project Configuration</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">Configure models and ticket provider for this project</p>
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
              onClick={() => { if (!tab.disabled) { setActiveTab(tab.id); setError(null); } }}
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
          {activeTab === 'global' && globalBackendLoaded && (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Inner Agent Backend
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Backend used for stack execution (inner agent)
                </p>
                <BackendSelector
                  scope="global"
                  backend={globalInnerBackend}
                  onBackendChange={(v) => { setGlobalInnerBackend(v); setGlobalDirty(true); }}
                  provider={globalInnerProvider}
                  onProviderChange={(v) => { setGlobalInnerProvider(v); setGlobalDirty(true); }}
                  model={globalInnerModel}
                  onModelChange={(v) => { setGlobalInnerModel(v); setGlobalDirty(true); }}
                  credInput={globalInnerCredInput}
                  onCredInputChange={(v) => { setGlobalInnerCredInput(v); setGlobalDirty(true); }}
                  credSet={globalInnerCredSet}
                  testId="global-inner-backend"
                />
              </div>

              {globalInnerBackend === 'claude' && (
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
              )}

              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Outer Agent Backend
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Backend used for orchestration (outer agent)
                </p>
                <BackendSelector
                  scope="global"
                  backend={globalOuterBackend}
                  onBackendChange={(v) => { setGlobalOuterBackend(v); setGlobalDirty(true); }}
                  provider={globalOuterProvider}
                  onProviderChange={(v) => { setGlobalOuterProvider(v); setGlobalDirty(true); }}
                  model={globalOuterModel}
                  onModelChange={(v) => { setGlobalOuterModel(v); setGlobalDirty(true); }}
                  credInput={globalOuterCredInput}
                  onCredInputChange={(v) => { setGlobalOuterCredInput(v); setGlobalDirty(true); }}
                  credSet={globalOuterCredSet}
                  testId="global-outer-backend"
                />
              </div>

              {globalOuterBackend === 'claude' && (
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
              )}
            </>
          )}

          {activeTab === 'project' && project && projectLoaded && darkFactoryLoaded && projectBackendLoaded && (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Inner Agent Backend
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Override the global backend for the inner agent
                </p>
                <BackendSelector
                  scope="project"
                  backend={projectInnerBackend}
                  onBackendChange={(v) => { setProjectInnerBackend(v); setProjectDirty(true); }}
                  provider={projectInnerProvider}
                  onProviderChange={(v) => { setProjectInnerProvider(v); setProjectDirty(true); }}
                  model={projectInnerModel}
                  onModelChange={(v) => { setProjectInnerModel(v); setProjectDirty(true); }}
                  credInput={projectInnerCredInput}
                  onCredInputChange={(v) => { setProjectInnerCredInput(v); setProjectDirty(true); }}
                  credSet={projectInnerCredSet}
                  testId="project-inner-backend"
                />
              </div>

              {projectInnerBackend !== 'opencode' && (
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
              )}

              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Outer Agent Backend
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Override the global backend for the outer agent
                </p>
                <BackendSelector
                  scope="project"
                  backend={projectOuterBackend}
                  onBackendChange={(v) => { setProjectOuterBackend(v); setProjectDirty(true); }}
                  provider={projectOuterProvider}
                  onProviderChange={(v) => { setProjectOuterProvider(v); setProjectDirty(true); }}
                  model={projectOuterModel}
                  onModelChange={(v) => { setProjectOuterModel(v); setProjectDirty(true); }}
                  credInput={projectOuterCredInput}
                  onCredInputChange={(v) => { setProjectOuterCredInput(v); setProjectDirty(true); }}
                  credSet={projectOuterCredSet}
                  testId="project-outer-backend"
                />
              </div>

              {projectOuterBackend !== 'opencode' && (
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
              )}

              {/* Dark factory toggle */}
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Dark Factory Mode
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-3">
                  Automates the pipeline from spec_ready onward: spins a stack, creates a PR, and merges — hands-off.
                </p>
                <button
                  role="switch"
                  aria-checked={darkFactoryEnabled}
                  onClick={() => { setDarkFactoryEnabledLocal(!darkFactoryEnabled); setProjectDirty(true); }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-sandstorm-accent focus:ring-offset-1 ${
                    darkFactoryEnabled ? 'bg-sandstorm-accent' : 'bg-sandstorm-border'
                  }`}
                  data-testid="dark-factory-toggle"
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                      darkFactoryEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
                <span className="ml-2 text-[11px] text-sandstorm-muted" data-testid="dark-factory-status">
                  {darkFactoryEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              {/* Effective model summary */}
              <div className="bg-sandstorm-bg border border-sandstorm-border rounded-lg px-4 py-3">
                <p className="text-[11px] font-medium text-sandstorm-text-secondary mb-1.5">Effective Models</p>
                <div className="flex gap-4 text-[11px]">
                  <span className="text-sandstorm-muted">
                    Inner: <span className="text-sandstorm-text font-medium" data-testid="effective-inner">{formatEffectiveBackendSummary(effectiveInnerBackend, effectiveInner)}</span>
                  </span>
                  <span className="text-sandstorm-muted">
                    Outer: <span className="text-sandstorm-text font-medium" data-testid="effective-outer">{formatEffectiveBackendSummary(effectiveOuterBackend, effectiveOuter)}</span>
                  </span>
                </div>
              </div>
            </>
          )}

          {activeTab === 'ticketing' && project && ticketLoaded && (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-2">
                  Ticket Provider
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-2">
                  Which system does this project use for issue tracking?
                </p>
                <div className="flex gap-2">
                  {(['github', 'jira'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => { setTicketProvider(p); setTicketDirty(true); }}
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
              </div>

              {ticketProvider === 'github' && (
                <div className="bg-sandstorm-bg border border-sandstorm-border rounded-lg px-4 py-3">
                  <p className="text-[11px] text-sandstorm-muted">
                    GitHub Issues uses ambient <span className="font-mono text-sandstorm-text-secondary">gh</span> authentication. Make sure you are logged in with <span className="font-mono text-sandstorm-text-secondary">gh auth login</span>.
                  </p>
                </div>
              )}

              {ticketProvider === 'jira' && (
                <div className="space-y-3" data-testid="jira-fields">
                  <div>
                    <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">
                      Jira URL <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="url"
                      value={jiraUrl}
                      onChange={(e) => { setJiraUrl(e.target.value); setTicketDirty(true); }}
                      placeholder="https://yourcompany.atlassian.net"
                      className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                      data-testid="jira-url"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">
                      Username (email) <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="email"
                      value={jiraUsername}
                      onChange={(e) => { setJiraUsername(e.target.value); setTicketDirty(true); }}
                      placeholder="you@company.com"
                      className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                      data-testid="jira-username"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">
                      API Token <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="password"
                      value={jiraApiToken}
                      onChange={(e) => { setJiraApiToken(e.target.value); setTicketDirty(true); }}
                      placeholder="Your Jira API token"
                      className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                      data-testid="jira-api-token"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">
                      Project Key <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={jiraProjectKey}
                      onChange={(e) => { setJiraProjectKey(e.target.value.toUpperCase()); setTicketDirty(true); }}
                      placeholder="PROJ"
                      className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs font-mono text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                      data-testid="jira-project-key"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">
                      Issue Type <span className="text-sandstorm-muted font-normal">(optional, default: Task)</span>
                    </label>
                    <input
                      type="text"
                      value={jiraIssueType}
                      onChange={(e) => { setJiraIssueType(e.target.value); setTicketDirty(true); }}
                      placeholder="Task"
                      className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                      data-testid="jira-issue-type"
                    />
                  </div>

                  <div className="pt-1">
                    <button
                      onClick={handleTestConnection}
                      disabled={testConnState === 'testing' || !jiraUrl.trim() || !jiraUsername.trim() || !jiraApiToken.trim()}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-sandstorm-border bg-sandstorm-bg text-sandstorm-text hover:border-sandstorm-border-light disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      data-testid="jira-test-connection"
                    >
                      {testConnState === 'testing' ? 'Testing…' : 'Test Connection'}
                    </button>

                    {testConnResult && testConnState !== 'testing' && (
                      <div className="mt-2 space-y-1" data-testid="jira-test-connection-result">
                        {testConnResult.auth.ok ? (
                          <p className="text-[11px] text-green-400" data-testid="jira-test-auth-ok">
                            ✓ Connected as {testConnResult.auth.displayName}
                          </p>
                        ) : (
                          <p className="text-[11px] text-red-400" data-testid="jira-test-auth-fail">
                            ✗ Auth failed{testConnResult.auth.status ? ` (${testConnResult.auth.status})` : ''}: {(testConnResult.auth as { ok: false; message: string }).message}
                          </p>
                        )}
                        {testConnResult.jql && (
                          testConnResult.jql.ok ? (
                            <p className="text-[11px] text-sandstorm-muted" data-testid="jira-test-jql-ok">
                              {testConnResult.jql.count === 0
                                ? '⚠ JQL returned 0 tickets — filter may be excluding everything'
                                : `✓ JQL returned ${testConnResult.jql.hasMore ? '100+' : testConnResult.jql.count} ticket${testConnResult.jql.hasMore || testConnResult.jql.count !== 1 ? 's' : ''}`}
                            </p>
                          ) : (
                            <p className="text-[11px] text-red-400" data-testid="jira-test-jql-fail">
                              ✗ JQL failed: {(testConnResult.jql as { ok: false; message: string }).message}
                            </p>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">
                  Ticket Prefix <span className="text-sandstorm-muted font-normal">(optional)</span>
                </label>
                <p className="text-[10px] text-sandstorm-muted mb-1">
                  Used to identify ticket IDs in branch names and prompts (e.g. PROJ-)
                </p>
                <input
                  type="text"
                  value={ticketPrefix}
                  onChange={(e) => { setTicketPrefix(e.target.value); setTicketDirty(true); }}
                  placeholder="e.g. PROJ-"
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-1.5 text-xs font-mono text-sandstorm-text focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
                  data-testid="ticket-prefix"
                />
              </div>
            </>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
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
            onClick={handleSave}
            disabled={saving || !isDirty}
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
