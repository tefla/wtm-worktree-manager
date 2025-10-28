const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const util = require("node:util");

const execFileAsync = util.promisify(execFile);

async function runGit(args, options) {
  await execFileAsync("git", args, options);
}

async function setupGitWorkspace() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-repo-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-workspaces-"));

  await runGit(["init"], { cwd: repoDir });
  await runGit(["checkout", "-b", "main"], { cwd: repoDir });
  await runGit(["config", "user.name", "Test User"], { cwd: repoDir });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoDir });

  await fs.writeFile(path.join(repoDir, "README.md"), "# test repo\n");
  await runGit(["add", "README.md"], { cwd: repoDir });
  await runGit(["commit", "-m", "initial"], { cwd: repoDir });

  await runGit(["branch", "feature/test"], { cwd: repoDir });

  const worktreePath = path.join(workspaceRoot, "feature-test");
  await runGit(["worktree", "add", worktreePath, "feature/test"], { cwd: repoDir });

  await fs.mkdir(path.join(workspaceRoot, "orphan-folder"));

  const settingsPath = path.join(os.tmpdir(), `wtm-settings-${Date.now()}.json`);
  const terminalsPath = path.join(os.tmpdir(), `wtm-terminals-${Date.now()}.json`);
  await fs.writeFile(
    settingsPath,
    JSON.stringify(
      {
        environments: {
          test: {
            repoDir,
            workspaceRoot,
          },
        },
        activeEnvironment: "test",
      },
      null,
      2,
    ),
  );

  return {
    repoDir,
    workspaceRoot,
    settingsPath,
    terminalsPath,
    async cleanup() {
      await fs.rm(settingsPath, { force: true });
      await fs.rm(terminalsPath, { force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await runGit(["worktree", "prune"], { cwd: repoDir }).catch(() => {});
      await fs.rm(repoDir, { recursive: true, force: true });
    },
  };
}

test("lists git worktrees and unmanaged folders", async () => {
  const setup = await setupGitWorkspace();
  const projectRoot = path.resolve(__dirname, "../../");

  const electronApp = await electron.launch({
    args: [".", "--disable-gpu", "--disable-software-rasterizer"],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      ELECTRON_DISABLE_GPU: process.env.ELECTRON_DISABLE_GPU ?? "1",
      WTM_SETTINGS_PATH: setup.settingsPath,
      WTM_TERMINAL_STORE: setup.terminalsPath,
    },
  });

  const window = await electronApp.firstWindow();
  await window.waitForSelector("text=WTM (WorkTree Manager)", { timeout: 20000 });
  await expect(window.locator(".workspace-row")).toHaveCount(2);

  const worktreeRow = window.locator('.workspace-row[data-kind="worktree"]', { hasText: "feature/test" });
  await expect(worktreeRow.locator('button[aria-label="Delete workspace"]')).toHaveCount(1);

  const folderRow = window.locator('.workspace-row[data-kind="folder"]', { hasText: "orphan-folder" });
  await expect(folderRow.locator("button")).toHaveCount(0);
  await expect(folderRow.locator(".status-icon.folder")).toHaveCount(1);

  await electronApp.close();
  await setup.cleanup();
});
