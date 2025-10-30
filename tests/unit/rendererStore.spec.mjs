import test from "node:test";
import assert from "node:assert/strict";
import { configureStore } from "@reduxjs/toolkit";
import {
  appReducer,
  addRecentProject,
  resetState,
  setActiveProjectName,
  setActiveProjectPath,
  setActiveWorkspacePath,
  setUpdatingWorkspaces,
  setWorkspaceOrder,
  setWorkspaces,
} from "../../tmp/renderer-tests/renderer/store/appSlice.js";

const createStore = () =>
  configureStore({
    reducer: {
      app: appReducer,
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

test("resetState clears workspace data while keeping active project context", () => {
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

  store.dispatch(resetState());

  const state = store.getState().app;
  assert.equal(state.activeProjectPath, "/projects/foo");
  assert.equal(state.activeProjectName, "Foo");
  assert.deepEqual(state.workspaces, []);
  assert.deepEqual(state.workspaceOrder, []);
  assert.equal(state.activeWorkspacePath, null);
  assert.deepEqual(state.updatingWorkspaces, {});
  assert.equal(state.loadingWorkspaces, true);
  assert.deepEqual(
    state.recentProjects.map((project) => project.path),
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

  let state = store.getState().app;
  assert.deepEqual(state.workspaceOrder, [alpha.path, beta.path]);
  assert.equal(state.activeWorkspacePath, beta.path);
  assert.deepEqual(state.updatingWorkspaces, { [beta.path]: true });

  store.dispatch(setWorkspaces([alpha]));
  store.dispatch(setWorkspaceOrder([alpha.path]));
  store.dispatch(setActiveWorkspacePath(alpha.path));
  store.dispatch(setUpdatingWorkspaces({}));

  state = store.getState().app;
  assert.deepEqual(state.workspaceOrder, [alpha.path]);
  assert.equal(state.activeWorkspacePath, alpha.path);
  assert.deepEqual(state.updatingWorkspaces, {});
});
