import test from "node:test";
import assert from "node:assert/strict";
import { configureStore } from "@reduxjs/toolkit";
import {
  workspaceReducer,
  setWorkspaces,
  setWorkspaceOrder,
  setActiveWorkspacePath,
  setUpdatingWorkspaces,
  resetWorkspaces,
} from "../../tmp/renderer-tests/renderer/store/slices/workspacesSlice.js";
import {
  projectReducer,
  setActiveProjectPath,
  setActiveProjectName,
  addRecentProject,
} from "../../tmp/renderer-tests/renderer/store/slices/projectSlice.js";

const createStore = () =>
  configureStore({
    reducer: {
      workspaces: workspaceReducer,
      project: projectReducer,
    },
  });

const buildWorkspace = (path, overrides = {}) => ({
  id: path,
  branch: overrides.branch ?? undefined,
  path,
  relativePath: overrides.relativePath ?? path.split("/").at(-1) ?? path,
  headSha: overrides.headSha ?? "deadbeef",
  status:
    overrides.status ??
    {
      clean: true,
      ahead: 0,
      behind: 0,
      upstream: undefined,
      changeCount: 0,
      summary: "No changes",
      sampleChanges: [],
    },
  lastCommit: overrides.lastCommit,
  updatedAt: overrides.updatedAt,
  kind: overrides.kind ?? "worktree",
});

test("resetWorkspaces clears workspace data while keeping active project context", () => {
  const store = createStore();
  store.dispatch(setActiveProjectPath("/projects/foo"));
  store.dispatch(setActiveProjectName("Foo"));
  store.dispatch(addRecentProject({ path: "/projects/foo", name: "Foo" }));
  store.dispatch(addRecentProject({ path: "/projects/bar", name: "Bar" }));
  store.dispatch(addRecentProject({ path: "/projects/foo", name: "Foo" }));

  const first = buildWorkspace("/projects/foo/.wtm/workspaces/alpha");
  const second = buildWorkspace("/projects/foo/.wtm/workspaces/beta");

  store.dispatch(setWorkspaces([first, second]));
  store.dispatch(setWorkspaceOrder([first.path, second.path]));
  store.dispatch(setActiveWorkspacePath(second.path));
  store.dispatch(setUpdatingWorkspaces({ [first.path]: true }));

  store.dispatch(resetWorkspaces());

  const { workspaces, project } = store.getState();
  assert.equal(project.activeProjectPath, "/projects/foo");
  assert.equal(project.activeProjectName, "Foo");
  assert.deepEqual(workspaces.list, []);
  assert.deepEqual(workspaces.order, []);
  assert.equal(workspaces.activePath, null);
  assert.deepEqual(workspaces.updating, {});
  assert.equal(workspaces.loading, true);
  assert.deepEqual(
    project.recentProjects.map((proj) => proj.path),
    ["/projects/foo", "/projects/bar"],
  );
});

test("workspace order and active selection follow lifecycle transitions", () => {
  const store = createStore();
  const alpha = buildWorkspace("/projects/foo/.wtm/workspaces/alpha");
  const beta = buildWorkspace("/projects/foo/.wtm/workspaces/beta");

  store.dispatch(setWorkspaces([alpha]));
  store.dispatch(setWorkspaceOrder([alpha.path]));
  store.dispatch(setActiveWorkspacePath(alpha.path));

  store.dispatch(setWorkspaces([alpha, beta]));
  store.dispatch(setWorkspaceOrder([alpha.path, beta.path]));
  store.dispatch(setActiveWorkspacePath(beta.path));
  store.dispatch(setUpdatingWorkspaces({ [beta.path]: true }));

  let state = store.getState().workspaces;
  assert.deepEqual(state.order, [alpha.path, beta.path]);
  assert.equal(state.activePath, beta.path);
  assert.deepEqual(state.updating, { [beta.path]: true });

  store.dispatch(setWorkspaces([alpha]));
  store.dispatch(setWorkspaceOrder([alpha.path]));
  store.dispatch(setActiveWorkspacePath(alpha.path));
  store.dispatch(setUpdatingWorkspaces({}));

  state = store.getState().workspaces;
  assert.deepEqual(state.order, [alpha.path]);
  assert.equal(state.activePath, alpha.path);
  assert.deepEqual(state.updating, {});
});
