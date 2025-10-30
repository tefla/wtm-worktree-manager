const test = require("node:test");
const assert = require("node:assert/strict");

const { WorkspaceService } = require("../../dist/main/services/workspaceService.js");

test("WorkspaceService list transforms allow extension of results", async () => {
  const manager = {
    listWorkspaces: async () => [
      { id: "one", path: "/tmp/one" },
      { id: "two", path: "/tmp/two" },
    ],
    listBranches: async () => ({ local: [], remote: [] }),
    createWorkspace: async (params) => ({ id: params.branch, path: params.branch }),
    deleteWorkspace: async () => ({ success: true }),
    refreshWorkspace: async (path) => ({ id: path, path }),
    updateWorkspace: async (path) => ({ id: path, path }),
    ensureWorkspaceRoot: async () => {},
  };

  const service = new WorkspaceService(manager);
  service.registerListTransform((list) => list.filter((workspace) => workspace.id !== "two"));
  const workspaces = await service.listWorkspaces();
  assert.deepEqual(
    workspaces.map((workspace) => workspace.id),
    ["one"],
    "transform should filter entries",
  );
});
