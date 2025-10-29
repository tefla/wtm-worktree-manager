const { test, expect } = require("@playwright/test");
const { setupProjectWorkspace, launchAppWithProject, closeElectronApp } = require("./utils");

test("lists git worktrees and unmanaged folders", async () => {
  const project = await setupProjectWorkspace();
  let electronApp;
  try {
    const launched = await launchAppWithProject(project);
    electronApp = launched.electronApp;
    const { window } = launched;

    await expect(window.locator(".workspace-row")).toHaveCount(2, { timeout: 10000 });

    const worktreeRow = window.locator(`.workspace-row[data-path="${project.worktreePath}"]`);
    await expect(worktreeRow).toHaveCount(1, { timeout: 5000 });
    await expect(worktreeRow.locator('button[aria-label="Delete workspace"]')).toHaveCount(1);

    const folderRow = window.locator(`.workspace-row[data-path="${project.orphanFolder}"]`);
    await expect(folderRow).toHaveCount(1, { timeout: 5000 });
    await expect(folderRow.locator("button")).toHaveCount(0);
    await expect(folderRow.locator(".status-icon.folder")).toHaveCount(1);
  } finally {
    await closeElectronApp(electronApp);
    await project.cleanup();
  }
});
