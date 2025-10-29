const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  parseWorktreeList,
  parseStatus,
  buildStatusSummary,
  WorkspaceManager,
} = require("../../dist/main/workspaceManager.js");

test("parseWorktreeList extracts entries under workspace root", () => {
  const output = `worktree /tmp/workspaces/feature-branch\nHEAD abc123\nbranch refs/heads/feature/branch\n\nworktree /tmp/workspaces/main\nHEAD def456\nbranch refs/heads/main\n`;

  const entries = parseWorktreeList(output, "/tmp/workspaces");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    path: path.resolve("/tmp/workspaces/feature-branch"),
    headSha: "abc123",
    branch: "feature/branch",
  });
});

test("parseStatus reports ahead/behind counts", () => {
  const output = "## feature/branch...origin/feature/branch [ahead 2, behind 1]\n M src/app.js\n";
  const report = parseStatus(output, "feature/branch");
  assert.equal(report.clean, false);
  assert.equal(report.ahead, 2);
  assert.equal(report.behind, 1);
  assert.equal(report.branchName, "feature/branch");
});

test("buildStatusSummary summarises changes", () => {
  const summary = buildStatusSummary({
    clean: false,
    ahead: 1,
    behind: 0,
    upstream: "origin/main",
    changes: [" M src/app.js", "?? new-file"],
  });
  assert.equal(summary.summary, "2 changes");
  assert.equal(summary.sampleChanges[0], "M src/app.js");
});

test("WorkspaceManager.listWorkspaces includes plain folders", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspaces-"));
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-"));
  const looseFolder = path.join(workspaceRoot, "orphan-folder");
  await fs.mkdir(looseFolder);

  const manager = new WorkspaceManager({ repoDir, workspaceRoot });
  manager.getWorktreeEntries = async () => [];
  manager.buildWorkspace = async () => {
    throw new Error("should not build worktree in folder test");
  };

  const workspaces = await manager.listWorkspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].kind, "folder");
  assert.equal(workspaces[0].path, path.resolve(looseFolder));
  assert.equal(workspaces[0].status.summary, "Folder (not a git worktree)");

  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(repoDir, { recursive: true, force: true });
});

test("WorkspaceManager.createWorkspace defaults base ref to current repo branch", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspaces-"));
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-"));
  const manager = new WorkspaceManager({ repoDir, workspaceRoot });
  const gitCalls = [];
  const branchName = "new-feature";
  const worktreePath = path.resolve(path.join(workspaceRoot, branchName));

  manager.getWorktreeEntries = async () => [];
  manager.buildWorkspace = async (entry) => ({
    id: entry.branch ?? entry.path,
    branch: entry.branch,
    path: entry.path,
    relativePath: entry.branch ?? entry.path,
    headSha: "testsha",
    status: {
      clean: true,
      ahead: 0,
      behind: 0,
      changeCount: 0,
      summary: "No changes",
      sampleChanges: [],
    },
    kind: "worktree",
  });

  manager.git = async (args) => {
    gitCalls.push(args);
    const command = args.join(" ");

    if (command === "fetch origin") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === `rev-parse --verify ${branchName}`) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    if (command === `ls-remote --exit-code --heads origin ${branchName}`) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    if (command === "rev-parse --abbrev-ref HEAD") {
      return { stdout: "main\n", stderr: "", exitCode: 0 };
    }

    if (command === "rev-parse HEAD") {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    }

    if (command === "remote") {
      return { stdout: "origin\n", stderr: "", exitCode: 0 };
    }

    if (command === "fetch origin main") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command.startsWith("worktree add -b")) {
      const baseArg = args.at(-1);
      assert.equal(baseArg, "main");
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    throw new Error(`Unexpected git command: ${command}`);
  };

  const summary = await manager.createWorkspace({ branch: branchName });
  assert.equal(summary.branch, branchName);

  const addCall = gitCalls.find((call) => call[0] === "worktree" && call[1] === "add");
  assert.ok(addCall, "should add git worktree");
  assert.equal(addCall.at(-1), "main");

  const revParseCall = gitCalls.some(
    (call) => call[0] === "rev-parse" && call[1] === "--abbrev-ref" && call[2] === "HEAD",
  );
  assert.ok(revParseCall, "should inspect current repo branch");

  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(repoDir, { recursive: true, force: true });
});
