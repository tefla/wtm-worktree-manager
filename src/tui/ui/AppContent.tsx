import React from "react";
import { useApp } from "../providers/AppProvider";
import { displayWorkspaceName } from "../lib/strings";
import { TerminalDisplay } from "./TerminalDisplay";

type InkModule = typeof import("ink");

interface AppContentProps {
  ink: InkModule;
  isRawModeSupported: boolean;
  projectPath: string;
  screenWidth?: number;
  screenHeight?: number;
}

export const AppContent: React.FC<AppContentProps> = ({
  ink,
  isRawModeSupported,
  projectPath,
  screenWidth,
  screenHeight,
}) => {
  const { Box, Text, useInput, useApp: useInkApp, Spacer } = ink;
  const { exit } = useInkApp();
  const { state, actions, currentWorkspace, currentTabs, selectedTabId } = useApp();

  // Show help panel if raw mode is not supported
  React.useEffect(() => {
    if (!isRawModeSupported && !state.showHelp) {
      actions.toggleHelp();
    }
  }, [isRawModeSupported, state.showHelp, actions]);

  useInput(
    (input, key) => {
      // Handle terminal focus mode - forward all input to terminal
      if (state.terminalFocused) {
        if (key.escape) {
          actions.toggleTerminalFocus();
          return;
        }
        // Forward key to terminal
        if (key.return) {
          void actions.sendKeysToTerminal("Enter");
        } else if (key.backspace || key.delete) {
          void actions.sendKeysToTerminal("BSpace");
        } else if (key.upArrow) {
          void actions.sendKeysToTerminal("Up");
        } else if (key.downArrow) {
          void actions.sendKeysToTerminal("Down");
        } else if (key.leftArrow) {
          void actions.sendKeysToTerminal("Left");
        } else if (key.rightArrow) {
          void actions.sendKeysToTerminal("Right");
        } else if (key.tab) {
          void actions.sendKeysToTerminal("Tab");
        } else if (key.ctrl && input === "c") {
          void actions.sendKeysToTerminal("C-c");
        } else if (key.ctrl && input === "d") {
          void actions.sendKeysToTerminal("C-d");
        } else if (input) {
          void actions.sendKeysToTerminal(input);
        }
        return;
      }

      if (state.mode === "creating-workspace") {
        if (key.return) {
          void actions.submitCreateWorkspace();
          return;
        }
        if (key.escape) {
          actions.cancelCreateWorkspace();
          return;
        }
        if (key.backspace || key.delete) {
          actions.setInputBuffer((prev) => prev.slice(0, -1));
          return;
        }
        if (input && /^[a-zA-Z0-9._\/-]$/.test(input)) {
          actions.setInputBuffer((prev) => prev + input);
        }
        return;
      }

      if (state.mode === "busy" || state.mode === "loading") {
        return;
      }

      if (key.escape || input === "q") {
        exit();
        return;
      }

      if (input === "?") {
        actions.toggleHelp();
        return;
      }

      if (key.upArrow) {
        actions.moveWorkspaceSelection(-1);
        return;
      }
      if (key.downArrow) {
        actions.moveWorkspaceSelection(1);
        return;
      }
      if (key.leftArrow) {
        actions.cycleTab(-1);
        return;
      }
      if (key.rightArrow) {
        actions.cycleTab(1);
        return;
      }
      if (key.return) {
        actions.toggleTerminalFocus();
        return;
      }

      if (input === "n") {
        actions.startCreateWorkspace();
        return;
      }
      if (input === "t") {
        void actions.handleCreateTab();
        return;
      }
      if (input === "r") {
        void actions.refreshWorkspaces(state.selectedWorkspaceId ?? undefined);
      }
    },
    {
      isActive: true,
    },
  );

  const renderWorkspaceList = () => (
    <Box flexDirection="column" minWidth={28} paddingRight={2} borderStyle="round" borderColor="gray">
      <Text color="cyan">Workspaces</Text>
      {state.workspaces.length === 0 ? (
        <Text dimColor>{"No workspaces. Press 'n' to create one."}</Text>
      ) : (
        state.workspaces.map((workspace) => {
          const isSelected = workspace.id === state.selectedWorkspaceId;
          const prefix = isSelected ? "➤" : " ";
          return (
            <Text key={workspace.id} color={isSelected ? "green" : undefined}>
              {`${prefix} ${displayWorkspaceName(workspace)}`}
            </Text>
          );
        })
      )}
    </Box>
  );

  const renderTabs = () => {
    if (!currentWorkspace) {
      return <Text dimColor>No workspace selected.</Text>;
    }
    const tabs = currentTabs.length > 0 ? currentTabs : [{ id: "main", label: "main", windowName: "", active: true }];
    return (
      <Box gap={1} flexWrap="wrap">
        {tabs.map((tab) => {
          const isActive = tab.id === selectedTabId;
          const label = isActive ? `[${tab.label}]` : tab.label;
          return (
            <Text key={tab.windowName || tab.id} color={isActive ? "green" : undefined}>
              {label}
            </Text>
          );
        })}
      </Box>
    );
  };

  const renderStatus = () => {
    if (state.error) {
      return <Text color="red">{state.error}</Text>;
    }
    if (state.mode === "loading") {
      return <Text dimColor>{state.status || "Loading project data…"}</Text>;
    }
    if (state.mode === "creating-workspace") {
      return <Text>{`New workspace: ${state.inputBuffer}_`}</Text>;
    }
    if (state.status) {
      return <Text>{state.status}</Text>;
    }
    return null;
  };

  const renderHelp = () => (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" padding={1} gap={0}>
      <Text color="cyan">Shortcuts</Text>
      <Text>↑ / ↓ — Select workspace</Text>
      <Text>← / → — Switch terminal tab</Text>
      <Text>Enter — Focus/unfocus terminal</Text>
      <Text>Esc — Unfocus terminal (when focused)</Text>
      <Text>n — Create workspace</Text>
      <Text>t — Create new tab</Text>
      <Text>r — Refresh workspaces</Text>
      <Text>q / Ctrl+C — Exit</Text>
      <Text dimColor>Press ? to hide this panel.</Text>
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      gap={1}
      flexGrow={1}
      width={screenWidth}
      height={screenHeight}
    >
      <Text color="cyan">WTM Hybrid TUI (preview)</Text>
      <Text dimColor>{projectPath}</Text>
      <Box flexDirection="row" flexGrow={1} gap={2}>
        {renderWorkspaceList()}
        <Box flexGrow={1} flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" borderColor="gray" padding={1}>
            <Text color="cyan">Terminal Tabs</Text>
            {renderTabs()}
          </Box>
          <TerminalDisplay
            ink={ink}
            lines={state.terminalOutput}
            focused={state.terminalFocused}
            height={screenHeight ? screenHeight - 12 : 20}
          />
          {renderStatus()}
          <Box flexDirection="column" gap={0}>
            <Text dimColor>
              {"Keys: ↑↓ workspace • ←→ tab • Enter focus • n new ws • t new tab • q exit • ? help"}
            </Text>
            {state.terminalFocused && (
              <Text color="green">{"Terminal focused. Press Esc to unfocus."}</Text>
            )}
            {!isRawModeSupported && <Text dimColor>{"Raw mode unavailable; some shortcuts may not work."}</Text>}
          </Box>
        </Box>
      </Box>
      {state.showHelp ? renderHelp() : null}
    </Box>
  );
};
