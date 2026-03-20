import { create } from 'zustand';

export interface Stack {
  id: string;
  project: string;
  project_dir: string;
  ticket: string | null;
  branch: string | null;
  description: string | null;
  status: string;
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

interface AppState {
  stacks: Stack[];
  selectedStackId: string | null;
  showNewStackDialog: boolean;
  loading: boolean;
  error: string | null;

  // Actions
  setStacks: (stacks: Stack[]) => void;
  selectStack: (id: string | null) => void;
  setShowNewStackDialog: (show: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  refreshStacks: () => Promise<void>;
}

declare global {
  interface Window {
    sandstorm: {
      stacks: {
        list: () => Promise<Stack[]>;
        get: (id: string) => Promise<Stack>;
        create: (opts: unknown) => Promise<Stack>;
        teardown: (id: string) => Promise<void>;
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
      runtime: {
        available: () => Promise<{ docker: boolean; podman: boolean }>;
      };
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
    };
  }
}

export const useAppStore = create<AppState>((set) => ({
  stacks: [],
  selectedStackId: null,
  showNewStackDialog: false,
  loading: false,
  error: null,

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
}));
