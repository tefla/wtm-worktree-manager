import type { WorkspaceSummary } from "../../shared/ipc";

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function shortName(value: string): string {
  const base = value.split(/[\\/]/).filter(Boolean).pop();
  return base ?? value;
}

export function displayWorkspaceName(workspace: WorkspaceSummary): string {
  return (
    workspace.branch || workspace.relativePath || workspace.id || shortName(workspace.path) || workspace.path
  );
}
