export type TerminalHostMessage =
  | TerminalHostRequestMessage
  | TerminalHostResponseMessage
  | TerminalHostEventMessage;

export interface TerminalHostBaseMessage {
  type: "request" | "response" | "event";
}

export interface TerminalHostRequestMessage extends TerminalHostBaseMessage {
  type: "request";
  id: string;
  command: TerminalHostCommand;
  payload?: unknown;
}

export interface TerminalHostResponseMessage extends TerminalHostBaseMessage {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export interface TerminalHostEventMessage extends TerminalHostBaseMessage {
  type: "event";
  event: TerminalHostEvent;
  payload?: unknown;
}

export type TerminalHostCommand =
  | "ping"
  | "configure"
  | "ensureSession"
  | "releaseSession"
  | "writeSession"
  | "resizeSession"
  | "disposeSession"
  | "listSessions"
  | "getWorkspaceState";

export type TerminalHostEvent =
  | "session-data"
  | "session-exit"
  | "session-disposed"
  | "log"
  | "error";

export interface HostEnsureSessionPayload {
  workspacePath: string;
  slot: string;
  command: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  label?: string;
}

export interface HostEnsureSessionResult {
  sessionId: string;
  workspacePath: string;
  slot: string;
  command: string;
  args?: string[];
  existing: boolean;
  pendingOutput: string;
}

export interface HostWritePayload {
  sessionId: string;
  data: string;
}

export interface HostResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface HostDisposePayload {
  sessionId: string;
  reason?: string;
}

export interface HostReleasePayload {
  sessionId: string;
}

export interface HostDataEventPayload {
  sessionId: string;
  data: string;
}

export interface HostExitEventPayload {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface HostDisposedEventPayload {
  sessionId: string;
  reason?: string;
}

export interface HostConfigurePayload {
  storePath: string;
}

export interface HostListSessionsResult {
  sessions: Array<{
    sessionId: string;
    workspacePath: string;
    slot: string;
    command: string;
    args?: string[];
    hasSubscribers: boolean;
  }>;
}

export interface HostGetWorkspaceStatePayload {
  workspacePath: string;
}
