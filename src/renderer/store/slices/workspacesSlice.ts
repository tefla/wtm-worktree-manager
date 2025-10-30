import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { WorkspaceSummary } from "../../types";
import type { BranchCatalog } from "../types";

export interface WorkspacesState {
  list: WorkspaceSummary[];
  loading: boolean;
  refreshing: boolean;
  branchInput: string;
  baseInput: string;
  createInFlight: boolean;
  branchCatalog: BranchCatalog;
  order: string[];
  activePath: string | null;
  updating: Record<string, boolean>;
}

const initialState: WorkspacesState = {
  list: [],
  loading: true,
  refreshing: false,
  branchInput: "",
  baseInput: "",
  createInFlight: false,
  branchCatalog: { local: [], remote: [] },
  order: [],
  activePath: null,
  updating: {},
};

const workspacesSlice = createSlice({
  name: "workspaces",
  initialState,
  reducers: {
    setWorkspaces(state, action: PayloadAction<WorkspaceSummary[]>) {
      state.list = action.payload;
    },
    setWorkspaceOrder(state, action: PayloadAction<string[]>) {
      state.order = action.payload;
    },
    setActiveWorkspacePath(state, action: PayloadAction<string | null>) {
      state.activePath = action.payload;
    },
    setUpdatingWorkspaces(state, action: PayloadAction<Record<string, boolean>>) {
      state.updating = action.payload;
    },
    setLoadingWorkspaces(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
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
    setBranchCatalog(state, action: PayloadAction<BranchCatalog>) {
      state.branchCatalog = action.payload;
    },
    resetWorkspaces(state) {
      state.list = [];
      state.order = [];
      state.activePath = null;
      state.updating = {};
      state.loading = true;
      state.refreshing = false;
    },
  },
});

export const {
  setWorkspaces,
  setWorkspaceOrder,
  setActiveWorkspacePath,
  setUpdatingWorkspaces,
  setLoadingWorkspaces,
  setRefreshing,
  setBranchInput,
  setBaseInput,
  setCreateInFlight,
  setBranchCatalog,
  resetWorkspaces,
} = workspacesSlice.actions;

export const workspaceReducer = workspacesSlice.reducer;

export const selectWorkspaceState = (state: { workspaces: WorkspacesState }) => state.workspaces;
