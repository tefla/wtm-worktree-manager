const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const util = require("node:util");
const { _electron: electron } = require("@playwright/test");

const execFileAsync = util.promisify(execFile);

async function runGit(args, options) {
  await execFileAsync("git", args, options);
}

function createHostSocketPath() {
  if (process.platform === "win32") {
    return `\\\\?\\pipe\\wtm-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return path.join(os.tmpdir(), `wtm-host-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
}

async function setupProjectWorkspace() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-project-"));

  await runGit(["init"], { cwd: projectPath });
  await runGit(["checkout", "-b", "main"], { cwd: projectPath });
  await runGit(["config", "user.name", "Playwright"], { cwd: projectPath });
  await runGit(["config", "user.email", "playwright@example.com"], { cwd: projectPath });

  await fs.writeFile(path.join(projectPath, "README.md"), "# Playwright project\n");
  await runGit(["add", "README.md"], { cwd: projectPath });
  await runGit(["commit", "-m", "initial"], { cwd: projectPath });

  await runGit(["branch", "feature/test"], { cwd: projectPath });

  const wtmPath = path.join(projectPath, ".wtm");
  const workspacesPath = path.join(wtmPath, "workspaces");
  await fs.mkdir(workspacesPath, { recursive: true });

  await fs.writeFile(
    path.join(wtmPath, "config.json"),
    JSON.stringify({ quickAccess: [] }, null, 2),
    "utf8",
  );

  const terminalsPath = path.join(wtmPath, "terminals.json");
  await fs.writeFile(terminalsPath, JSON.stringify({ workspaces: {} }, null, 2), "utf8");

  const worktreePath = path.join(workspacesPath, "feature-test");
  await runGit(["worktree", "add", worktreePath, "feature/test"], { cwd: projectPath });

  const orphanFolder = path.join(workspacesPath, "orphan-folder");
  await fs.mkdir(orphanFolder, { recursive: true });

  const socketPath = createHostSocketPath();

  async function cleanup() {
    await fs.rm(orphanFolder, { recursive: true, force: true }).catch(() => {});
    await runGit(["worktree", "prune"], { cwd: projectPath }).catch(() => {});
    await fs.rm(path.join(wtmPath, "workspaces"), { recursive: true, force: true }).catch(() => {});
    await fs.rm(wtmPath, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    if (process.platform !== "win32") {
      await fs.rm(socketPath, { force: true }).catch(() => {});
    }
  }

  return {
    projectPath,
    wtmPath,
    worktreePath,
    orphanFolder,
    terminalsPath,
    socketPath,
    cleanup,
  };
}

async function launchAppWithProject(project) {
  const projectRoot = path.resolve(__dirname, "../../");

  const electronApp = await electron.launch({
    args: [".", "--disable-gpu", "--disable-software-rasterizer"],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      ELECTRON_DISABLE_GPU: process.env.ELECTRON_DISABLE_GPU ?? "1",
      WTM_TERMINAL_STORE: project.terminalsPath,
      WTM_TERMINAL_HOST_SOCKET: project.socketPath,
      WTM_E2E_PROJECT_PATH: project.projectPath,
      WTM_FAKE_PTY: "1",
      WTM_IDLE_SHUTDOWN_MS: "500",
      SHELL: process.env.SHELL ?? "/bin/sh",
    },
  });

  const window = await electronApp.firstWindow();
  window.on("console", (message) => {
    console.log("[renderer]", message.type(), message.text());
  });
  await window.waitForSelector("text=WTM (WorkTree Manager)", { timeout: 20000 });

  let workspaces = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      workspaces = await window.evaluate(() => window.workspaceAPI.list());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No project configured")) {
        await window.waitForTimeout(500);
        continue;
      }
      throw error;
    }
    if (Array.isArray(workspaces) && workspaces.length > 0) {
      await window.waitForTimeout(200);
      break;
    }
    await window.waitForTimeout(500);
  }

  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("Timed out waiting for workspace list to load");
  }

  console.log("[e2e] workspaceAPI.list returned", workspaces.length, "entries");

  let rowCount = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    rowCount = await window.evaluate(() => document.querySelectorAll(".workspace-row").length);
    if (rowCount > 0) break;
    await window.waitForTimeout(250);
  }

  if (rowCount === 0) {
    const markup = await window.evaluate(() => document.querySelector("#workspace-list")?.innerHTML ?? null);
    console.warn("[e2e] workspace-list markup", markup);
    throw new Error("Workspace elements not rendered in sidebar");
  }

  return { electronApp, window, workspaces };
}

async function closeElectronApp(app) {
  if (!app) return;
  try {
    console.log("[e2e] closing electron app");
    await app.close();
    console.log("[e2e] electron app closed");
  } catch (error) {
    console.warn("failed to close electron app", error);
  }
}

module.exports = {
  setupProjectWorkspace,
  launchAppWithProject,
  closeElectronApp,
  runGit,
};
