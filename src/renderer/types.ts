export interface WorkspaceStatusSummary {
  clean: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
  changeCount: number;
  summary: string;
  sampleChanges: string[];
}

export interface WorkspaceCommitSummary {
  shortSha: string;
  author: string;
  relativeTime: string;
  subject: string;
}

export interface WorkspaceSummary {
  id: string;
  branch?: string;
  path: string;
  relativePath: string;
  headSha: string;
  status: WorkspaceStatusSummary;
  lastCommit?: WorkspaceCommitSummary;
  updatedAt?: number;
  kind: "worktree" | "folder";
}

export interface QuickAccessEntry {
  key: string;
  label: string;
  quickCommand: string;
}

export interface ProjectState {
  projectPath: string;
  projectName: string;
  quickAccess: QuickAccessEntry[];
}

export interface EnsureTerminalResponse {
  sessionId: string;
  workspacePath: string;
  slot: string;
  command: string;
  args?: string[];
  existing: boolean;
  history: string;
  quickCommandExecuted: boolean;
  lastExitCode: number | null;
  lastSignal: string | null;
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface WorkspaceStateResponse {
  activeTerminal: string | null;
  terminals: Record<
    string,
    {
      history: string;
      quickCommandExecuted: boolean;
      lastExitCode: number | null;
      lastSignal: string | null;
      label: string | null;
    }
  >;
}
