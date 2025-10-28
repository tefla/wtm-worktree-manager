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
} = require("../../src/main/workspaceManager");

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
