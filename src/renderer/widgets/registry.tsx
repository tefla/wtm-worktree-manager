import React, { createContext, useContext, useMemo } from "react";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { WorkspaceTabsPanel } from "../components/WorkspaceTabsPanel";
import { ComposeServicesPanel } from "../components/ComposeServicesPanel";
import type { WidgetDefinition, WidgetRenderContext, WidgetSlot, WorkspaceRowActionDefinition } from "./types";
export type { WidgetDefinition, WidgetRenderContext, WidgetSlot, WorkspaceRowActionDefinition, WorkspaceRowActionContext } from "./types";

interface WidgetRegistryValue {
  widgets: WidgetDefinition[];
  rowActions: WorkspaceRowActionDefinition[];
}

interface WidgetRegistryProviderProps {
  widgets?: WidgetDefinition[];
  rowActions?: WorkspaceRowActionDefinition[];
  children: React.ReactNode;
}

const defaultRowActions: WorkspaceRowActionDefinition[] = [];

const defaultWidgets: WidgetDefinition[] = [
  {
    id: "wtm.sidebar.workspaces",
    slot: "sidebar",
    order: 0,
    render: (context) => {
      const { workspace, workspaceRowActions, callbacks } = context;
      return (
        <WorkspaceSidebar
          loading={workspace.loading}
          workspaces={workspace.list}
          activeWorkspacePath={workspace.activePath}
          onSelect={callbacks.selectWorkspace}
          onRefreshWorkspace={callbacks.refreshWorkspace}
          onDeleteWorkspace={callbacks.deleteWorkspace}
          onUpdateWorkspace={callbacks.updateWorkspace}
          updatingPaths={workspace.updating}
          rowActions={workspaceRowActions}
        />
      );
    },
  },
  {
    id: "wtm.main.workspace-tabs",
    slot: "main",
    order: 0,
    render: (context) => {
      const { workspace, callbacks } = context;
      return (
        <WorkspaceTabsPanel
          workspaceOrder={workspace.order}
          workspaceTabs={workspace.tabs}
          activeWorkspacePath={workspace.activePath}
          onSelectWorkspace={callbacks.selectWorkspaceTab}
          onRefreshWorkspace={callbacks.refreshWorkspace}
          onDeleteWorkspace={callbacks.deleteWorkspace}
          onAddTerminal={callbacks.addTerminal}
          onTerminalTabClick={callbacks.onTerminalTabClick}
          onTerminalClose={callbacks.onTerminalClose}
          onTerminalStart={callbacks.onTerminalStart}
          onTerminalDispose={callbacks.onTerminalDispose}
        />
      );
    },
  },
  {
    id: "wtm.aux.compose-services",
    slot: "aux",
    order: 0,
    render: (context) => {
      const { compose } = context;
      return (
        <ComposeServicesPanel
          hasActiveProject={compose.hasActiveProject}
          projectName={compose.projectName}
          services={compose.services}
          loading={compose.loading}
          error={compose.error}
          onRefresh={compose.refresh}
        />
      );
    },
  },
];

export function mergeWidgetDefinitions<T extends { id: string; order?: number }>(defaults: T[], extras: T[] = []): T[] {
  const map = new Map<string, T>();
  defaults.forEach((item) => {
    map.set(item.id, item);
  });
  extras.forEach((item) => {
    map.set(item.id, item);
  });
  return Array.from(map.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

const WidgetRegistryContext = createContext<WidgetRegistryValue>({
  widgets: defaultWidgets,
  rowActions: defaultRowActions,
});

export const WidgetRegistryProvider: React.FC<WidgetRegistryProviderProps> = ({ widgets, rowActions, children }) => {
  const value = useMemo<WidgetRegistryValue>(
    () => ({
      widgets: mergeWidgetDefinitions(defaultWidgets, widgets ?? []),
      rowActions: mergeWidgetDefinitions(defaultRowActions, rowActions ?? []),
    }),
    [widgets, rowActions],
  );

  return <WidgetRegistryContext.Provider value={value}>{children}</WidgetRegistryContext.Provider>;
};

export function useWidgets(slot: WidgetSlot): WidgetDefinition[] {
  const { widgets } = useContext(WidgetRegistryContext);
  return useMemo(() => widgets.filter((widget) => widget.slot === slot), [widgets, slot]);
}

export function useWorkspaceRowActions(): WorkspaceRowActionDefinition[] {
  const { rowActions } = useContext(WidgetRegistryContext);
  return rowActions;
}
