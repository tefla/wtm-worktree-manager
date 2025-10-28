const { mkdir, stat } = require("node:fs/promises");
const { constants, promises: fsPromises } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, relative, resolve } = require("node:path");
const { spawn } = require("node:child_process");

const { access } = fsPromises;

class GitCommandError extends Error {
  constructor(command, stderr, message) {
    super(message ?? `Command failed: ${command.join(" ")}`);
    this.name = "GitCommandError";
    this.command = command;
    this.stderr = stderr;
  }
}

async function runCommand(cmd, options = {}) {
  const { cwd, allowFailure = false } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      if (allowFailure) {
        resolve({ stdout, stderr: stderr || error.message, exitCode: 1 });
      } else {
        reject(error);
      }
    });

    child.on("close", (exitCode) => {
      if (exitCode !== 0 && !allowFailure) {
        reject(new GitCommandError(cmd, stderr.trim()));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function pathExists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseWorktreeList(output, workspaceRoot) {
  const lines = output.split(/\r?\n/);
  const entries = [];
  let current = null;
  const normalizedRoot = resolve(workspaceRoot);

  for (const rawLine of lines) {
    if (!rawLine) continue;

    if (rawLine.startsWith("worktree ")) {
      if (current) entries.push(current);
      const pathValue = rawLine.slice("worktree ".length).trim();
      current = { path: resolve(pathValue) };
      continue;
    }

    if (!current) continue;

    if (rawLine.startsWith("HEAD ")) {
      current.headSha = rawLine.slice("HEAD ".length).trim();
      continue;
    }

    if (rawLine.startsWith("branch ")) {
      const ref = rawLine.slice("branch ".length).trim();
      const prefix = "refs/heads/";
      current.branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
    }
  }

  if (current) entries.push(current);

  return entries.filter((entry) => resolve(entry.path).startsWith(normalizedRoot));
}

function parseStatus(output, fallbackBranch) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  let branchLine = lines.shift() ?? "";
  let branchName = fallbackBranch ?? "";
  let upstream;
  let ahead = 0;
  let behind = 0;

  if (branchLine.startsWith("## ")) {
    branchLine = branchLine.slice(3).trim();
    const aheadBehindMatch = branchLine.match(/\[(.+)\]/);
    if (aheadBehindMatch) {
      const parts = aheadBehindMatch[1].split(",");
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith("ahead ")) {
          ahead = Number.parseInt(trimmed.slice("ahead ".length), 10) || 0;
        } else if (trimmed.startsWith("behind ")) {
          behind = Number.parseInt(trimmed.slice("behind ".length), 10) || 0;
        }
      }
      branchLine = branchLine.replace(aheadBehindMatch[0], "").trim();
    }

    const split = branchLine.split("...");
    branchName = split[0] || branchName || "HEAD";
    if (split.length > 1) {
      upstream = split[1] || undefined;
    }
  }

  return {
    branchName,
    upstream,
    ahead,
    behind,
    changes: lines,
    clean: lines.length === 0,
  };
}

function buildStatusSummary(report) {
  const changeCount = report.changes.length;
  let summary = "Clean";
  if (!report.clean) {
    summary = changeCount === 1 ? "1 change" : `${changeCount} changes`;
  }

  return {
    clean: report.clean,
    ahead: report.ahead,
    behind: report.behind,
    upstream: report.upstream,
    changeCount,
    summary,
    sampleChanges: report.changes.slice(0, 5).map((line) => line.trim()),
  };
}

async function getLastCommit(worktreePath, git) {
  const result = await git(["log", "-1", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"], {
    allowFailure: true,
    cwd: worktreePath,
  });

  if (result.exitCode !== 0) return undefined;
  const line = result.stdout.trim();
  if (!line) return undefined;
  const [shortSha = "", author = "", relativeTime = "", subject = ""] = line.split("\x1f");
  return { shortSha, author, relativeTime, subject };
}

class WorkspaceManager {
  constructor(options = {}) {
    const home = homedir();
    this.repoDir = resolve(options.repoDir ?? process.env.SCORZA_REPO_DIR ?? join(home, "dev/refsix/scorza"));
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? process.env.SCORZA_WORKSPACE_ROOT ?? join(home, "dev/refsix/workspaces"),
    );
  }

  async ensureWorkspaceRoot() {
    await mkdir(this.workspaceRoot, { recursive: true });
  }

  async git(args, options = {}) {
    const merged = {
      ...options,
      cwd: options.cwd ?? this.repoDir,
    };
    return runCommand(["git", ...args], merged);
  }

  async getWorktreeEntries() {
    await this.ensureWorkspaceRoot();
    const result = await this.git(["worktree", "list", "--porcelain"]);
    return parseWorktreeList(result.stdout, this.workspaceRoot);
  }

  async buildWorkspace(entry) {
    const statusResult = await this.git(["status", "--porcelain", "--branch"], {
      allowFailure: true,
      cwd: entry.path,
    });

    const parsed = parseStatus(statusResult.stdout, entry.branch);
    const status = buildStatusSummary(parsed);
    const commit = await getLastCommit(entry.path, this.git.bind(this));
    const pathStats = await stat(entry.path).catch(() => undefined);

    const relativePath = relative(this.workspaceRoot, entry.path) || entry.path;
    const headSha = entry.headSha ?? commit?.shortSha ?? "";

    return {
      id: parsed.branchName || relativePath,
      branch: parsed.branchName,
      path: entry.path,
      relativePath,
      headSha,
      status,
      lastCommit: commit,
      updatedAt: pathStats?.mtimeMs,
      kind: "worktree",
    };
  }

  async listWorkspaces() {
    const entries = await this.getWorktreeEntries();
    const worktreeMap = new Map();
    const workspaces = [];

    for (const entry of entries) {
      const workspace = await this.buildWorkspace(entry);
      workspaces.push(workspace);
      worktreeMap.set(resolve(entry.path), true);
    }

    const folderEntries = await fsPromises
      .readdir(this.workspaceRoot, { withFileTypes: true })
      .catch(() => []);

    for (const dirent of folderEntries) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const folderPath = resolve(join(this.workspaceRoot, dirent.name));
      if (worktreeMap.has(folderPath)) {
        continue;
      }

      const stats = await stat(folderPath).catch(() => undefined);
      workspaces.push({
        id: dirent.name,
        branch: dirent.name,
        path: folderPath,
        relativePath: dirent.name,
        headSha: "",
        status: {
          clean: false,
          ahead: 0,
          behind: 0,
          upstream: undefined,
          changeCount: 0,
          summary: "Folder (not a git worktree)",
          sampleChanges: [],
        },
        lastCommit: undefined,
        updatedAt: stats?.mtimeMs,
        kind: "folder",
      });
    }

    return workspaces.sort((a, b) => {
      const aKey = a.branch || a.relativePath || a.path;
      const bKey = b.branch || b.relativePath || b.path;
      return aKey.localeCompare(bKey);
    });
  }

  async refreshWorkspace(path) {
    const entries = await this.getWorktreeEntries();
    const entry = entries.find((item) => item.path === resolve(path));
    if (!entry) {
      throw new Error(`Workspace not found for path: ${path}`);
    }
    return this.buildWorkspace(entry);
  }

  async branchExists(branch) {
    const result = await this.git(["rev-parse", "--verify", branch], { allowFailure: true });
    return result.exitCode === 0;
  }

  async createWorkspace(params) {
    const branchName = params.branch.trim();
    if (!branchName) {
      throw new Error("Branch name is required.");
    }

    await this.ensureWorkspaceRoot();

    const entries = await this.getWorktreeEntries();
    const existing = entries.find((entry) => entry.branch === branchName);
    if (existing) {
      return this.buildWorkspace(existing);
    }

    const worktreePath = resolve(join(this.workspaceRoot, branchName));
    if (await pathExists(worktreePath)) {
      throw new Error(`Target directory already exists: ${worktreePath}. Remove it or choose a different branch.`);
    }

    await mkdir(dirname(worktreePath), { recursive: true });
    await this.git(["fetch", "origin"], { allowFailure: true });

    const branchExists = await this.branchExists(branchName);

    if (!branchExists) {
      const remoteResult = await this.git(["ls-remote", "--exit-code", "--heads", "origin", branchName], {
        allowFailure: true,
      });

      if (remoteResult.exitCode === 0) {
        await this.git(["fetch", "origin", `${branchName}:${branchName}`]);
      } else {
        const baseRef = params.baseRef?.trim() || "origin/develop";
        const [remote, ref] = baseRef.includes("/") ? baseRef.split("/", 2) : ["origin", baseRef];
        await this.git(["fetch", remote, ref], { allowFailure: true });
        await this.git(["worktree", "add", "-b", branchName, worktreePath, baseRef]);
        return this.buildWorkspace({ path: worktreePath, branch: branchName });
      }
    }

    await this.git(["worktree", "add", worktreePath, branchName]);
    return this.buildWorkspace({ path: worktreePath, branch: branchName });
  }

  async deleteWorkspace(params) {
    const targetPath = resolve(params.path);
    const entries = await this.getWorktreeEntries();
    const entry = entries.find((item) => item.path === targetPath);
    if (!entry) {
      return { success: false, reason: "not-found", message: "Workspace not found." };
    }

    const statusReport = await this.git(["status", "--porcelain"], { cwd: targetPath });
    const hasChanges = Boolean(statusReport.stdout.trim());

    if (hasChanges && !params.force) {
      return { success: false, reason: "dirty", message: "Workspace has uncommitted changes." };
    }

    const args = ["worktree", "remove", targetPath];
    if (params.force) {
      args.push("--force");
    }

    try {
      await this.git(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, reason: "git-error", message };
    }

    return { success: true, path: targetPath };
  }
}

const workspaceManager = new WorkspaceManager();

module.exports = {
  workspaceManager,
  WorkspaceManager,
  parseWorktreeList,
  parseStatus,
  buildStatusSummary,
};
