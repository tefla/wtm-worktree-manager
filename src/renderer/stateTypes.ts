import type { WorkspaceSummary } from "./types";

export interface TerminalDefinition {
  key: string;
  label: string;
  quickCommand: string | null;
  isEphemeral: boolean;
}

export interface SavedTerminalState {
  history?: string;
  quickCommandExecuted?: boolean;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  label?: string | null;
}

export interface SavedWorkspaceState {
  workspacePath: string;
  activeTerminal: string | null;
  terminals: Record<string, SavedTerminalState>;
}

export interface TerminalRecord {
  key: string;
  label: string;
  quickCommand: string | null;
  isEphemeral: boolean;
  sessionId: string | null;
  quickCommandExecuted: boolean;
  lastExitCode: number | null;
  lastSignal: string | null;
  savedHistory: string;
  ignoreSavedHistory: boolean;
  closed: boolean;
  shouldStart: boolean;
}

export interface WorkspaceTabState {
  workspace: WorkspaceSummary;
  terminalOrder: string[];
  terminals: Map<string, TerminalRecord>;
  activeTerminalKey: string | null;
  savedState: SavedWorkspaceState;
  ephemeralCounter: number;
}

export interface QuickAccessDraft {
  id: string;
  initialKey: string | null;
  label: string;
  quickCommand: string;
}
