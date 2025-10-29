import type { EnsureTerminalResponse, ProjectState, TerminalDataPayload, TerminalExitPayload, WorkspaceStateResponse, WorkspaceSummary } from "./types";

declare global {
  interface Window {
    workspaceAPI: {
      list: () => Promise<WorkspaceSummary[]>;
      create: (params: { branch: string; baseRef?: string }) => Promise<WorkspaceSummary>;
      delete: (params: { path: string; force?: boolean }) => Promise<{ success: boolean; reason?: string; message?: string; path?: string }>;
      refresh: (params: { path: string }) => Promise<WorkspaceSummary>;
      update: (params: { path: string }) => Promise<WorkspaceSummary>;
    };
    projectAPI: {
      getCurrent: () => Promise<ProjectState | null>;
      openPath: (params: { path: string; openInNewWindow?: boolean }) => Promise<ProjectState | null>;
      openDialog: (params?: { openInNewWindow?: boolean }) => Promise<ProjectState | null>;
    };
    terminalAPI: {
      ensureSession: (params: { workspacePath: string; slot: string; command?: string; args?: string[]; cols?: number; rows?: number; env?: Record<string, string>; label?: string }) => Promise<EnsureTerminalResponse>;
      write: (sessionId: string, data: string) => void;
      resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
      dispose: (sessionId: string, options?: Record<string, unknown>) => Promise<void>;
      release: (sessionId: string) => Promise<void>;
      listForWorkspace: (workspacePath: string) => Promise<Record<string, { history: string }>>;
      getWorkspaceState: (workspacePath: string) => Promise<WorkspaceStateResponse>;
      listSavedWorkspaces: () => Promise<string[]>;
      markQuickCommand: (workspacePath: string, slot: string) => Promise<void>;
      setActiveTerminal: (workspacePath: string, slot: string | null) => Promise<void>;
      clearWorkspaceState: (workspacePath: string) => Promise<void>;
      onData: (callback: (payload: TerminalDataPayload) => void) => () => void;
      onExit: (callback: (payload: TerminalExitPayload) => void) => () => void;
    };
  }
}

export {};
