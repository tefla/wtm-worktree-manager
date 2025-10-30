import type { ReactNode } from "react";
import type { WorkspaceSummary } from "../types";
import type { WorkspaceTabState, TerminalRecord } from "../stateTypes";
import type { DockerComposeServiceInfo } from "../../shared/dockerCompose";
import type { RecentProject } from "../store/types";

export type WidgetSlot = "sidebar" | "main" | "aux";

export interface WorkspaceRowActionContext {
  workspace: WorkspaceSummary;
  isUpdating: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onUpdate: () => void;
}

export interface WorkspaceRowActionDefinition {
  id: string;
  order?: number;
  render: (context: WorkspaceRowActionContext) => ReactNode;
}

export interface WidgetRenderContext {
  workspace: {
    list: WorkspaceSummary[];
    order: string[];
    activePath: string | null;
    updating: Record<string, boolean>;
    loading: boolean;
    tabs: Map<string, WorkspaceTabState>;
  };
  compose: {
    hasActiveProject: boolean;
    projectName: string | null;
    services: DockerComposeServiceInfo[];
    loading: boolean;
    error: string | null;
    refresh: () => void;
  };
  project: {
    activePath: string | null;
    activeName: string;
    recentProjects: RecentProject[];
  };
  workspaceRowActions: WorkspaceRowActionDefinition[];
  callbacks: {
    selectWorkspace: (workspace: WorkspaceSummary) => void;
    refreshWorkspace: (workspace: WorkspaceSummary) => void;
    deleteWorkspace: (workspace: WorkspaceSummary) => void;
    updateWorkspace: (workspace: WorkspaceSummary) => void;
    selectWorkspaceTab: (workspacePath: string) => void;
    addTerminal: (workspacePath: string) => void;
    onTerminalTabClick: (workspacePath: string, terminalKey: string) => void;
    onTerminalClose: (workspacePath: string, terminalKey: string) => void;
    onTerminalStart: (workspacePath: string, record: TerminalRecord, container: HTMLDivElement) => void;
    onTerminalDispose: (workspacePath: string, record: TerminalRecord) => void;
  };
}

export interface WidgetDefinition {
  id: string;
  slot: WidgetSlot;
  order?: number;
  render: (context: WidgetRenderContext) => ReactNode;
}
