import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { DockerComposeServiceInfo } from "../../shared/dockerCompose";
import type { JiraTicketSummary } from "../../shared/jira";
import type { WorkspaceSummary } from "../types";
import type { QuickAccessDraft } from "../stateTypes";
import type { BranchCatalog, RecentProject, Toast, ToastKind } from "./types";
import {
  loadPreferences,
  loadRecentProjects,
  persistPreferences,
  persistRecentProjects,
  upsertRecentProject,
  type PersistedPreferences,
} from "./persistence";

export interface AppSliceState {
  workspaces: WorkspaceSummary[];
  loadingWorkspaces: boolean;
  refreshing: boolean;
  branchInput: string;
  baseInput: string;
  createInFlight: boolean;
  jiraTickets: JiraTicketSummary[];
  branchCatalog: BranchCatalog;
  recentProjects: RecentProject[];
  activeProjectPath: string | null;
  activeProjectName: string;
  composeProjectName: string | null;
  composeServices: DockerComposeServiceInfo[];
  composeError: string | null;
  composeLoading: boolean;
  openProjectsInNewWindow: boolean;
  workspaceOrder: string[];
  activeWorkspacePath: string | null;
  updatingWorkspaces: Record<string, boolean>;
  settingsOpen: boolean;
  settingsDraft: QuickAccessDraft[];
  settingsSaving: boolean;
  settingsError: string | null;
  toastList: Toast[];
}

const persistedProjects = loadRecentProjects();
const persistedPreferences = loadPreferences();

const initialState: AppSliceState = {
  workspaces: [],
  loadingWorkspaces: true,
  refreshing: false,
  branchInput: "",
  baseInput: "",
  createInFlight: false,
  jiraTickets: [],
  branchCatalog: { local: [], remote: [] },
  recentProjects: persistedProjects,
  activeProjectPath: null,
  activeProjectName: "",
  composeProjectName: null,
  composeServices: [],
  composeError: null,
  composeLoading: false,
  openProjectsInNewWindow: persistedPreferences.openProjectsInNewWindow,
  workspaceOrder: [],
  activeWorkspacePath: null,
  updatingWorkspaces: {},
  settingsOpen: false,
  settingsDraft: [],
  settingsSaving: false,
  settingsError: null,
  toastList: [],
};

const persistProjectList = (projects: RecentProject[]) => persistRecentProjects(projects);
const persistPrefs = (preferences: PersistedPreferences) => persistPreferences(preferences);

const appSlice = createSlice({
  name: "app",
  initialState,
  reducers: {
    setWorkspaces(state, action: PayloadAction<WorkspaceSummary[]>) {
      state.workspaces = action.payload;
    },
    setLoadingWorkspaces(state, action: PayloadAction<boolean>) {
      state.loadingWorkspaces = action.payload;
    },
    setRefreshing(state, action: PayloadAction<boolean>) {
      state.refreshing = action.payload;
    },
    setBranchInput(state, action: PayloadAction<string>) {
      state.branchInput = action.payload;
    },
    setBaseInput(state, action: PayloadAction<string>) {
      state.baseInput = action.payload;
    },
    setCreateInFlight(state, action: PayloadAction<boolean>) {
      state.createInFlight = action.payload;
    },
    setJiraTickets(state, action: PayloadAction<JiraTicketSummary[]>) {
      state.jiraTickets = action.payload;
    },
    setBranchCatalog(state, action: PayloadAction<BranchCatalog>) {
      state.branchCatalog = action.payload;
    },
    setRecentProjects(state, action: PayloadAction<RecentProject[]>) {
      state.recentProjects = action.payload;
      persistProjectList(state.recentProjects);
    },
    addRecentProject(state, action: PayloadAction<RecentProject>) {
      state.recentProjects = upsertRecentProject(state.recentProjects, action.payload);
      persistProjectList(state.recentProjects);
    },
    setActiveProjectPath(state, action: PayloadAction<string | null>) {
      state.activeProjectPath = action.payload;
    },
    setActiveProjectName(state, action: PayloadAction<string>) {
      state.activeProjectName = action.payload;
    },
    setComposeProjectName(state, action: PayloadAction<string | null>) {
      state.composeProjectName = action.payload;
    },
    setComposeServices(state, action: PayloadAction<DockerComposeServiceInfo[]>) {
      state.composeServices = action.payload;
    },
    setComposeError(state, action: PayloadAction<string | null>) {
      state.composeError = action.payload;
    },
    setComposeLoading(state, action: PayloadAction<boolean>) {
      state.composeLoading = action.payload;
    },
    setOpenProjectsInNewWindow(state, action: PayloadAction<boolean>) {
      state.openProjectsInNewWindow = action.payload;
      persistPrefs({ openProjectsInNewWindow: state.openProjectsInNewWindow });
    },
    setWorkspaceOrder(state, action: PayloadAction<string[]>) {
      state.workspaceOrder = action.payload;
    },
    setActiveWorkspacePath(state, action: PayloadAction<string | null>) {
      state.activeWorkspacePath = action.payload;
    },
    setUpdatingWorkspaces(state, action: PayloadAction<Record<string, boolean>>) {
      state.updatingWorkspaces = action.payload;
    },
    setSettingsOpen(state, action: PayloadAction<boolean>) {
      state.settingsOpen = action.payload;
    },
    setSettingsDraft(state, action: PayloadAction<QuickAccessDraft[]>) {
      state.settingsDraft = action.payload;
    },
    setSettingsSaving(state, action: PayloadAction<boolean>) {
      state.settingsSaving = action.payload;
    },
    setSettingsError(state, action: PayloadAction<string | null>) {
      state.settingsError = action.payload;
    },
    setToastList(state, action: PayloadAction<Toast[]>) {
      state.toastList = action.payload;
    },
    addToast(state, action: PayloadAction<Toast>) {
      state.toastList.push(action.payload);
    },
    removeToast(state, action: PayloadAction<number>) {
      state.toastList = state.toastList.filter((toast) => toast.id !== action.payload);
    },
    resetState(state) {
      state.workspaces = [];
      state.workspaceOrder = [];
      state.activeWorkspacePath = null;
      state.updatingWorkspaces = {};
      state.loadingWorkspaces = true;
    },
    setComposeSnapshot(
      state,
      action: PayloadAction<{
        projectName: string | null;
        services: DockerComposeServiceInfo[];
        error: string | null;
      }>,
    ) {
      state.composeProjectName = action.payload.projectName;
      state.composeServices = action.payload.services;
      state.composeError = action.payload.error;
    },
  },
});

export const {
  setWorkspaces,
  setLoadingWorkspaces,
  setRefreshing,
  setBranchInput,
  setBaseInput,
  setCreateInFlight,
  setJiraTickets,
  setBranchCatalog,
  setRecentProjects,
  addRecentProject,
  setActiveProjectPath,
  setActiveProjectName,
  setComposeProjectName,
  setComposeServices,
  setComposeError,
  setComposeLoading,
  setOpenProjectsInNewWindow,
  setWorkspaceOrder,
  setActiveWorkspacePath,
  setUpdatingWorkspaces,
  setSettingsOpen,
  setSettingsDraft,
  setSettingsSaving,
  setSettingsError,
  setToastList,
  addToast,
  removeToast,
  resetState,
  setComposeSnapshot,
} = appSlice.actions;

export const appReducer = appSlice.reducer;

export const selectAppState = (state: { app: AppSliceState }): AppSliceState => state.app;
export const selectToastList = (state: { app: AppSliceState }): Toast[] => state.app.toastList;
export const selectBranchCatalog = (state: { app: AppSliceState }): BranchCatalog => state.app.branchCatalog;
export const selectRecentProjects = (state: { app: AppSliceState }): RecentProject[] => state.app.recentProjects;
export const selectOpenProjectsInNewWindow = (state: { app: AppSliceState }): boolean =>
  state.app.openProjectsInNewWindow;
export const selectActiveProjectPath = (state: { app: AppSliceState }): string | null => state.app.activeProjectPath;
export const selectActiveWorkspacePath = (state: { app: AppSliceState }): string | null =>
  state.app.activeWorkspacePath;
export const selectWorkspaces = (state: { app: AppSliceState }): WorkspaceSummary[] => state.app.workspaces;
export const selectWorkspaceOrder = (state: { app: AppSliceState }): string[] => state.app.workspaceOrder;
export const selectJiraTickets = (state: { app: AppSliceState }): JiraTicketSummary[] => state.app.jiraTickets;
export const selectBranchInput = (state: { app: AppSliceState }): string => state.app.branchInput;
export const selectBaseInput = (state: { app: AppSliceState }): string => state.app.baseInput;
export const selectComposeState = (
  state: { app: AppSliceState },
): {
  services: DockerComposeServiceInfo[];
  projectName: string | null;
  loading: boolean;
  error: string | null;
} => ({
  services: state.app.composeServices,
  projectName: state.app.composeProjectName,
  loading: state.app.composeLoading,
  error: state.app.composeError,
});

export type { Toast, ToastKind, BranchCatalog, RecentProject };
