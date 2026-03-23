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
  runtime: 'docker' | 'podman';
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
  status: string;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
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

  // Stacks
  stacks: Stack[];
  stackHistory: StackHistoryRecord[];
  selectedStackId: string | null;
  showNewStackDialog: boolean;
  stackMetrics: Record<string, StackMetrics>;
  loading: boolean;
  error: string | null;

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
      };
      tasks: {
        dispatch: (stackId: string, prompt: string) => Promise<Task>;
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
      };
      runtime: {
        available: () => Promise<{ docker: boolean; podman: boolean }>;
      };
      claude: {
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
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
    };
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  // Projects
  projects: [],
  activeProjectId: null,
  showOpenProjectDialog: false,

  // Stacks
  stacks: [],
  stackHistory: [],
  stackMetrics: {},
  selectedStackId: null,
  showNewStackDialog: false,
  loading: false,
  error: null,

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
      const { stacks } = get();
      const activeStatuses = new Set(['running', 'up', 'building', 'idle', 'completed']);
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
    } catch {
      // Metrics refresh failure is non-fatal
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
