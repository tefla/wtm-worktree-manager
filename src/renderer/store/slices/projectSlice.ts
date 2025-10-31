import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { DockerComposeServiceInfo } from "../../../shared/dockerCompose";
import type { ProjectState as ProjectSnapshot } from "../../types";
import type { RecentProject } from "../types";
import { loadPreferences, loadRecentProjects, persistPreferences, persistRecentProjects, upsertRecentProject } from "../persistence";

export interface ProjectFeatureState {
  activeProjectPath: string | null;
  activeProjectName: string;
  activeProjectIcon: string | null;
  recentProjects: RecentProject[];
  composeProjectName: string | null;
  composeServices: DockerComposeServiceInfo[];
  composeError: string | null;
  composeLoading: boolean;
  openProjectsInNewWindow: boolean;
}

const persistedProjects = loadRecentProjects();
const persistedPreferences = loadPreferences();

const initialState: ProjectFeatureState = {
  activeProjectPath: null,
  activeProjectName: "",
  activeProjectIcon: null,
  recentProjects: persistedProjects,
  composeProjectName: null,
  composeServices: [],
  composeError: null,
  composeLoading: false,
  openProjectsInNewWindow: persistedPreferences.openProjectsInNewWindow,
};

const projectSlice = createSlice({
  name: "project",
  initialState,
  reducers: {
    setActiveProjectPath(state, action: PayloadAction<string | null>) {
      state.activeProjectPath = action.payload;
    },
    setActiveProjectName(state, action: PayloadAction<string>) {
      state.activeProjectName = action.payload;
    },
    setActiveProjectIcon(state, action: PayloadAction<string | null>) {
      state.activeProjectIcon = action.payload;
    },
    setRecentProjects(state, action: PayloadAction<RecentProject[]>) {
      state.recentProjects = action.payload;
      persistRecentProjects(state.recentProjects);
    },
    removeRecentProject(state, action: PayloadAction<string>) {
      state.recentProjects = state.recentProjects.filter((project) => project.path !== action.payload);
      persistRecentProjects(state.recentProjects);
    },
    addRecentProject(state, action: PayloadAction<RecentProject>) {
      state.recentProjects = upsertRecentProject(state.recentProjects, action.payload);
      persistRecentProjects(state.recentProjects);
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
      persistPreferences({ openProjectsInNewWindow: state.openProjectsInNewWindow });
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
    applyProjectState(state, action: PayloadAction<ProjectSnapshot>) {
      state.activeProjectPath = action.payload.projectPath;
      state.activeProjectName = action.payload.projectName;
      state.activeProjectIcon = action.payload.projectIcon ?? null;
      state.composeProjectName = action.payload.composeProjectName ?? null;
      state.composeServices = action.payload.composeServices;
      state.composeError = action.payload.composeError ?? null;
      state.composeLoading = false;
    },
    resetProject(state) {
      state.composeProjectName = null;
      state.composeServices = [];
      state.composeError = null;
      state.activeProjectPath = null;
      state.activeProjectName = "";
      state.activeProjectIcon = null;
    },
  },
});

export const {
  setActiveProjectPath,
  setActiveProjectName,
  setActiveProjectIcon,
  setRecentProjects,
  removeRecentProject,
  addRecentProject,
  setComposeProjectName,
  setComposeServices,
  setComposeError,
  setComposeLoading,
  setOpenProjectsInNewWindow,
  setComposeSnapshot,
  applyProjectState,
  resetProject,
} = projectSlice.actions;

export const projectReducer = projectSlice.reducer;

export const selectProjectState = (state: { project: ProjectFeatureState }) => state.project;
