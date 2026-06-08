import { create } from 'zustand';
import { KANBAN_COLUMNS } from './types/kanban';
import type { KanbanColumn } from './types/kanban';
import { suggestStackName } from './lib/stack-name';
import type {
  TelemetrySummary,
  DailyEntry,
  ByModelEntry,
  ByTicketEntry,
  SessionEntry,
  DateRange,
} from '@main/telemetry/types';

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
  selfheal_continue_used: number;
  latest_task_token_limited: boolean;
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
  execute_outputs: string | null;
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

export interface BackendSettings {
  inner_backend: string;
  outer_backend: string;
  inner_provider: string | null;
  inner_model: string | null;
  outer_provider: string | null;
  outer_model: string | null;
}

export type TicketListError =
  | { reason: 'missing-creds' }
  | { reason: 'http-status'; status: number; body?: string }
  | { reason: 'network'; message: string };

function formatTicketListError(error: TicketListError): string {
  switch (error.reason) {
    case 'missing-creds':
      return 'JIRA credentials missing — configure them in Project Settings';
    case 'http-status':
      return `JIRA error ${error.status}${error.body ? ': ' + error.body.slice(0, 100) : ''}`;
    case 'network':
      return error.message;
  }
}

export interface ProjectTicketConfig {
  provider: 'github' | 'jira';
  jira_url?: string | null;
  jira_username?: string | null;
  jira_api_token?: string | null;
  jira_project_key?: string | null;
  jira_issue_type?: string | null;
  ticket_prefix?: string | null;
}

export { KANBAN_COLUMNS };
export type { KanbanColumn };

export type RefinementResolution =
  | { kind: 'silent'; previousColumn: KanbanColumn }
  | { kind: 'confirm'; stackId: string; previousColumn: KanbanColumn }
  | { kind: 'error'; message: string };

/** Returns tickets for the given project directory, or all tickets if no directory is provided. */
export function selectProjectTickets(boardTickets: TicketBoardEntry[], projectDir: string | undefined): TicketBoardEntry[] {
  return projectDir ? boardTickets.filter((t) => t.project_dir === projectDir) : boardTickets;
}

export interface TicketBoardEntry {
  ticket_id: string;
  project_dir: string;
  column: KanbanColumn;
  title: string;
  created_at?: string;
  updated_at: string;
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
  selectedStackId: string | null;
  showRefineTicketDialog: boolean;
  /**
   * Optional ticket id passed when opening the Refine dialog from another
   * surface (e.g. the Create-Ticket success screen's "Refine #N" hand-off).
   * The Refine dialog reads + clears it on mount. Null when the user opened
   * Refine cold from the Tickets strip and should type the id themselves.
   */
  refineTicketPrefill: string | null;
  /** All known refinement sessions (running, ready, errored, interrupted). */
  refinementSessions: RefinementSession[];
  /** ID of the session currently shown in the refine dialog (null = new refinement). */
  currentRefinementSessionId: string | null;
  /** In-memory draft answers keyed by sessionId — survives dialog close/reopen (#459). Not persisted to disk. */
  refineAnswerDrafts: Record<string, { optionId: string | null; text: string }[]>;
  setRefineAnswerDraft: (sessionId: string, answers: { optionId: string | null; text: string }[]) => void;
  clearRefineAnswerDraft: (sessionId: string) => void;
  showCreateTicketDialog: boolean;
  showEditTicketDialog: boolean;
  editTicketTarget: { ticketId: string; projectDir: string } | null;
  showStartTicketDialog: boolean;
  showCreatePRDialog: { stackId: string; initialError?: string } | null;
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

  // Backend settings
  globalBackendSettings: BackendSettings;
  refreshGlobalBackendSettings: () => Promise<void>;
  setGlobalBackendSettings: (settings: Partial<BackendSettings>) => Promise<void>;
  getProjectBackendSettings: (projectDir: string) => Promise<BackendSettings | null>;
  setProjectBackendSettings: (projectDir: string, settings: Partial<BackendSettings>) => Promise<void>;
  getEffectiveBackend: (projectDir: string, surface: 'inner' | 'outer') => Promise<{ backend: 'claude' | 'opencode'; provider?: string; model?: string }>;
  setBackendSecret: (scope: 'global' | string, surface: 'inner' | 'outer', value: string) => Promise<void>;
  getBackendSecretStatus: (scope: 'global' | string, surface: 'inner' | 'outer') => Promise<{ set: boolean }>;

  // Project ticket config
  getProjectTicketConfig: (projectDir: string) => Promise<ProjectTicketConfig | null>;
  setProjectTicketConfig: (projectDir: string, config: ProjectTicketConfig) => Promise<void>;

  // Dark factory
  getDarkFactoryEnabled: (projectDir: string) => Promise<boolean>;
  setDarkFactoryEnabled: (projectDir: string, enabled: boolean) => Promise<void>;

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
  resumeStackWithContinuation: (stackId: string, manual?: boolean) => Promise<void>;
  recheckCompletedStack: (stackId: string) => Promise<{
    outcome: 'resuming_with_session' | 'resumed_fresh' | 'not_token_limited' | 'container_gone' | 'idle';
  }>;

  // Kanban board
  boardTickets: TicketBoardEntry[];
  boardTicketsLoading: boolean;
  boardTicketsError: string | null;
  /** Surfaced when persisting a column move via IPC fails — separate from the load-error field so the UI can show it independently. */
  moveTicketColumnError: string | null;
  /** Clears the surfaced column-move error. */
  clearMoveTicketColumnError: () => void;
  lastTicketFetchAt: number | null;
  refreshBoardTickets: (projectDir: string) => Promise<void>;
  moveTicketColumn: (ticketId: string, projectDir: string, column: KanbanColumn) => Promise<void>;
  /**
   * Resolve how to handle starting refinement for a ticket:
   * - 'silent': move to refining with no modal (0 live stacks, or already in refining)
   * - 'confirm': show teardown confirmation modal first (exactly 1 live stack)
   * - 'error': surface an error (>1 live stacks)
   */
  resolveRefinementTargets: (ticketId: string, projectDir: string) => RefinementResolution;
  /** Move ticket to 'refining' and stash _refineDialogContext for revert-on-cancel. */
  commitRefinementContext: (ticketId: string, projectDir: string, previousColumn: KanbanColumn) => void;
  /** Starts the spec gate in the background (no modal) for an initial Refine click from a backlog card. Moves ticket to 'refining'. */
  openRefineDialogFromCard: (ticketId: string, projectDir: string, previousColumn: KanbanColumn) => void;
  /** Opens the Create PR dialog as fallback (Q3/Q4). Does NOT move the ticket column optimistically. */
  openCreatePRDialogForTicket: (stackId: string, ticketId: string, projectDir: string, previousColumn: KanbanColumn, initialError?: string) => void;
  _refineDialogContext: { ticketId: string; projectDir: string; previousColumn: KanbanColumn } | null;
  _prDialogContext: { stackId: string; ticketId: string; projectDir: string; previousColumn: KanbanColumn; prCreated: boolean } | null;
  /** Per-ticket create error message, keyed by `${ticketId}|${projectDir}`. Set on fetch/create failure; cleared on retry success or column change away from in_stack. */
  stackCreateErrors: Record<string, string>;
  /** Per-ticket in-flight flag, keyed by `${ticketId}|${projectDir}`. Guards against double-clicks. */
  stackCreateInFlight: Record<string, boolean>;
  /** Per-ticket in-flight flag for background refine gate start, keyed by `${ticketId}|${projectDir}`. Guards against double-clicks during latency window. */
  refineInFlight: Record<string, boolean>;
  /** Per-ticket error message when the background refine gate fails to start, keyed by `${ticketId}|${projectDir}`. */
  refineStartErrors: Record<string, string>;
  /** One-click stack creation from a spec_ready card — no dialog. */
  startStackForTicket: (ticketId: string, projectDir: string) => Promise<void>;
  /** Per-ticket merge in-flight flag, keyed by `${ticketId}|${projectDir}`. Guards against double-clicks on Merge. */
  mergeInFlight: Record<string, boolean>;
  /** Per-ticket conflict flag, keyed by `${ticketId}|${projectDir}`. Set when a merge attempt fails due to confirmed CONFLICTING mergeability; cleared when auto-resolve returns resolved or no_conflicts. Ephemeral — resets on page reload. */
  mergeConflicts: Record<string, boolean>;
  /** GitHub PR merge → stack teardown → card move to 'merged', in that order. Aborts on any failure and surfaces via moveTicketColumnError. */
  mergeTicket: (ticketId: string, projectDir: string) => Promise<void>;
  /** Per-stack in-flight flag for background PR creation, keyed by stackId. */
  prCreateInFlight: Record<string, boolean>;
  /** Per-stack inline PR-creation error, keyed by stackId. Set on draft_failed/create_failed/thrown error; cleared on retry. */
  prCreateErrors: Record<string, string>;
  /** One-click PR creation: draft + create in background; stays in in_stack with inline error on failure. */
  createPRAutomatic: (stackId: string, ticketId: string, projectDir: string, previousColumn: KanbanColumn) => Promise<void>;
  /** Per-ticket in-flight flag for discard operation, keyed by `${ticketId}|${projectDir}`. */
  discardInFlight: Record<string, boolean>;
  /** Per-ticket discard error message, keyed by `${ticketId}|${projectDir}`. Cleared at the start of the next discard attempt. */
  discardErrors: Record<string, string>;
  /** Best-effort teardown → card disposition (backlog or close+delete). Surfaces close failure via discardErrors (R2). */
  discardStack: (ticketId: string, projectDir: string, disposition: 'backlog' | 'close') => Promise<void>;

  /** Per-ticket in-flight flag for auto-resolve, keyed by `${ticketId}|${projectDir}`. Guards against double-clicks. */
  autoResolveInFlight: Record<string, boolean>;
  /** Per-ticket error message for auto-resolve, keyed by `${ticketId}|${projectDir}`. Cleared at the start of the next attempt. */
  autoResolveErrors: Record<string, string>;
  /** Query PR merge state and dispatch the inner agent to resolve conflicts if conflicting. */
  autoResolveConflicts: (ticketId: string, projectDir: string) => Promise<void>;

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
  setShowRefineTicketDialog: (show: boolean) => void;
  /** Open the Refine dialog with a ticket id already filled in. */
  openRefineTicketDialogWith: (ticketId: string) => void;
  consumeRefineTicketPrefill: () => string | null;
  /** Open the refine dialog showing a specific existing session. */
  openRefinementSession: (sessionId: string) => void;
  /** Add or update a refinement session (called on refinement:update events). */
  upsertRefinementSession: (session: RefinementSession, opts?: { replay?: boolean }) => void;
  /** Append a streaming text chunk to a running session's output. */
  appendRefinementStreamChunk: (sessionId: string, delta: string) => void;
  /** Remove a refinement session (after cancel or dismiss). */
  removeRefinementSession: (sessionId: string) => void;
  /** Set which session id is shown in the refine dialog. */
  setCurrentRefinementSessionId: (id: string | null) => void;
  /** Cancel the current session for a ticket and start a fresh spec-gate run. Opens the dialog to the new session. */
  retryRefinementForTicket: (ticketId: string, projectDir: string) => Promise<void>;
  setShowCreateTicketDialog: (show: boolean) => void;
  setShowEditTicketDialog: (show: boolean) => void;
  openEditTicketDialog: (ticketId: string, projectDir: string) => void;
  setShowStartTicketDialog: (show: boolean) => void;
  setShowCreatePRDialog: (state: { stackId: string; initialError?: string } | null) => void;
  setPrDraft: (stackId: string, draft: { title: string; body: string }) => void;
  clearPrDraft: (stackId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  refreshStacks: () => Promise<void>;
  refreshMetrics: () => Promise<void>;
  refreshTokenUsage: () => Promise<void>;
  refreshRateLimitState: () => Promise<void>;
  refreshAccountUsage: () => Promise<void>;

  // Derived
  filteredStacks: () => Stack[];
  activeProject: () => Project | undefined;

  // View navigation
  mainView: 'board' | 'telemetry';
  setMainView: (view: 'board' | 'telemetry') => void;

  // Global ticket search
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Telemetry slice
  telemetryRange: '7d' | '30d' | '90d' | 'all';
  telemetrySummary: TelemetrySummary | null;
  telemetryDaily: DailyEntry[];
  telemetryByModel: ByModelEntry[];
  telemetryByTicket: ByTicketEntry[];
  telemetryLoading: boolean;
  telemetryError: string | null;
  setTelemetryRange: (range: '7d' | '30d' | '90d' | 'all') => void;
  fetchTelemetry: () => Promise<void>;
  refreshTelemetry: () => Promise<void>;
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
          legacyPortMappings?: boolean;
          ticketProviderUnconfigured?: boolean;
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
        setPr: (id: string, prUrl: string, prNumber: number) => Promise<void>;
        detectStale: () => Promise<StaleWorkspace[]>;
        cleanupStale: (workspacePaths: string[]) => Promise<CleanupResult[]>;
        getNeedsHumanQuestions: (stackId: string) => Promise<string | null>;
        resumeNeedsHuman: (stackId: string, answers: string) => Promise<void>;
        selfHealContinue: (stackId: string) => Promise<void>;
        restartWithFindings: (stackId: string, updatedTicketBody: string) => Promise<{ newStackId: string }>;
        recheckCompleted: (stackId: string) => Promise<{
          outcome: 'resuming_with_session' | 'resumed_fresh' | 'not_token_limited' | 'container_gone' | 'idle';
        }>;
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
      reviewPrompt: {
        getDefault: () => Promise<string>;
      };
      modelSettings: {
        getGlobal: () => Promise<ModelSettings>;
        setGlobal: (settings: Partial<ModelSettings>) => Promise<void>;
        getProject: (projectDir: string) => Promise<ModelSettings | null>;
        setProject: (projectDir: string, settings: Partial<ModelSettings>) => Promise<void>;
        removeProject: (projectDir: string) => Promise<void>;
        getEffective: (projectDir: string) => Promise<ModelSettings>;
      };
      backendSettings: {
        getGlobal: () => Promise<BackendSettings>;
        setGlobal: (settings: Partial<BackendSettings>) => Promise<void>;
        getProject: (projectDir: string) => Promise<BackendSettings | null>;
        setProject: (projectDir: string, settings: Partial<BackendSettings>) => Promise<void>;
        getEffective: (projectDir: string, surface: 'inner' | 'outer') => Promise<{ backend: 'claude' | 'opencode'; provider?: string; model?: string }>;
        setSecret: (scope: 'global' | string, surface: 'inner' | 'outer', name: string, value: string) => Promise<void>;
        secretStatus: (scope: 'global' | string, surface: 'inner' | 'outer') => Promise<{ set: boolean }>;
      };
      projectTicketConfig: {
        get: (projectDir: string) => Promise<ProjectTicketConfig | null>;
        set: (projectDir: string, config: ProjectTicketConfig) => Promise<void>;
      };
      session: {
        getState: () => Promise<SessionMonitorState>;
        getSettings: () => Promise<SessionMonitorSettings>;
        updateSettings: (settings: Partial<SessionMonitorSettings>) => Promise<void>;
        acknowledgeCritical: () => Promise<void>;
        haltAll: () => Promise<string[]>;
        resumeAll: () => Promise<string[]>;
        resumeStack: (stackId: string) => Promise<void>;
        resumeStackWithContinuation: (stackId: string, manual?: boolean) => Promise<{
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
        specCheckAsync: (ticketId: string, projectDir: string) => Promise<{ sessionId: string }>;
        specRefineAsync: (sessionId: string, ticketId: string, projectDir: string, userAnswers: string) => Promise<void>;
        retryRefinementAsync: (sessionId: string, ticketId: string, projectDir: string) => Promise<{ sessionId: string }>;
        postAnswers: (ticketId: string, projectDir: string, answersBody: string) => Promise<void>;
        cancelRefinement: (sessionId: string) => Promise<void>;
        listRefinements: () => Promise<RefinementSession[]>;
        create: (projectDir: string, title: string, body: string) => Promise<{ url: string; number: number; ticketId: string }>;
        list: (projectDir: string) => Promise<{ tickets: TicketBoardEntry[]; error: TicketListError | null }>;
        fetchRaw: (ticketId: string, projectDir: string) => Promise<string | null>;
        update: (projectDir: string, ticketId: string, body: string) => Promise<void>;
        testJiraConnection: (params: {
          jiraUrl: string;
          jiraUsername: string;
          jiraApiToken: string;
          label?: string;
        }) => Promise<{
          auth: { ok: true; displayName: string } | { ok: false; status?: number; message: string };
          jql: { ok: true; count: number; hasMore: boolean } | { ok: false; status?: number; message: string } | null;
        }>;
        close: (ticketId: string, projectDir: string) => Promise<void>;
        markDone: (ticketId: string, projectDir: string) => Promise<{ ok: true } | { ok: false; error: string }>;
      };
      ticketBoard: {
        setColumn: (ticketId: string, projectDir: string, column: string) => Promise<void>;
        delete: (ticketId: string, projectDir: string) => Promise<void>;
      };
      pr: {
        draftBody: (stackId: string) => Promise<{ title: string; body: string }>;
        create: (stackId: string, title: string, body: string) => Promise<{ url: string; number: number }>;
        merge: (stackId: string, prNumber: number) => Promise<{ status: 'merged' } | { status: 'conflict' } | { status: 'failed'; error: string }>;
        createAuto: (stackId: string) => Promise<
          | { status: 'created'; url: string; number: number }
          | { status: 'draft_failed' }
          | { status: 'create_failed'; draft: { title: string; body: string }; error: string }
        >;
        autoResolve: (ticketId: string, projectDir: string) => Promise<
          | { status: 'resolved' }
          | { status: 'no_conflicts' }
          | { status: 'unknown_state' }
          | { status: 'failed'; error: string }
        >;
      };
      darkFactory: {
        getEnabled: (projectDir: string) => Promise<boolean>;
        setEnabled: (projectDir: string, enabled: boolean) => Promise<void>;
      };
      telemetry: {
        summary: (range: DateRange) => Promise<TelemetrySummary>;
        daily: (range: DateRange) => Promise<DailyEntry[]>;
        byModel: (range: DateRange) => Promise<ByModelEntry[]>;
        session: (range: DateRange) => Promise<SessionEntry[]>;
        byTicket: (range?: DateRange) => Promise<ByTicketEntry[]>;
        refresh: () => Promise<{ ok: true }>;
      };
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
    };
  }
}

export interface RefineQuestionOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface RefineQuestion {
  id: string;
  question: string;
  options: RefineQuestionOption[];
  /** 'gap' = self-resolvable spec correction (read-only in UI, not fed to spec_refine) */
  kind?: 'gap';
}

/** Renderer-side mirror of `SpecGateResult` from main/control-plane/ticket-spec.ts. */
export interface SpecGateResult {
  passed: boolean;
  questions: RefineQuestion[];
  gateSummary: string;
  ticketUrl: string | null;
  cached: boolean;
  error?: string;
  /** Full evaluator report text, capped at 64KB. Present on FAIL; null/absent on PASS or error. */
  reportText?: string | null;
}

export type RefinementStatus = 'running' | 'ready' | 'errored' | 'interrupted';

/** Mirrors RefinementSession from main/control-plane/refinement-store.ts. */
export interface RefinementSession {
  id: string;
  ticketId: string;
  projectDir: string;
  status: RefinementStatus;
  phase: 'check' | 'refine';
  result?: SpecGateResult;
  error?: string;
  startedAt: number;
  /** Live streamed output from the ephemeral gate subprocess while running. */
  streamingOutput?: string;
}

function getDateRange(range: '7d' | '30d' | '90d' | 'all'): DateRange {
  const today = new Date();
  const until = today.toISOString().slice(0, 10);
  if (range === 'all') return { since: '1970-01-01', until };
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(today);
  since.setDate(since.getDate() - days);
  return { since: since.toISOString().slice(0, 10), until };
}

// Monotonic counter to discard stale responses when range chips are toggled rapidly
let _telemetryFetchSeq = 0;

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
  stackMetrics: {},
  selectedStackId: null,
  showRefineTicketDialog: false,
  refineTicketPrefill: null,
  refinementSessions: [],
  currentRefinementSessionId: null,
  refineAnswerDrafts: {},
  showCreateTicketDialog: false,
  showEditTicketDialog: false,
  editTicketTarget: null,
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

  // Backend settings
  globalBackendSettings: { inner_backend: 'claude', outer_backend: 'claude', inner_provider: null, inner_model: null, outer_provider: null, outer_model: null },

  refreshGlobalBackendSettings: async () => {
    try {
      const globalBackendSettings = await window.sandstorm.backendSettings.getGlobal();
      set({ globalBackendSettings });
    } catch {
      // Non-fatal
    }
  },

  setGlobalBackendSettings: async (settings) => {
    await window.sandstorm.backendSettings.setGlobal(settings);
    await get().refreshGlobalBackendSettings();
  },

  getProjectBackendSettings: async (projectDir) => {
    return window.sandstorm.backendSettings.getProject(projectDir);
  },

  setProjectBackendSettings: async (projectDir, settings) => {
    await window.sandstorm.backendSettings.setProject(projectDir, settings);
  },

  getEffectiveBackend: async (projectDir, surface) => {
    return window.sandstorm.backendSettings.getEffective(projectDir, surface);
  },

  setBackendSecret: async (scope, surface, value) => {
    await window.sandstorm.backendSettings.setSecret(scope, surface, 'api_key', value);
  },

  getBackendSecretStatus: async (scope, surface) => {
    return window.sandstorm.backendSettings.secretStatus(scope, surface);
  },

  // Project ticket config
  getProjectTicketConfig: async (projectDir) => {
    return window.sandstorm.projectTicketConfig.get(projectDir);
  },

  setProjectTicketConfig: async (projectDir, config) => {
    await window.sandstorm.projectTicketConfig.set(projectDir, config);
  },

  // Dark factory
  getDarkFactoryEnabled: async (projectDir) => {
    return window.sandstorm.darkFactory.getEnabled(projectDir);
  },

  setDarkFactoryEnabled: async (projectDir, enabled) => {
    await window.sandstorm.darkFactory.setEnabled(projectDir, enabled);
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

  resumeStackWithContinuation: async (stackId: string, manual?: boolean) => {
    const result = await window.sandstorm.session.resumeStackWithContinuation(stackId, manual);
    if (result.halted) {
      get().setSessionTokenLimitModal({ resetAt: result.resetAt ?? null });
      return;
    }
    await get().refreshStacks();
  },

  recheckCompletedStack: async (stackId: string) => {
    const result = await window.sandstorm.stacks.recheckCompleted(stackId);
    await get().refreshStacks();
    return result;
  },

  // Kanban board
  boardTickets: [],
  boardTicketsLoading: false,
  boardTicketsError: null,
  moveTicketColumnError: null,
  lastTicketFetchAt: null,
  _refineDialogContext: null,
  _prDialogContext: null,
  stackCreateErrors: {},
  stackCreateInFlight: {},
  mergeInFlight: {},
  mergeConflicts: {},
  prCreateInFlight: {},
  prCreateErrors: {},
  discardInFlight: {},
  discardErrors: {},
  refineInFlight: {},
  refineStartErrors: {},

  clearMoveTicketColumnError: () => set({ moveTicketColumnError: null }),

  refreshBoardTickets: async (projectDir: string) => {
    try {
      set({ boardTicketsLoading: true });
      const { tickets, error } = await window.sandstorm.tickets.list(projectDir);
      const errorMessage = error ? formatTicketListError(error) : null;
      set({ boardTickets: tickets ?? [], boardTicketsLoading: false, boardTicketsError: errorMessage, lastTicketFetchAt: Date.now() });
    } catch (err) {
      console.error('[refreshBoardTickets]', err);
      set({ boardTicketsLoading: false, boardTicketsError: String(err) });
    }
  },

  moveTicketColumn: async (ticketId: string, projectDir: string, column: KanbanColumn) => {
    const previousColumn = get().boardTickets.find(t => t.ticket_id === ticketId)?.column;
    // Clear per-ticket create error when moving the ticket away from in_stack.
    if (previousColumn === 'in_stack' && column !== 'in_stack') {
      const key = `${ticketId}|${projectDir}`;
      set((state) => {
        const { [key]: _, ...rest } = state.stackCreateErrors;
        return { stackCreateErrors: rest };
      });
    }
    // Optimistic update — match only on ticket_id; boardTickets are already project-scoped.
    set((state) => ({
      boardTickets: state.boardTickets.map((t) =>
        t.ticket_id === ticketId ? { ...t, column } : t
      ),
    }));
    try {
      await window.sandstorm.ticketBoard.setColumn(ticketId, projectDir, column);
      // Clear any prior surfaced move error on success.
      if (get().moveTicketColumnError !== null) set({ moveTicketColumnError: null });
    } catch (err) {
      // Persistence failed — revert the optimistic update AND surface the error.
      // Without surfacing, the user sees a card revert to its old column with no explanation
      // (the original silent rollback that caused #388 reports of "stuck in backlog").
      console.error('[moveTicketColumn]', err);
      if (previousColumn !== undefined) {
        set((state) => ({
          boardTickets: state.boardTickets.map((t) =>
            t.ticket_id === ticketId ? { ...t, column: previousColumn } : t
          ),
        }));
      }
      const message = err instanceof Error ? err.message : String(err);
      set({ moveTicketColumnError: `Failed to move ticket #${ticketId} to ${column}: ${message}` });
    }
  },

  resolveRefinementTargets: (ticketId, projectDir) => {
    const { stacks, boardTickets } = get();
    const currentColumn: KanbanColumn = boardTickets.find(t => t.ticket_id === ticketId)?.column ?? 'backlog';

    // Idempotency: if ticket is already in refining, no teardown prompt needed.
    if (currentColumn === 'refining') {
      return { kind: 'silent', previousColumn: 'refining' };
    }

    const targets = stacks.filter(s => s.ticket === ticketId && s.project_dir === projectDir);
    if (targets.length > 1) {
      return {
        kind: 'error',
        message: `Multiple stacks found for ticket #${ticketId} in this project — cannot determine which to tear down`,
      };
    }
    if (targets.length === 1) {
      return { kind: 'confirm', stackId: targets[0].id, previousColumn: currentColumn };
    }
    return { kind: 'silent', previousColumn: currentColumn };
  },

  commitRefinementContext: (ticketId, projectDir, previousColumn) => {
    const existing = get()._refineDialogContext;
    // Don't clobber a context already set by openRefineDialogFromCard for
    // the same ticket — that path moves the ticket to 'refining' BEFORE
    // the dialog mounts, so when the dialog's prefill effect resolves the
    // ticket again it sees previousColumn='refining' and would otherwise
    // overwrite the real previous column captured at click time, breaking
    // revert-on-cancel (#393).
    if (!(existing && existing.ticketId === ticketId && existing.projectDir === projectDir)) {
      set({ _refineDialogContext: { ticketId, projectDir, previousColumn } });
    }
    void get().moveTicketColumn(ticketId, projectDir, 'refining');
  },

  openRefineDialogFromCard: (ticketId, projectDir, previousColumn) => {
    const key = `${ticketId}|${projectDir}`;
    // Guard: prevent duplicate gate start during async latency window
    if (get().refineInFlight[key]) return;

    const existingSession = get().refinementSessions.find(
      (s) => s.ticketId === ticketId && s.projectDir === projectDir
    );

    if (existingSession) {
      if (existingSession.status === 'running') {
        // An in-flight gate is already running — surface its dialog instead of starting a new one.
        get().openRefinementSession(existingSession.id);
        return;
      }
      // Stale session (ready, errored, interrupted) — discard it and start fresh.
      void window.sandstorm.tickets.cancelRefinement(existingSession.id).catch(() => {});
      get().removeRefinementSession(existingSession.id);
    }

    set((state) => {
      const { [key]: _, ...restErrors } = state.refineStartErrors;
      return {
        refineInFlight: { ...state.refineInFlight, [key]: true },
        refineStartErrors: restErrors,
        _refineDialogContext: { ticketId, projectDir, previousColumn },
      };
    });
    void get().moveTicketColumn(ticketId, projectDir, 'refining');

    window.sandstorm.tickets.specCheckAsync(ticketId, projectDir)
      .then(() => {
        set((state) => {
          const { [key]: _, ...rest } = state.refineInFlight;
          return { refineInFlight: rest };
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => {
          const { [key]: _, ...rest } = state.refineInFlight;
          return {
            refineInFlight: rest,
            refineStartErrors: { ...state.refineStartErrors, [key]: message },
          };
        });
      });
  },

  openCreatePRDialogForTicket: (stackId, ticketId, projectDir, previousColumn, initialError?: string) => {
    set({
      showCreatePRDialog: { stackId, initialError },
      _prDialogContext: { stackId, ticketId, projectDir, previousColumn, prCreated: false },
    });
  },

  startStackForTicket: async (ticketId: string, projectDir: string) => {
    const key = `${ticketId}|${projectDir}`;
    if (get().stackCreateInFlight[key]) return;

    const name = suggestStackName(ticketId);
    if (!name) return;

    set((state) => {
      const { [key]: _, ...restErrors } = state.stackCreateErrors;
      return {
        stackCreateInFlight: { ...state.stackCreateInFlight, [key]: true },
        stackCreateErrors: restErrors,
      };
    });

    // Optimistic column move — synchronous set inside fires immediately
    void get().moveTicketColumn(ticketId, projectDir, 'in_stack');

    try {
      const fetched = await window.sandstorm.tickets.fetch(ticketId, projectDir);
      await window.sandstorm.stacks.create({
        name,
        projectDir,
        ticket: ticketId,
        branch: `feat/${ticketId}-${name}`,
        description:
          fetched.body
            .split('\n')
            .find((l) => l.trim())
            ?.replace(/^#\s*/, '')
            .slice(0, 120) ?? null,
        runtime: 'docker',
        task: fetched.body,
        gateApproved: true,
      });
      await get().refreshStacks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({ stackCreateErrors: { ...state.stackCreateErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _, ...rest } = state.stackCreateInFlight;
        return { stackCreateInFlight: rest };
      });
    }
  },

  mergeTicket: async (ticketId: string, projectDir: string) => {
    const key = `${ticketId}|${projectDir}`;
    if (get().mergeInFlight[key]) return;

    set((state) => ({ mergeInFlight: { ...state.mergeInFlight, [key]: true } }));

    const stack = get().stacks.find(s => s.ticket === ticketId && s.project_dir === projectDir);
    // "Stack not found" from pr.merge or teardown means the backend record is already gone
    // (e.g. torn down externally, or a test-injected fake stack). Treat as non-fatal so the
    // column still advances to 'merged'. Real failures (branch protection, docker error, etc.)
    // surface via moveTicketColumnError.
    const isStackNotFound = (err: unknown) =>
      /Stack ".+" not found/.test(err instanceof Error ? err.message : String(err));

    try {
      if (stack?.pr_number != null) {
        let mergeResult: { status: 'merged' } | { status: 'conflict' } | { status: 'failed'; error: string };
        try {
          mergeResult = await window.sandstorm.pr.merge(stack.id, stack.pr_number);
        } catch (err) {
          if (!isStackNotFound(err)) throw err;
          mergeResult = { status: 'merged' };
        }

        if (mergeResult.status === 'conflict') {
          set((state) => ({
            mergeConflicts: { ...state.mergeConflicts, [key]: true },
            autoResolveErrors: { ...state.autoResolveErrors, [key]: 'Merge failed — conflicts must be resolved' },
          }));
          return;
        }
        if (mergeResult.status === 'failed') {
          set({ moveTicketColumnError: `Failed to merge ticket #${ticketId}: ${mergeResult.error}` });
          return;
        }
      }
      if (stack) {
        try {
          await window.sandstorm.stacks.teardown(stack.id);
        } catch (err) {
          if (!isStackNotFound(err)) throw err;
        }
      }
      await get().moveTicketColumn(ticketId, projectDir, 'merged');
      const closeResult = await window.sandstorm.tickets.markDone(ticketId, projectDir);
      if (!closeResult.ok) {
        set({ moveTicketColumnError: `Merged ticket #${ticketId} but failed to close it: ${closeResult.error}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ moveTicketColumnError: `Failed to merge ticket #${ticketId}: ${message}` });
    } finally {
      set((state) => {
        const { [key]: _, ...rest } = state.mergeInFlight;
        return { mergeInFlight: rest };
      });
    }
  },

  discardStack: async (ticketId: string, projectDir: string, disposition: 'backlog' | 'close') => {
    const key = `${ticketId}|${projectDir}`;
    if (get().discardInFlight[key]) return;
    set((state) => ({
      discardInFlight: { ...state.discardInFlight, [key]: true },
      discardErrors: (() => { const { [key]: _, ...rest } = state.discardErrors; return rest; })(),
    }));

    const stack = get().stacks.find(s => s.ticket === ticketId && s.project_dir === projectDir);

    try {
      // Best-effort teardown: swallow all errors, including missing stacks
      if (stack) {
        try {
          await window.sandstorm.stacks.teardown(stack.id);
        } catch {
          // intentional: teardown is best-effort and must not block disposition
        }
      }

      if (disposition === 'backlog') {
        await get().moveTicketColumn(ticketId, projectDir, 'backlog');
      } else {
        // Close/archive ticket — rejects on genuine failure (R2)
        await window.sandstorm.tickets.close(ticketId, projectDir);
        // On success or already-closed, delete the board row
        await window.sandstorm.ticketBoard.delete(ticketId, projectDir);
        set((state) => ({
          boardTickets: state.boardTickets.filter(
            t => !(t.ticket_id === ticketId && t.project_dir === projectDir)
          ),
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({ discardErrors: { ...state.discardErrors, [key]: `Failed to discard ticket #${ticketId}: ${message}` } }));
    } finally {
      set((state) => {
        const { [key]: _, ...rest } = state.discardInFlight;
        return { discardInFlight: rest };
      });
    }
  },

  createPRAutomatic: async (stackId, ticketId, projectDir, previousColumn) => {
    if (get().prCreateInFlight[stackId]) return;
    set((state) => ({
      prCreateInFlight: { ...state.prCreateInFlight, [stackId]: true },
      prCreateErrors: (() => { const { [stackId]: _, ...rest } = state.prCreateErrors; return rest; })(),
    }));
    try {
      const result = await window.sandstorm.pr.createAuto(stackId);
      if (result.status === 'created') {
        // Only advance to pr_open on confirmed success
        void get().moveTicketColumn(ticketId, projectDir, 'pr_open');
      } else if (result.status === 'draft_failed') {
        set((state) => ({ prCreateErrors: { ...state.prCreateErrors, [stackId]: 'PR draft failed. Please try again.' } }));
      } else if (result.status === 'create_failed') {
        get().setPrDraft(stackId, result.draft);
        const msg = result.error ?? 'PR creation failed. Please try again.';
        set((state) => ({ prCreateErrors: { ...state.prCreateErrors, [stackId]: msg } }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PR creation failed. Please try again.';
      set((state) => ({ prCreateErrors: { ...state.prCreateErrors, [stackId]: msg } }));
    } finally {
      set((state) => {
        const { [stackId]: _, ...rest } = state.prCreateInFlight;
        return { prCreateInFlight: rest };
      });
    }
  },

  autoResolveInFlight: {},
  autoResolveErrors: {},

  autoResolveConflicts: async (ticketId: string, projectDir: string) => {
    const key = `${ticketId}|${projectDir}`;
    if (get().autoResolveInFlight[key]) return;

    set((state) => ({
      autoResolveInFlight: { ...state.autoResolveInFlight, [key]: true },
      autoResolveErrors: (() => { const { [key]: _, ...rest } = state.autoResolveErrors; return rest; })(),
    }));

    try {
      const result = await window.sandstorm.pr.autoResolve(ticketId, projectDir);
      if (result.status === 'resolved') {
        set((state) => ({
          mergeConflicts: (() => { const { [key]: _, ...rest } = state.mergeConflicts; return rest; })(),
        }));
      } else if (result.status === 'no_conflicts') {
        set((state) => ({
          autoResolveErrors: { ...state.autoResolveErrors, [key]: 'No conflicts to resolve.' },
          mergeConflicts: (() => { const { [key]: _, ...rest } = state.mergeConflicts; return rest; })(),
        }));
      } else if (result.status === 'unknown_state') {
        set((state) => ({ autoResolveErrors: { ...state.autoResolveErrors, [key]: 'Mergeability unknown, try again.' } }));
      } else if (result.status === 'failed') {
        set((state) => ({ autoResolveErrors: { ...state.autoResolveErrors, [key]: result.error } }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({ autoResolveErrors: { ...state.autoResolveErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _, ...rest } = state.autoResolveInFlight;
        return { autoResolveInFlight: rest };
      });
    }
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
  setActiveProjectId: (id) => set({ activeProjectId: id, searchQuery: '' }),
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
  setShowRefineTicketDialog: (show) => {
    if (!show) {
      const ctx = get()._refineDialogContext;
      if (ctx) {
        const hasSession = get().refinementSessions.some(
          s => s.ticketId === ctx.ticketId && s.projectDir === ctx.projectDir
        );
        set({ _refineDialogContext: null });
        if (!hasSession) {
          void get().moveTicketColumn(ctx.ticketId, ctx.projectDir, ctx.previousColumn);
        }
      }
    }
    // Closing the dialog drops any pending prefill so a later cold-open
    // doesn't accidentally hydrate from a stale id.
    set({ showRefineTicketDialog: show, refineTicketPrefill: show ? get().refineTicketPrefill : null });
  },
  openRefineTicketDialogWith: (ticketId) => set({
    showRefineTicketDialog: true,
    refineTicketPrefill: ticketId,
    currentRefinementSessionId: null,
  }),
  consumeRefineTicketPrefill: () => {
    const value = get().refineTicketPrefill;
    if (value !== null) set({ refineTicketPrefill: null });
    return value;
  },
  openRefinementSession: (sessionId) => set({
    showRefineTicketDialog: true,
    currentRefinementSessionId: sessionId,
  }),
  upsertRefinementSession: (session, opts) => {
    let firedSpecReady = false;
    set((state) => {
      if ((session as { status?: string }).status === 'cancelled') {
        return { refinementSessions: state.refinementSessions.filter((s) => s.id !== session.id) };
      }
      // Clear streamingOutput when the session leaves the running state.
      const normalized = session.status !== 'running'
        ? { ...session, streamingOutput: undefined }
        : session;
      const idx = state.refinementSessions.findIndex((s) => s.id === session.id);

      // Detect the spec-gate-pass transition exactly once per session.
      // Idempotency contract (#388): when (status === 'ready' && result.passed) becomes true,
      // fire moveTicketColumn(ticketId, projectDir, 'spec_ready'). If the previous stored
      // session already satisfied the condition, this is a re-emit and we must not re-fire
      // (would otherwise demote a ticket the user has already advanced to in_stack).
      // During hydration replay (opts.replay === true), never fire the column move — the ticket
      // may already be in a later column (in_stack, pr_open, merged) and replaying a passed
      // session must not demote it back to spec_ready.
      const wasPassed = idx >= 0
        && state.refinementSessions[idx].status === 'ready'
        && state.refinementSessions[idx].result?.passed === true;
      const isPassed = normalized.status === 'ready' && normalized.result?.passed === true;
      firedSpecReady = isPassed && !wasPassed && !opts?.replay;

      if (idx >= 0) {
        const next = [...state.refinementSessions];
        next[idx] = normalized;
        return { refinementSessions: next };
      }
      return { refinementSessions: [...state.refinementSessions, normalized] };
    });

    if (firedSpecReady) {
      void get().moveTicketColumn(session.ticketId, session.projectDir, 'spec_ready');
    }
  },
  appendRefinementStreamChunk: (sessionId, delta) => set((state) => {
    const idx = state.refinementSessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) return {};
    const session = state.refinementSessions[idx];
    if (session.status !== 'running') return {};
    const next = [...state.refinementSessions];
    next[idx] = { ...session, streamingOutput: (session.streamingOutput ?? '') + delta };
    return { refinementSessions: next };
  }),
  removeRefinementSession: (sessionId) => set((state) => {
    const { [sessionId]: _, ...draftsNext } = state.refineAnswerDrafts;
    return {
      refinementSessions: state.refinementSessions.filter((s) => s.id !== sessionId),
      currentRefinementSessionId: state.currentRefinementSessionId === sessionId
        ? null
        : state.currentRefinementSessionId,
      refineAnswerDrafts: draftsNext,
    };
  }),
  setCurrentRefinementSessionId: (id) => set({ currentRefinementSessionId: id }),
  retryRefinementForTicket: async (ticketId, projectDir) => {
    const key = `${ticketId}|${projectDir}`;
    const session = get().refinementSessions.find(
      (s) => s.ticketId === ticketId && s.projectDir === projectDir,
    );
    // Remove old session from store — retryRefinementAsync cancels it in main.
    if (session) {
      get().removeRefinementSession(session.id);
    }
    // Clear any previous start error and mark in-flight during latency window
    set((state) => {
      const { [key]: _, ...restErrors } = state.refineStartErrors;
      return {
        refineStartErrors: restErrors,
        refineInFlight: { ...state.refineInFlight, [key]: true },
      };
    });
    try {
      await window.sandstorm.tickets.retryRefinementAsync(
        session?.id ?? '',
        ticketId,
        projectDir,
      );
      set((state) => {
        const { [key]: _, ...rest } = state.refineInFlight;
        return { refineInFlight: rest };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const { [key]: _, ...rest } = state.refineInFlight;
        return {
          refineInFlight: rest,
          refineStartErrors: { ...state.refineStartErrors, [key]: message },
        };
      });
    }
  },
  setShowCreateTicketDialog: (show) => set({ showCreateTicketDialog: show }),
  setShowEditTicketDialog: (show) => set({ showEditTicketDialog: show }),
  openEditTicketDialog: (ticketId, projectDir) => set({ showEditTicketDialog: true, editTicketTarget: { ticketId, projectDir } }),
  setShowStartTicketDialog: (show) => set({ showStartTicketDialog: show }),
  setShowCreatePRDialog: (state) => {
    if (!state) {
      const ctx = get()._prDialogContext;
      if (ctx) {
        set({ _prDialogContext: null });
        if (!ctx.prCreated) {
          // Only revert if the ticket was actually moved (e.g. by the optimistic update in
          // createPRAutomatic). When the dialog was opened without a prior column move the
          // current column equals previousColumn, so this is a no-op and setColumn is not called.
          const currentColumn = get().boardTickets.find(
            (t) => t.ticket_id === ctx.ticketId && t.project_dir === ctx.projectDir,
          )?.column;
          if (currentColumn !== ctx.previousColumn) {
            void get().moveTicketColumn(ctx.ticketId, ctx.projectDir, ctx.previousColumn);
          }
        }
      }
    }
    set({ showCreatePRDialog: state });
  },
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
  setRefineAnswerDraft: (sessionId, answers) =>
    set((state) => ({
      refineAnswerDrafts: { ...state.refineAnswerDrafts, [sessionId]: answers },
    })),
  clearRefineAnswerDraft: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...next } = state.refineAnswerDrafts;
      return { refineAnswerDrafts: next };
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  refreshStacks: async () => {
    try {
      const stacks = await window.sandstorm.stacks.list();
      const state = get();
      const updates: Partial<typeof state> = { stacks, error: null };

      // Mark PR dialog context as succeeded if the stack now has a pr_url
      const prCtx = state._prDialogContext;
      if (prCtx && !prCtx.prCreated) {
        const foundStack = stacks.find((s) => s.id === prCtx.stackId);
        if (foundStack?.pr_url) {
          updates._prDialogContext = { ...prCtx, prCreated: true };
        }
      }

      set(updates as Parameters<typeof set>[0]);
    } catch (err) {
      set({ error: `Failed to refresh stacks: ${err}` });
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

  // View navigation
  mainView: 'board',
  setMainView: (view) => set({ mainView: view }),

  // Global ticket search
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  // Telemetry slice
  telemetryRange: '30d',
  telemetrySummary: null,
  telemetryDaily: [],
  telemetryByModel: [],
  telemetryByTicket: [],
  telemetryLoading: false,
  telemetryError: null,

  setTelemetryRange: (range) => {
    set({ telemetryRange: range });
    void get().fetchTelemetry();
  },

  fetchTelemetry: async () => {
    const seq = ++_telemetryFetchSeq;
    const range = getDateRange(get().telemetryRange);
    set({ telemetryLoading: true, telemetryError: null });
    try {
      const [summary, daily, byModel, byTicket] = await Promise.all([
        window.sandstorm.telemetry.summary(range),
        window.sandstorm.telemetry.daily(range),
        window.sandstorm.telemetry.byModel(range),
        window.sandstorm.telemetry.byTicket(range),
      ]);
      if (seq !== _telemetryFetchSeq) return;
      set({
        telemetrySummary: summary,
        telemetryDaily: daily,
        telemetryByModel: byModel,
        telemetryByTicket: byTicket,
        telemetryLoading: false,
      });
    } catch (err) {
      if (seq !== _telemetryFetchSeq) return;
      set({
        telemetryLoading: false,
        telemetryError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshTelemetry: async () => {
    await window.sandstorm.telemetry.refresh();
    await get().fetchTelemetry();
  },

  // Derived
  filteredStacks: () => {
    const { stacks, activeProjectId, projects } = get();
    if (activeProjectId === null) return stacks;
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return stacks;
    return stacks.filter((s) => s.project_dir === project.directory);
  },

  activeProject: () => {
    const { activeProjectId, projects } = get();
    if (activeProjectId === null) return undefined;
    return projects.find((p) => p.id === activeProjectId);
  },
}));
