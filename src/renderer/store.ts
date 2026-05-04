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

export interface PortExposure {
  containerPort: number;
  hostPort?: number;
  exposed: boolean;
}

export interface ServiceInfo {
  name: string;
  status: string;
  exitCode?: number;
  hostPort?: number;
  containerPort?: number;
  containerId: string;
  ports: PortExposure[];
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

/**
 * Token totals for the CURRENT orchestrator session — the single source of
 * truth for the orchestrator token counter in the UI. Reset to zero when the
 * user clicks "New Session". Keyed by the renderer's agent tab id.
 *
 * Cache creation/read tokens are included honestly — on turn 1 of a new
 * session, cache_read_input_tokens may be non-zero if the prompt hits a
 * previously-cached prefix.
 */
export interface OuterClaudeSessionTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function zeroOuterClaudeSessionTokens(): OuterClaudeSessionTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export function outerClaudeTotal(t: OuterClaudeSessionTokens | null | undefined): number {
  if (!t) return 0;
  return (
    t.input_tokens +
    t.output_tokens +
    t.cache_creation_input_tokens +
    t.cache_read_input_tokens
  );
}

/** Color tier for the orchestrator token counter based on session total. */
export type OuterClaudeTokenTier = 'normal' | 'warning' | 'danger' | 'critical' | 'blocked';

export const OUTER_CLAUDE_WARNING_THRESHOLD = 100_000;
export const OUTER_CLAUDE_DANGER_THRESHOLD = 150_000;
export const OUTER_CLAUDE_CRITICAL_THRESHOLD = 200_000;
export const OUTER_CLAUDE_BLOCK_THRESHOLD = 250_000;

export function outerClaudeTier(total: number): OuterClaudeTokenTier {
  if (total >= OUTER_CLAUDE_BLOCK_THRESHOLD) return 'blocked';
  if (total >= OUTER_CLAUDE_CRITICAL_THRESHOLD) return 'critical';
  if (total >= OUTER_CLAUDE_DANGER_THRESHOLD) return 'danger';
  if (total >= OUTER_CLAUDE_WARNING_THRESHOLD) return 'warning';
  return 'normal';
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
  claudeAvailable: boolean | null;
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

/**
 * Renderer-side mirror of `ScheduleAction` from src/main/scheduler/types.ts.
 * This PR only ships `run-script`; follow-up tickets add more kinds.
 */
export type ScheduleAction =
  | { kind: 'run-script'; scriptName: string };

/** Renderer-side mirror of `BuiltInAction` from src/main/scheduler/built-in-actions.ts. */
export interface BuiltInAction {
  kind: ScheduleAction['kind'];
  label: string;
  description: string;
  defaultAction: ScheduleAction;
}

export interface ScheduleEntry {
  id: string;
  label?: string;
  cronExpression: string;
  action: ScheduleAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  showRefineTicketDialog: boolean;
  /**
   * Optional ticket id passed when opening the Refine dialog from another
   * surface (e.g. the Create-Ticket success screen's "Refine #N" hand-off).
   * The Refine dialog reads + clears it on mount. Null when the user opened
   * Refine cold from the Tickets strip and should type the id themselves.
   */
  refineTicketPrefill: string | null;
  showCreateTicketDialog: boolean;
  showStartTicketDialog: boolean;
  showCreatePRDialog: { stackId: string } | null;
  /**
   * Drafted PR title/body keyed by stackId — survives the dialog being
   * closed/reopened so the user doesn't pay for another ephemeral Claude
   * call to redraft (#320). Cleared after a successful PR creation.
   */
  prDraftCache: Record<string, { title: string; body: string }>;
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

  // Orchestrator token usage (per-tab, current session only)
  outerClaudeTokens: Record<string, OuterClaudeSessionTokens>;
  setOuterClaudeTokens: (tabId: string, tokens: OuterClaudeSessionTokens) => void;
  clearOuterClaudeTokens: (tabId: string) => void;

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
  /** Non-dismissive modal shown when user tries to resume but token limit hasn't refreshed */
  sessionTokenLimitModal: { resetAt: string | null } | null;
  setSessionTokenLimitModal: (state: { resetAt: string | null } | null) => void;
  refreshSessionState: () => Promise<void>;
  refreshSessionSettings: () => Promise<void>;
  updateSessionSettings: (settings: Partial<SessionMonitorSettings>) => Promise<void>;
  sessionAcknowledgeCritical: () => Promise<void>;
  sessionHaltAll: () => Promise<string[]>;
  sessionResumeAll: () => Promise<string[]>;
  resumeStackWithContinuation: (stackId: string) => Promise<void>;

  // Schedules (per-project)
  schedules: ScheduleEntry[];
  schedulesLoading: boolean;
  cronHealthy: boolean | null;
  _schedulesProjectDir: string | null;
  refreshSchedules: (projectDir: string) => Promise<void>;
  refreshCronHealth: () => Promise<void>;

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
  setShowRefineTicketDialog: (show: boolean) => void;
  /** Open the Refine dialog with a ticket id already filled in. */
  openRefineTicketDialogWith: (ticketId: string) => void;
  consumeRefineTicketPrefill: () => string | null;
  setShowCreateTicketDialog: (show: boolean) => void;
  setShowStartTicketDialog: (show: boolean) => void;
  setShowCreatePRDialog: (state: { stackId: string } | null) => void;
  setPrDraft: (stackId: string, draft: { title: string; body: string }) => void;
  clearPrDraft: (stackId: string) => void;
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
        initialize: (directory: string) => Promise<{ success: boolean; error?: string; skippedFiles?: string[] }>;
        checkMigration: (directory: string) => Promise<{
          needsMigration: boolean;
          missingVerifyScript?: boolean;
          missingServiceLabels?: boolean;
          missingSpecQualityGate?: boolean;
          missingReviewPrompt?: boolean;
          legacyPortMappings?: boolean;
          missingUpdateScript?: boolean;
          missingCreatePrScript?: boolean;
          detectedTicketProvider?: 'github' | 'jira' | 'skeleton';
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
        installUpdateScript: (
          directory: string,
          provider: 'github' | 'jira' | 'skeleton',
        ) => Promise<{ success: boolean; path?: string; error?: string }>;
        installCreatePrScript: (
          directory: string,
          provider: 'github' | 'jira' | 'skeleton',
        ) => Promise<{ success: boolean; path?: string; error?: string }>;
        detectTicketProvider: (
          directory: string,
        ) => Promise<{ provider: 'github' | 'jira' | 'skeleton' }>;
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
        expose: (stackId: string, service: string, containerPort: number) => Promise<number>;
        unexpose: (stackId: string, service: string, containerPort: number) => Promise<void>;
        cleanupLegacy: (directory: string) => Promise<{ success: boolean; error?: string }>;
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
      };
      runtime: {
        available: () => Promise<{ docker: boolean; podman: boolean }>;
      };
      agent: {
        send: (tabId: string, message: string, projectDir?: string) => Promise<void>;
        cancel: (tabId: string) => Promise<void>;
        reset: (tabId: string) => Promise<void>;
        history: (tabId: string) => Promise<{ messages: Array<{ role: string; content: string }>; processing: boolean }>;
        tokenUsage: (tabId: string) => Promise<OuterClaudeSessionTokens>;
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
      reviewPrompt: {
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
        resumeStackWithContinuation: (stackId: string) => Promise<{
          halted: boolean;
          resetAt?: string | null;
          outcome?: 'resuming_with_session' | 'resumed_fresh' | 'idle';
        }>;
        forcePoll: () => Promise<SessionMonitorState>;
        reportActivity: () => void;
      };
      schedules: {
        list: (projectDir: string) => Promise<ScheduleEntry[]>;
        create: (projectDir: string, data: { label?: string; cronExpression: string; action: ScheduleAction; enabled?: boolean }) => Promise<ScheduleEntry>;
        update: (projectDir: string, id: string, patch: { label?: string; cronExpression?: string; action?: ScheduleAction; enabled?: boolean }) => Promise<ScheduleEntry>;
        delete: (projectDir: string, id: string) => Promise<void>;
        cronHealth: () => Promise<{ running: boolean }>;
        listBuiltInActions: () => Promise<BuiltInAction[]>;
        listScripts: (projectDir: string) => Promise<string[]>;
      };
      auth: {
        status: () => Promise<{ loggedIn: boolean; email?: string; expired: boolean; expiresAt?: number }>;
        login: () => Promise<{ success: boolean; error?: string }>;
      };
      docker: {
        status: () => Promise<{ connected: boolean }>;
      };
      tickets: {
        fetch: (ticketId: string, projectDir: string) => Promise<{ body: string; url: string | null }>;
        specCheck: (ticketId: string, projectDir: string) => Promise<SpecGateResult>;
        specRefine: (ticketId: string, projectDir: string, userAnswers: string) => Promise<SpecGateResult>;
        create: (projectDir: string, title: string, body: string) => Promise<{ url: string; number: number; ticketId: string }>;
      };
      pr: {
        draftBody: (stackId: string) => Promise<{ title: string; body: string }>;
        create: (stackId: string, title: string, body: string) => Promise<{ url: string; number: number }>;
      };
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
    };
  }
}

/** Renderer-side mirror of `SpecGateResult` from main/control-plane/ticket-spec.ts. */
export interface SpecGateResult {
  passed: boolean;
  questions: string[];
  gateSummary: string;
  ticketUrl: string | null;
  cached: boolean;
  error?: string;
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
  showRefineTicketDialog: false,
  refineTicketPrefill: null,
  showCreateTicketDialog: false,
  showStartTicketDialog: false,
  showCreatePRDialog: null,
  prDraftCache: {},
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
          ...(state.agentSessions[tabId] ?? {
            messages: [],
            streamingContent: '',
            isLoading: false,
            isQueued: false,
          }),
          ...update,
        },
      },
    })),
  clearAgentSession: (tabId) =>
    set((state) => {
      const { [tabId]: _, ...rest } = state.agentSessions;
      return { agentSessions: rest };
    }),

  // Orchestrator token usage (per-tab, current session only)
  outerClaudeTokens: {},
  setOuterClaudeTokens: (tabId, tokens) =>
    set((state) => ({
      outerClaudeTokens: { ...state.outerClaudeTokens, [tabId]: tokens },
    })),
  clearOuterClaudeTokens: (tabId) =>
    set((state) => {
      const { [tabId]: _, ...rest } = state.outerClaudeTokens;
      return { outerClaudeTokens: rest };
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
  sessionTokenLimitModal: null,
  setSessionTokenLimitModal: (state) => set({ sessionTokenLimitModal: state }),

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

  resumeStackWithContinuation: async (stackId: string) => {
    const result = await window.sandstorm.session.resumeStackWithContinuation(stackId);
    if (result.halted) {
      get().setSessionTokenLimitModal({ resetAt: result.resetAt ?? null });
      return;
    }
    await get().refreshStacks();
  },

  // Schedules
  schedules: [],
  schedulesLoading: false,
  cronHealthy: null,
  _schedulesProjectDir: null as string | null,

  refreshSchedules: async (projectDir: string) => {
    try {
      set({ schedulesLoading: true, _schedulesProjectDir: projectDir });
      const schedules = await window.sandstorm.schedules.list(projectDir);
      // Guard against stale responses from a previous project
      if (get()._schedulesProjectDir !== projectDir) return;
      set({ schedules, schedulesLoading: false });
    } catch {
      if (get()._schedulesProjectDir === projectDir) {
        set({ schedulesLoading: false });
      }
    }
  },

  refreshCronHealth: async () => {
    try {
      const result = await window.sandstorm.schedules.cronHealth();
      set({ cronHealthy: result.running });
    } catch {
      set({ cronHealthy: null });
    }
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
  setShowRefineTicketDialog: (show) => set({
    showRefineTicketDialog: show,
    // Closing the dialog drops any pending prefill so a later cold-open
    // doesn't accidentally hydrate from a stale id.
    refineTicketPrefill: show ? get().refineTicketPrefill : null,
  }),
  openRefineTicketDialogWith: (ticketId) => set({
    showRefineTicketDialog: true,
    refineTicketPrefill: ticketId,
  }),
  consumeRefineTicketPrefill: () => {
    const value = get().refineTicketPrefill;
    if (value !== null) set({ refineTicketPrefill: null });
    return value;
  },
  setShowCreateTicketDialog: (show) => set({ showCreateTicketDialog: show }),
  setShowStartTicketDialog: (show) => set({ showStartTicketDialog: show }),
  setShowCreatePRDialog: (state) => set({ showCreatePRDialog: state }),
  setPrDraft: (stackId, draft) =>
    set((state) => ({
      prDraftCache: { ...state.prDraftCache, [stackId]: draft },
    })),
  clearPrDraft: (stackId) =>
    set((state) => {
      const next = { ...state.prDraftCache };
      delete next[stackId];
      return { prDraftCache: next };
    }),
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
