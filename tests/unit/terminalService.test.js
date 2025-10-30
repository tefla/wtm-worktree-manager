const test = require("node:test");
const assert = require("node:assert/strict");

const { TerminalService } = require("../../dist/main/services/terminalService.js");

test("TerminalService apply ensure session transforms", async () => {
  const manager = {
    ensureSession: async () => ({
      sessionId: "abc",
      workspacePath: "/tmp/workspace",
      slot: "default",
      command: "zsh",
      args: [],
      existing: false,
      history: "",
      quickCommandExecuted: false,
      lastExitCode: null,
      lastSignal: null,
    }),
    write: async () => {},
    resize: async () => {},
    dispose: async () => {},
    release: async () => {},
    listSessionsForWorkspace: async () => ({}),
    getWorkspaceState: async () => ({ activeTerminal: null, terminals: {} }),
    listSavedWorkspaces: async () => [],
    markQuickCommandExecuted: async () => {},
    setActiveTerminal: async () => {},
    clearWorkspaceState: async () => {},
  };

  const service = new TerminalService(manager);
  service.registerEnsureTransform((result) => ({
    ...result,
    command: `${result.command} --login`,
  }));

  const ensureResult = await service.ensureSession({ workspacePath: "/tmp/workspace", slot: "default" }, 1);
  assert.equal(ensureResult.command, "zsh --login");
});
