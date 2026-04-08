import { create } from 'zustand';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentSessionState {
  messages: ChatMessage[];
  streamingContent: string;
  isLoading: boolean;
  isQueued: boolean;
}

export interface Project {
  id: number;
  name: string;
  directory: string;
  added_at: string;
}

export interface Stack {
  id: string;
  project: string;
  project_dir: string;
  ticket: string | null;
  branch: string | null;
  description: string | null;
  status: string;
  error: string | null;
  pr_url: string | null;
  pr_number: number | null;
  runtime: 'docker' | 'podman';
  total_input_tokens: number;
  total_output_tokens: number;
  total_execution_input_tokens: number;
  total_execution_output_tokens: number;
  total_review_input_tokens: number;
  total_review_output_tokens: number;
  rate_limit_reset_at: string | null;
  created_at: string;
  updated_at: string;
  current_model: string | null;
  services: ServiceInfo[];
}

export interface ServiceInfo {
  name: string;
  status: string;
  exitCode?: number;
  hostPort?: number;
  containerPort?: number;
  containerId: string;
}

export interface Task {
  id: number;
  stack_id: string;
  prompt: string;
  model: string | null;
  resolved_model: string | null;
  status: string;
  exit_code: number | null;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  execution_input_tokens: number;
  execution_output_tokens: number;
  review_input_tokens: number;
  review_output_tokens: number;
  review_iterations: number;
  verify_retries: number;
  review_verdicts: string | null;
  verify_outputs: string | null;
  execution_summary: string | null;
  execution_started_at: string | null;
  execution_finished_at: string | null;
  review_started_at: string | null;
  review_finished_at: string | null;
  verify_started_at: string | null;
  verify_finished_at: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface TaskTokenStep {
  id: number;
  task_id: number;
  iteration: number;
  phase: string;
  input_tokens: number;
  output_tokens: number;
}

export type WorkflowPhase = 'execution' | 'review' | 'verify' | 'idle';
export type PhaseStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface WorkflowPhaseState {
  phase: WorkflowPhase;
  status: PhaseStatus;
}

export interface WorkflowStepTokens {
  phase: string;
  iteration: number;
  input_tokens: number;
  output_tokens: number;
  live: boolean;
}

export interface WorkflowProgress {
  stackId: string;
  currentPhase: WorkflowPhase;
  outerIteration: number;
  innerIteration: number;
  phases: WorkflowPhaseState[];
  steps: WorkflowStepTokens[];
  taskPrompt: string | null;
  startedAt: string | null;
  model: string | null;
}

export interface OuterClaudeTokenUsage {
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
}

export interface TokenUsageStats {
  stackId: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ProjectTokenUsage {
  project: string;
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface GlobalTokenUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  per_stack: TokenUsageStats[];
  per_project: ProjectTokenUsage[];
}

export interface RateLimitState {
  active: boolean;
  reset_at: string | null;
  affected_stacks: string[];
  reason: string | null;
}

export interface UsageBlock {
  percent: number;
  resetsAt: string;
}

export interface UsageSnapshot {
  session: UsageBlock | null;
  weekAll: UsageBlock | null;
  weekSonnet: UsageBlock | null;
  extraUsage: { enabled: boolean };
  capturedAt: string;
  status: 'ok' | 'rate_limited' | 'at_limit' | 'auth_expired' | 'parse_error';
}

export type ThresholdLevel = 'normal' | 'warning' | 'critical' | 'limit' | 'over_limit';

export type PollMode = 'normal' | 'at_limit' | 'rate_limited' | 'error';

export interface SessionMonitorState {
  usage: UsageSnapshot | null;
  level: ThresholdLevel;
  stale: boolean;
  halted: boolean;
  lastPollAt: string | null;
  consecutiveFailures: number;
  pollMode: PollMode;
  nextPollAt: string | null;
  idle: boolean;
  tmuxAvailable: boolean | null;
}

export interface SessionMonitorSettings {
  warningThreshold: number;
  criticalThreshold: number;
  autoHaltThreshold: number;
  autoHaltEnabled: boolean;
  autoResumeAfterReset: boolean;
  pollIntervalMs: number;
  idleTimeoutMs: number;
  pollingDisabled: boolean;
}

export interface PortMapping {
  stack_id: string;
  service: string;
  host_port: number;
  container_port: number;
}

export interface ContainerStatsEntry {
  name: string;
  containerId: string;
  memoryUsage: number;
  memoryLimit: number;
  cpuPercent: number;
}

export interface TaskMetrics {
  stackId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  avgTaskDurationMs: number;
}

export interface StackMetrics {
  totalMemory: number;
  containers: ContainerStatsEntry[];
  taskMetrics: TaskMetrics;
}

export interface StackHistoryRecord {
  id: number;
  stack_id: string;
  project: string;
  project_dir: string;
  ticket: string | null;
  branch: string | null;
  description: string | null;
  final_status: 'completed' | 'failed' | 'torn_down';
  error: string | null;
  runtime: 'docker' | 'podman';
  task_prompt: string | null;
  task_history: string | null;
  created_at: string;
  finished_at: string;
  duration_seconds: number;
}

export interface ModelSettings {
  inner_model: string;
  outer_model: string;
}

export interface StaleWorkspace {
  stackId: string;
  project: string;
  projectDir: string;
  workspacePath: string;
  sizeBytes: number;
  hasUnpushedChanges: boolean;
  reason: 'orphaned' | 'completed';
  lastModified: string;
}

export interface CleanupResult {
  workspacePath: string;
  success: boolean;
  error?: string;
}

interface AppState {
  // Projects
  projects: Project[];
  activeProjectId: number | null; // null means "All"
  showOpenProjectDialog: boolean;

  // Docker connection
  dockerConnected: boolean;

  // Stacks
  stacks: Stack[];
  stackHistory: StackHistoryRecord[];
  selectedStackId: string | null;
  showNewStackDialog: boolean;
  stackMetrics: Record<string, StackMetrics>;
  loading: boolean;
  error: string | null;

  // Token usage
  globalTokenUsage: GlobalTokenUsage | null;
  rateLimitState: RateLimitState | null;
  accountUsage: UsageSnapshot | null;

  // Agent session state (per-tab) — streaming content, loading, queued
  agentSessions: Record<string, AgentSessionState>;
  updateAgentSession: (tabId: string, update: Partial<AgentSessionState>) => void;
  clearAgentSession: (tabId: string) => void;

  // Live workflow progress (per-stack)
  workflowProgress: Record<string, WorkflowProgress>;
  updateWorkflowProgress: (stackId: string, progress: WorkflowProgress) => void;
  clearWorkflowProgress: (stackId: string) => void;

  // Stale workspaces
  staleWorkspaces: StaleWorkspace[];
  staleWorkspacesLoading: boolean;
  refreshStaleWorkspaces: () => Promise<void>;
  cleanupStaleWorkspaces: (workspacePaths: string[]) => Promise<CleanupResult[]>;

  // Model settings
  globalModelSettings: ModelSettings;
  showModelSettings: boolean;
  setShowModelSettings: (show: boolean) => void;
  refreshGlobalModelSettings: () => Promise<void>;
  setGlobalModelSettings: (settings: Partial<ModelSettings>) => Promise<void>;
  getEffectiveModels: (projectDir: string) => Promise<ModelSettings>;
  getProjectModelSettings: (projectDir: string) => Promise<ModelSettings | null>;
  setProjectModelSettings: (projectDir: string, settings: Partial<ModelSettings>) => Promise<void>;
  removeProjectModelSettings: (projectDir: string) => Promise<void>;

  // Session monitor
  sessionMonitorState: SessionMonitorState | null;
  sessionMonitorSettings: SessionMonitorSettings | null;
  /** The current threshold event level for displaying warnings */
  sessionWarningLevel: ThresholdLevel | null;
  /** Whether to show the session warning modal */
  showSessionWarningModal: boolean;
  setShowSessionWarningModal: (show: boolean) => void;
  refreshSessionState: () => Promise<void>;
  refreshSessionSettings: () => Promise<void>;
  updateSessionSettings: (settings: Partial<SessionMonitorSettings>) => Promise<void>;
  sessionAcknowledgeCritical: () => Promise<void>;
  sessionHaltAll: () => Promise<string[]>;
  sessionResumeAll: () => Promise<string[]>;

  // Account usage budget (persisted in localStorage)
  tokenBudget: number; // 0 means no budget set
  setTokenBudget: (budget: number) => void;

  // Docker connection
  setDockerConnected: (connected: boolean) => void;

  // Project actions
  setProjects: (projects: Project[]) => void;
  setActiveProjectId: (id: number | null) => void;
  setShowOpenProjectDialog: (show: boolean) => void;
  refreshProjects: () => Promise<void>;
  addProject: (directory: string) => Promise<Project>;
  removeProject: (id: number) => Promise<void>;

  // Stack actions
  setStacks: (stacks: Stack[]) => void;
  selectStack: (id: string | null) => void;
  setShowNewStackDialog: (show: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  refreshStacks: () => Promise<void>;
  refreshStackHistory: () => Promise<void>;
  refreshMetrics: () => Promise<void>;
  refreshTokenUsage: () => Promise<void>;
  refreshRateLimitState: () => Promise<void>;
  refreshAccountUsage: () => Promise<void>;

  // Derived
  filteredStacks: () => Stack[];
  filteredStackHistory: () => StackHistoryRecord[];
  activeProject: () => Project | undefined;
}

declare global {
  interface Window {
    sandstorm: {
      projects: {
        list: () => Promise<Project[]>;
        add: (directory: string) => Promise<Project>;
        remove: (id: number) => Promise<void>;
        browse: () => Promise<string | null>;
        checkInit: (directory: string) => Promise<{ state: 'uninitialized' | 'partial' | 'full' }>;
        initialize: (directory: string) => Promise<{ success: boolean; error?: string }>;
        checkMigration: (directory: string) => Promise<{
          needsMigration: boolean;
          missingVerifyScript?: boolean;
          missingServiceLabels?: boolean;
          missingSpecQualityGate?: boolean;
        }>;
        autoDetectVerify: (directory: string) => Promise<{
          verifyScript: string;
          serviceDescriptions: Record<string, string>;
        }>;
        saveMigration: (
          directory: string,
          verifyScript: string,
          serviceDescriptions: Record<string, string>,
        ) => Promise<{ success: boolean; error?: string }>;
        generateCompose: (directory: string) => Promise<{
          success: boolean;
          yaml?: string;
          config?: string;
          composeFile?: string;
          services?: Array<{ name: string; description: string; ports: Array<{ host: string; container: string }> }>;
          error?: string;
          noProjectCompose?: boolean;
        }>;
        saveComposeSetup: (
          directory: string,
          composeYaml: string,
          composeFile: string,
        ) => Promise<{ success: boolean; error?: string }>;
      };
      stacks: {
        list: () => Promise<Stack[]>;
        get: (id: string) => Promise<Stack>;
        create: (opts: unknown) => Promise<Stack>;
        teardown: (id: string) => Promise<void>;
        stop: (id: string) => Promise<void>;
        start: (id: string) => Promise<void>;
        history: () => Promise<StackHistoryRecord[]>;
        setPr: (id: string, prUrl: string, prNumber: number) => Promise<void>;
        detectStale: () => Promise<StaleWorkspace[]>;
        cleanupStale: (workspacePaths: string[]) => Promise<CleanupResult[]>;
      };
      tasks: {
        dispatch: (stackId: string, prompt: string, model?: string) => Promise<Task>;
        list: (stackId: string) => Promise<Task[]>;
        tokenSteps: (taskId: number) => Promise<TaskTokenStep[]>;
        workflowProgress: (stackId: string) => Promise<WorkflowProgress | null>;
      };
      diff: {
        get: (stackId: string) => Promise<string>;
      };
      push: {
        execute: (stackId: string, message?: string) => Promise<void>;
      };
      ports: {
        get: (stackId: string) => Promise<PortMapping[]>;
      };
      logs: {
        stream: (containerId: string, runtime: string) => Promise<string>;
      };
      stats: {
        stackMemory: (stackId: string) => Promise<number>;
        stackDetailed: (stackId: string) => Promise<{ stackId: string; totalMemory: number; containers: ContainerStatsEntry[] }>;
        taskMetrics: (stackId: string) => Promise<TaskMetrics>;
        tokenUsage: (stackId: string) => Promise<TokenUsageStats>;
        globalTokenUsage: () => Promise<GlobalTokenUsage>;
        rateLimit: () => Promise<RateLimitState>;
        accountUsage: () => Promise<UsageSnapshot | null>;
        outerClaudeTokens: () => Promise<OuterClaudeTokenUsage[]>;
      };
      runtime: {
        available: () => Promise<{ docker: boolean; podman: boolean }>;
      };
      agent: {
        send: (tabId: string, message: string, projectDir?: string) => Promise<void>;
        cancel: (tabId: string) => Promise<void>;
        reset: (tabId: string) => Promise<void>;
        history: (tabId: string) => Promise<{ messages: Array<{ role: string; content: string }>; processing: boolean }>;
      };
      context: {
        get: (projectDir: string) => Promise<{ instructions: string; skills: string[]; settings: string }>;
        saveInstructions: (projectDir: string, content: string) => Promise<void>;
        listSkills: (projectDir: string) => Promise<string[]>;
        getSkill: (projectDir: string, name: string) => Promise<string>;
        saveSkill: (projectDir: string, name: string, content: string) => Promise<void>;
        deleteSkill: (projectDir: string, name: string) => Promise<void>;
        getSettings: (projectDir: string) => Promise<string>;
        saveSettings: (projectDir: string, content: string) => Promise<void>;
      };
      specGate: {
        get: (projectDir: string) => Promise<string>;
        save: (projectDir: string, content: string) => Promise<void>;
        getDefault: () => Promise<string>;
        ensure: (projectDir: string) => Promise<boolean>;
      };
      modelSettings: {
        getGlobal: () => Promise<ModelSettings>;
        setGlobal: (settings: Partial<ModelSettings>) => Promise<void>;
        getProject: (projectDir: string) => Promise<ModelSettings | null>;
        setProject: (projectDir: string, settings: Partial<ModelSettings>) => Promise<void>;
        removeProject: (projectDir: string) => Promise<void>;
        getEffective: (projectDir: string) => Promise<ModelSettings>;
      };
      session: {
        getState: () => Promise<SessionMonitorState>;
        getSettings: () => Promise<SessionMonitorSettings>;
        updateSettings: (settings: Partial<SessionMonitorSettings>) => Promise<void>;
        acknowledgeCritical: () => Promise<void>;
        haltAll: () => Promise<string[]>;
        resumeAll: () => Promise<string[]>;
        resumeStack: (stackId: string) => Promise<void>;
        forcePoll: () => Promise<SessionMonitorState>;
      };
      auth: {
        status: () => Promise<{ loggedIn: boolean; email?: string; expired: boolean; expiresAt?: number }>;
        login: () => Promise<{ success: boolean; error?: string }>;
      };
      docker: {
        status: () => Promise<{ connected: boolean }>;
      };
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
    };
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  // Projects
  projects: [],
  activeProjectId: null,
  showOpenProjectDialog: false,

  // Stale workspaces
  staleWorkspaces: [],
  staleWorkspacesLoading: false,

  refreshStaleWorkspaces: async () => {
    try {
      set({ staleWorkspacesLoading: true });
      const staleWorkspaces = await window.sandstorm.stacks.detectStale();
      set({ staleWorkspaces, staleWorkspacesLoading: false });
    } catch {
      set({ staleWorkspacesLoading: false });
    }
  },

  cleanupStaleWorkspaces: async (workspacePaths: string[]) => {
    const results = await window.sandstorm.stacks.cleanupStale(workspacePaths);
    // Refresh after cleanup — don't let refresh failure mask cleanup results
    try {
      await get().refreshStaleWorkspaces();
    } catch {
      // Refresh failure is non-critical; cleanup results are returned regardless
    }
    return results;
  },

  // Docker connection
  dockerConnected: true, // assume connected initially
  setDockerConnected: (connected) => set({ dockerConnected: connected }),

  // Stacks
  stacks: [],
  stackHistory: [],
  stackMetrics: {},
  selectedStackId: null,
  showNewStackDialog: false,
  loading: false,
  error: null,

  // Token usage
  globalTokenUsage: null,
  rateLimitState: null,
  accountUsage: null,

  // Agent session state
  agentSessions: {},
  updateAgentSession: (tabId, update) =>
    set((state) => ({
      agentSessions: {
        ...state.agentSessions,
        [tabId]: {
          messages: [],
          streamingContent: '',
          isLoading: false,
          isQueued: false,
          ...(state.agentSessions[tabId] ?? {}),
          ...update,
        },
      },
    })),
  clearAgentSession: (tabId) =>
    set((state) => {
      const { [tabId]: _, ...rest } = state.agentSessions;
      return { agentSessions: rest };
    }),

  // Live workflow progress
  workflowProgress: {},
  updateWorkflowProgress: (stackId, progress) => {
    set((state) => ({
      workflowProgress: { ...state.workflowProgress, [stackId]: progress },
    }));
  },
  clearWorkflowProgress: (stackId) => {
    set((state) => {
      const { [stackId]: _, ...rest } = state.workflowProgress;
      return { workflowProgress: rest };
    });
  },

  // Model settings
  globalModelSettings: { inner_model: 'sonnet', outer_model: 'opus' },
  showModelSettings: false,
  setShowModelSettings: (show) => set({ showModelSettings: show }),

  refreshGlobalModelSettings: async () => {
    try {
      const globalModelSettings = await window.sandstorm.modelSettings.getGlobal();
      set({ globalModelSettings });
    } catch {
      // Non-fatal
    }
  },

  setGlobalModelSettings: async (settings) => {
    await window.sandstorm.modelSettings.setGlobal(settings);
    await get().refreshGlobalModelSettings();
  },

  getEffectiveModels: async (projectDir) => {
    return window.sandstorm.modelSettings.getEffective(projectDir);
  },

  getProjectModelSettings: async (projectDir) => {
    return window.sandstorm.modelSettings.getProject(projectDir);
  },

  setProjectModelSettings: async (projectDir, settings) => {
    await window.sandstorm.modelSettings.setProject(projectDir, settings);
  },

  removeProjectModelSettings: async (projectDir) => {
    await window.sandstorm.modelSettings.removeProject(projectDir);
  },

  // Session monitor
  sessionMonitorState: null,
  sessionMonitorSettings: null,
  sessionWarningLevel: null,
  showSessionWarningModal: false,
  setShowSessionWarningModal: (show) => set({ showSessionWarningModal: show }),

  refreshSessionState: async () => {
    try {
      const sessionMonitorState = await window.sandstorm.session.getState();
      set({ sessionMonitorState });
    } catch {
      // Non-fatal
    }
  },

  refreshSessionSettings: async () => {
    try {
      const sessionMonitorSettings = await window.sandstorm.session.getSettings();
      set({ sessionMonitorSettings });
    } catch {
      // Non-fatal
    }
  },

  updateSessionSettings: async (settings) => {
    await window.sandstorm.session.updateSettings(settings);
    await get().refreshSessionSettings();
  },

  sessionAcknowledgeCritical: async () => {
    await window.sandstorm.session.acknowledgeCritical();
  },

  sessionHaltAll: async () => {
    const paused = await window.sandstorm.session.haltAll();
    await get().refreshStacks();
    return paused;
  },

  sessionResumeAll: async () => {
    const resumed = await window.sandstorm.session.resumeAll();
    await get().refreshStacks();
    return resumed;
  },

  // Account usage budget
  tokenBudget: (() => {
    try {
      const saved = localStorage.getItem('sandstorm-token-budget');
      return saved ? Number(saved) : 0;
    } catch { return 0; }
  })(),
  setTokenBudget: (budget: number) => {
    localStorage.setItem('sandstorm-token-budget', String(budget));
    set({ tokenBudget: budget });
  },

  // Project actions
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (id) => set({ activeProjectId: id }),
  setShowOpenProjectDialog: (show) => set({ showOpenProjectDialog: show }),

  refreshProjects: async () => {
    try {
      const projects = await window.sandstorm.projects.list();
      set({ projects });
    } catch (err) {
      set({ error: `Failed to refresh projects: ${err}` });
    }
  },

  addProject: async (directory: string) => {
    const project = await window.sandstorm.projects.add(directory);
    await get().refreshProjects();
    return project;
  },

  removeProject: async (id: number) => {
    await window.sandstorm.projects.remove(id);
    const state = get();
    if (state.activeProjectId === id) {
      set({ activeProjectId: null });
    }
    await state.refreshProjects();
  },

  // Stack actions
  setStacks: (stacks) => set({ stacks }),
  selectStack: (id) => set({ selectedStackId: id }),
  setShowNewStackDialog: (show) => set({ showNewStackDialog: show }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  refreshStacks: async () => {
    try {
      const stacks = await window.sandstorm.stacks.list();
      set({ stacks, error: null });
    } catch (err) {
      set({ error: `Failed to refresh stacks: ${err}` });
    }
  },

  refreshStackHistory: async () => {
    try {
      const stackHistory = await window.sandstorm.stacks.history();
      set({ stackHistory });
    } catch (err) {
      set({ error: `Failed to refresh stack history: ${err}` });
    }
  },

  refreshMetrics: async () => {
    try {
      const { stacks, dockerConnected } = get();
      // Skip metrics refresh when Docker is disconnected
      if (!dockerConnected) return;
      const activeStatuses = new Set(['running', 'up', 'building', 'rebuilding', 'idle', 'completed', 'pushed', 'pr_created']);
      const activeStacks = stacks.filter((s) => activeStatuses.has(s.status));
      const metrics: Record<string, StackMetrics> = {};

      await Promise.all(
        activeStacks.map(async (stack) => {
          try {
            const [detailed, taskMetrics] = await Promise.all([
              window.sandstorm.stats.stackDetailed(stack.id),
              window.sandstorm.stats.taskMetrics(stack.id),
            ]);
            metrics[stack.id] = {
              totalMemory: detailed.totalMemory,
              containers: detailed.containers,
              taskMetrics,
            };
          } catch {
            // Individual stack metrics failure is non-fatal
          }
        })
      );

      set({ stackMetrics: metrics });

      // Also refresh token usage and rate limit state in parallel
      // (account usage is now handled by the session monitor's polling state machine)
      await Promise.all([
        get().refreshTokenUsage(),
        get().refreshRateLimitState(),
      ]);
    } catch {
      // Metrics refresh failure is non-fatal
    }
  },

  refreshTokenUsage: async () => {
    try {
      const globalTokenUsage = await window.sandstorm.stats.globalTokenUsage();
      set({ globalTokenUsage });
    } catch {
      // Token usage refresh failure is non-fatal
    }
  },


  refreshRateLimitState: async () => {
    try {
      const rateLimitState = await window.sandstorm.stats.rateLimit();
      set({ rateLimitState });
    } catch {
      // Rate limit state refresh failure is non-fatal
    }
  },

  refreshAccountUsage: async () => {
    try {
      const accountUsage = await window.sandstorm.stats.accountUsage();
      if (accountUsage) {
        set({ accountUsage });
      }
    } catch {
      // Account usage refresh failure is non-fatal
    }
  },

  // Derived
  filteredStacks: () => {
    const { stacks, activeProjectId, projects } = get();
    if (activeProjectId === null) return stacks;
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return stacks;
    return stacks.filter((s) => s.project_dir === project.directory);
  },

  filteredStackHistory: () => {
    const { stackHistory, activeProjectId, projects } = get();
    if (activeProjectId === null) return stackHistory;
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return stackHistory;
    return stackHistory.filter((s) => s.project_dir === project.directory);
  },

  activeProject: () => {
    const { activeProjectId, projects } = get();
    if (activeProjectId === null) return undefined;
    return projects.find((p) => p.id === activeProjectId);
  },
}));
