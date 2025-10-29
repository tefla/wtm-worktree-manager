const { test, expect } = require("@playwright/test");
const { setupProjectWorkspace, launchAppWithProject, closeElectronApp } = require("./utils");

test("terminal session survives app restart", async () => {
  const project = await setupProjectWorkspace();
  let electronApp1;

  try {
    const firstLaunch = await launchAppWithProject(project);
    electronApp1 = firstLaunch.electronApp;
    const window1 = firstLaunch.window;
    console.log("[e2e] first app launched");

    const workspace = (firstLaunch.workspaces || []).find((entry) => entry.kind === "worktree")
      ?? firstLaunch.workspaces?.[0];

    if (!workspace) {
      throw new Error("Workspace list was empty");
    }
    console.log("[e2e] using workspace", workspace.path);

    await window1.waitForFunction(() => typeof window.terminalAPI?.ensureSession === "function", { timeout: 10000 });

    let firstSession = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await window1.evaluate(async ({ workspacePath }) => {
        const ensure = window.terminalAPI.ensureSession({
          workspacePath,
          slot: "persist-e2e",
          label: "Persist E2E",
          command: "/bin/sh",
          args: ["-i"],
        });
        const outcome = await Promise.race([
          ensure.then((value) => ({ ok: true, value })).catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout" }), 15000)),
        ]);
        return outcome;
      }, { workspacePath: workspace.path });
      if (result.ok) {
        firstSession = result.value;
        break;
      }
      await window1.waitForTimeout(500);
    }
    if (!firstSession) {
      throw new Error("Failed to establish terminal session on initial launch");
    }

    expect(firstSession.existing).toBeFalsy();
    console.log("[e2e] first session created", firstSession.sessionId);

    const marker = `PERSIST-${Date.now()}`;

    await window1.evaluate(async ({ sessionId, markerValue }) => {
      await new Promise((resolve) => {
        const dispose = window.terminalAPI.onData((payload) => {
          if (payload.sessionId === sessionId && payload.data.includes(markerValue)) {
            dispose();
            resolve();
          }
        });
        window.terminalAPI.write(sessionId, `echo ${markerValue}\n`);
      });
    }, { sessionId: firstSession.sessionId, markerValue: marker });
    console.log("[e2e] marker observed");

    await window1.waitForTimeout(500);

    await window1.evaluate(({ sessionId }) => window.terminalAPI.release(sessionId), {
      sessionId: firstSession.sessionId,
    });
    console.log("[e2e] first session released");

    await window1.waitForTimeout(200);

    await window1.reload();
    await window1.waitForFunction(() => typeof window.terminalAPI?.ensureSession === "function", { timeout: 10000 });

    let secondSession = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await window1.evaluate(async ({ workspacePath }) => {
        const ensure = window.terminalAPI.ensureSession({
          workspacePath,
          slot: "persist-e2e",
          label: "Persist E2E",
          command: "/bin/sh",
          args: ["-i"],
        });
        const outcome = await Promise.race([
          ensure.then((value) => ({ ok: true, value })).catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout" }), 15000)),
        ]);
        return outcome;
      }, { workspacePath: workspace.path });
      if (result.ok) {
        secondSession = result.value;
        break;
      }
      await window1.waitForTimeout(500);
    }
    if (!secondSession) {
      throw new Error("Failed to reconnect terminal session after reload");
    }
    console.log("[e2e] second session obtained", secondSession.sessionId, "existing=", secondSession.existing);

    expect(secondSession.existing).toBeTruthy();
    expect(secondSession.history).toContain(marker);

    await window1.evaluate(({ sessionId }) => window.terminalAPI.dispose(sessionId), {
      sessionId: secondSession.sessionId,
    });
    console.log("[e2e] second session disposed");

    await window1.waitForTimeout(200);
  } finally {
    await closeElectronApp(electronApp1);
    await project.cleanup();
  }
});
