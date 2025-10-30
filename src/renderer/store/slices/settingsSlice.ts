import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { QuickAccessDraft } from "../../stateTypes";

export interface SettingsState {
  open: boolean;
  draft: QuickAccessDraft[];
  saving: boolean;
  error: string | null;
}

const initialState: SettingsState = {
  open: false,
  draft: [],
  saving: false,
  error: null,
};

const settingsSlice = createSlice({
  name: "settings",
  initialState,
  reducers: {
    setSettingsOpen(state, action: PayloadAction<boolean>) {
      state.open = action.payload;
    },
    setSettingsDraft(state, action: PayloadAction<QuickAccessDraft[]>) {
      state.draft = action.payload;
    },
    setSettingsSaving(state, action: PayloadAction<boolean>) {
      state.saving = action.payload;
    },
    setSettingsError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
  },
});

export const { setSettingsOpen, setSettingsDraft, setSettingsSaving, setSettingsError } = settingsSlice.actions;

export const settingsReducer = settingsSlice.reducer;

export const selectSettingsState = (state: { settings: SettingsState }) => state.settings;
