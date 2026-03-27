import { create } from 'zustand';

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
  rate_limit_reset_at: string | null;
  created_at: string;
  updated_at: string;
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
  review_iterations: number;
  verify_retries: number;
  started_at: string;
  finished_at: string | null;
}

export interface TokenUsageStats {
  stackId: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface GlobalTokenUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  per_stack: TokenUsageStats[];
}

export interface RateLimitState {
  active: boolean;
  reset_at: string | null;
  affected_stacks: string[];
  reason: string | null;
}

export interface AccountUsage {
  used_tokens: number;
  limit_tokens: number;
  percent: number;
  reset_at: string | null;
  reset_in: string | null;
  subscription_type: string | null;
  rate_limit_tier: string | null;
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
  created_at: string;
  finished_at: string;
  duration_seconds: number;
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
  accountUsage: AccountUsage | null;

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
        checkInit: (directory: string) => Promise<boolean>;
        initialize: (directory: string) => Promise<{ success: boolean; error?: string }>;
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
      };
      tasks: {
        dispatch: (stackId: string, prompt: string, model?: string) => Promise<Task>;
        list: (stackId: string) => Promise<Task[]>;
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
        accountUsage: () => Promise<AccountUsage | null>;
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
      const activeStatuses = new Set(['running', 'up', 'building', 'idle', 'completed', 'pushed', 'pr_created']);
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

      // Also refresh token usage, rate limit state, and account usage in parallel
      await Promise.all([
        get().refreshTokenUsage(),
        get().refreshRateLimitState(),
        get().refreshAccountUsage(),
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
