import type { RecentProject } from "./types";

export const RECENT_PROJECTS_STORAGE_KEY = "wtm:recent-projects";
const PREFERENCES_STORAGE_KEY = "wtm:prefs";

const MAX_RECENT_PROJECTS = 8;

const hasLocalStorage = (): boolean => typeof window !== "undefined" && Boolean(window?.localStorage);

export function loadRecentProjects(): RecentProject[] {
  if (!hasLocalStorage()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const projects: RecentProject[] = [];
    parsed.forEach((entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const path = typeof (entry as RecentProject).path === "string" ? (entry as RecentProject).path.trim() : "";
      if (!path) {
        return;
      }
      const name = typeof (entry as RecentProject).name === "string" ? (entry as RecentProject).name.trim() : "";
      const iconCandidate = (entry as { icon?: unknown }).icon;
      const icon =
        typeof iconCandidate === "string" && iconCandidate.trim()
          ? iconCandidate.trim()
          : null;
      projects.push({ path, name: name || path, icon });
    });
    return projects;
  } catch (error) {
    console.error("Failed to read recent projects", error);
    return [];
  }
}

export function persistRecentProjects(projects: RecentProject[]): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(
        projects.slice(0, MAX_RECENT_PROJECTS).map((project) => ({
          path: project.path,
          name: project.name,
          ...(project.icon ? { icon: project.icon } : { icon: null }),
        })),
      ),
    );
  } catch (error) {
    console.error("Failed to persist recent projects", error);
  }
}

export function upsertRecentProject(list: RecentProject[], entry: RecentProject): RecentProject[] {
  const unique = list.filter((item) => item.path !== entry.path);
  return [entry, ...unique].slice(0, MAX_RECENT_PROJECTS);
}

export interface PersistedPreferences {
  openProjectsInNewWindow: boolean;
}

const defaultPreferences: PersistedPreferences = {
  openProjectsInNewWindow: false,
};

export function loadPreferences(): PersistedPreferences {
  if (!hasLocalStorage()) {
    return { ...defaultPreferences };
  }
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return { ...defaultPreferences };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...defaultPreferences };
    }
    return {
      openProjectsInNewWindow:
        typeof (parsed as PersistedPreferences).openProjectsInNewWindow === "boolean"
          ? (parsed as PersistedPreferences).openProjectsInNewWindow
          : defaultPreferences.openProjectsInNewWindow,
    };
  } catch (error) {
    console.error("Failed to load preferences", error);
    return { ...defaultPreferences };
  }
}

export function persistPreferences(preferences: PersistedPreferences): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error("Failed to persist preferences", error);
  }
}
