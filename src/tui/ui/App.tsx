import React from "react";
import type { ProjectStructure } from "../services/projectStructure";
import type { WorkspaceManager } from "../../core/workspaceManager";
import { AppProvider } from "../providers/AppProvider";
import { AppContent } from "./AppContent";

type InkModule = typeof import("ink");

export interface AppProps {
  projectPath: string;
  structure: ProjectStructure;
  workspaceManager: WorkspaceManager;
  ink: InkModule;
}

export const App: React.FC<AppProps> = ({ projectPath, structure, workspaceManager, ink }) => {
  const { useStdin, useStdout } = ink;
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const screenWidth = stdout?.columns ?? undefined;
  const screenHeight = stdout?.rows ?? undefined;

  return (
    <AppProvider workspaceManager={workspaceManager}>
      <AppContent
        ink={ink}
        isRawModeSupported={isRawModeSupported}
        projectPath={structure.projectPath}
        screenWidth={screenWidth}
        screenHeight={screenHeight}
      />
    </AppProvider>
  );
};
