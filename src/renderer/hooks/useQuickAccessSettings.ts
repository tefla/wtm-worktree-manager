import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { ProjectState, QuickAccessEntry } from "../../shared/ipc";
import type { ToastKind } from "../store/types";
import {
  setSettingsDraft,
  setSettingsError,
  setSettingsOpen,
  setSettingsSaving,
  selectSettingsState,
} from "../store/slices/settingsSlice";
import type { TerminalDefinition, QuickAccessDraft } from "../stateTypes";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { projectAPI } from "../services/ipc";
import { normaliseQuickAccessList, slugify } from "../services/normalisers";
import type { ProjectConfig } from "../types";

interface UseQuickAccessSettingsOptions {
  defaultTerminalsRef: MutableRefObject<TerminalDefinition[]>;
  applyProjectState: (state: ProjectState, options?: { persistRecent?: boolean }) => void;
  syncWorkspaceQuickAccess: (entries: QuickAccessEntry[]) => void;
  pushToast: (message: string, kind?: ToastKind) => void;
}

export function useQuickAccessSettings(options: UseQuickAccessSettingsOptions) {
  const { defaultTerminalsRef, applyProjectState, syncWorkspaceQuickAccess, pushToast } = options;
  const dispatch = useAppDispatch();
  const { open, draft, saving, error } = useAppSelector(selectSettingsState);

  const settingsOpen = open;
  const settingsDraft = draft;
  const settingsSaving = saving;
  const settingsError = error;

  const openSettingsOverlay = useCallback(() => {
    const baseDefinitions = defaultTerminalsRef.current.length
      ? defaultTerminalsRef.current
      : normaliseQuickAccessList([], { fallbackToDefault: true });
    dispatch(
      setSettingsDraft(
        baseDefinitions.map((definition) => ({
          id: definition.key,
          initialKey: definition.key,
          label: definition.label,
          quickCommand: definition.quickCommand ?? "",
        })),
      ),
    );
    dispatch(setSettingsError(null));
    dispatch(setSettingsOpen(true));
  }, [defaultTerminalsRef, dispatch]);

  const closeSettingsOverlay = useCallback(() => {
    if (settingsSaving) {
      return;
    }
    dispatch(setSettingsOpen(false));
    dispatch(setSettingsError(null));
  }, [dispatch, settingsSaving]);

  const updateSettingsEntry = useCallback(
    (id: string, patch: Partial<Pick<QuickAccessDraft, "label" | "quickCommand">>) => {
      dispatch(
        setSettingsDraft(
          settingsDraft.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
        ),
      );
    },
    [dispatch, settingsDraft],
  );

  const removeSettingsEntry = useCallback(
    (id: string) => {
      dispatch(setSettingsDraft(settingsDraft.filter((entry) => entry.id !== id)));
    },
    [dispatch, settingsDraft],
  );

  const moveSettingsEntry = useCallback(
    (id: string, direction: "up" | "down") => {
      const index = settingsDraft.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return;
      }
      const targetIndex = direction === "up" ? Math.max(0, index - 1) : Math.min(settingsDraft.length - 1, index + 1);
      if (targetIndex === index) {
        return;
      }
      const next = [...settingsDraft];
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item);
      dispatch(setSettingsDraft(next));
    },
    [dispatch, settingsDraft],
  );

  const addSettingsEntry = useCallback(() => {
    const id = `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch(
      setSettingsDraft([
        ...settingsDraft,
        {
          id,
          initialKey: null,
          label: "",
          quickCommand: "",
        },
      ]),
    );
  }, [dispatch, settingsDraft]);

  const handleSettingsSave = useCallback(async () => {
    if (settingsSaving) {
      return;
    }
    dispatch(setSettingsError(null));

    const trimmed = settingsDraft.map((entry) => ({
      ...entry,
      label: entry.label.trim(),
      quickCommand: entry.quickCommand.trim(),
    }));

    if (trimmed.length === 0) {
      dispatch(setSettingsError("Add at least one quick access command before saving."));
      return;
    }

    const missingCommand = trimmed.some((entry) => !entry.quickCommand);
    if (missingCommand) {
      dispatch(setSettingsError("Each quick access entry needs a command."));
      return;
    }

    const usedKeys = new Set<string>();
    const quickAccess: QuickAccessEntry[] = [];

    trimmed.forEach((entry, index) => {
      const fallbackLabel = entry.label || entry.quickCommand;
      const slugBase = slugify(fallbackLabel);
      const preferredBase =
        entry.initialKey && entry.initialKey.trim() ? entry.initialKey.trim() : slugBase || `slot-${index + 1}`;
      let candidate = preferredBase || `slot-${index + 1}`;
      let counter = 2;
      while (usedKeys.has(candidate)) {
        const suffixBase =
          entry.initialKey && entry.initialKey.trim() ? entry.initialKey.trim() : slugBase || preferredBase || `slot-${index + 1}`;
        candidate = `${suffixBase}-${counter}`;
        counter += 1;
      }
      usedKeys.add(candidate);
      quickAccess.push({
        key: candidate,
        label: fallbackLabel,
        quickCommand: entry.quickCommand,
      });
    });

    const config: ProjectConfig = { quickAccess };
    dispatch(setSettingsSaving(true));
    try {
      const state = await projectAPI.updateConfig({ config });
      applyProjectState(state, { persistRecent: false });
      syncWorkspaceQuickAccess(state.quickAccess);
      dispatch(setSettingsError(null));
      dispatch(setSettingsOpen(false));
      pushToast("Settings updated", "success");
    } catch (error) {
      console.error("Failed to update project settings", error);
      dispatch(setSettingsError("Failed to save settings. Please try again."));
    } finally {
      dispatch(setSettingsSaving(false));
    }
  }, [
    applyProjectState,
    dispatch,
    pushToast,
    settingsDraft,
    settingsSaving,
    syncWorkspaceQuickAccess,
  ]);

  return {
    settingsOpen,
    settingsDraft,
    settingsSaving,
    settingsError,
    openSettingsOverlay,
    closeSettingsOverlay,
    updateSettingsEntry,
    removeSettingsEntry,
    moveSettingsEntry,
    addSettingsEntry,
    handleSettingsSave,
  };
}
