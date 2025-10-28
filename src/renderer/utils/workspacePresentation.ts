import type { WorkspaceSummary } from "../types";

export type StatusIconKind = "clean" | "dirty" | "folder" | "ahead" | "behind" | "neutral";

export interface StatusIcon {
  className: string;
  text: string;
  tooltip: string;
  kind: StatusIconKind;
  value?: number;
}

export function buildStatusTooltip(status: WorkspaceSummary["status"]): string {
  if (!status) {
    return "Status unavailable";
  }

  const lines: string[] = [];
  const changeCount = status.changeCount ?? 0;

  if (status.clean) {
    const cleanLabel =
      status.summary && status.summary.trim().toLowerCase() !== "clean"
        ? status.summary.trim()
        : "Clean working tree";
    lines.push(cleanLabel);
  } else if (changeCount > 0) {
    lines.push(`${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`);
  } else if (status.summary) {
    lines.push(status.summary.trim());
  }

  if (!status.clean && Array.isArray(status.sampleChanges) && status.sampleChanges.length > 0) {
    lines.push(...status.sampleChanges.slice(0, 5).map((line) => line.trim()));
  }

  const filtered = lines
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter((line, index, arr) => line && arr.indexOf(line) === index);

  if (filtered.length === 0) {
    filtered.push("Status unavailable");
  }

  return filtered.join("\n");
}

export function buildStatusIcons(workspace: WorkspaceSummary): StatusIcon[] {
  const status = workspace.status;
  if (workspace.kind === "folder") {
    return [{ className: "status-icon folder", text: "📁", tooltip: "Folder not linked to a git worktree", kind: "folder" }];
  }

  const tooltip = buildStatusTooltip(status);
  const icons: StatusIcon[] = [];
  if (status.clean) {
    icons.push({ className: "status-icon clean", text: "✔", tooltip, kind: "clean" });
  } else {
    const changeCount = status.changeCount ?? 0;
    const warningText = changeCount > 0 ? `⚠${String(changeCount)}` : "⚠";
    icons.push({ className: "status-icon dirty", text: warningText, tooltip, kind: "dirty", value: changeCount });
  }

  if (status.ahead) {
    icons.push({
      className: "status-icon ahead",
      text: `↑${status.ahead}`,
      tooltip: `Ahead by ${status.ahead} commit${status.ahead === 1 ? "" : "s"}`,
      kind: "ahead",
      value: status.ahead,
    });
  }

  if (status.behind) {
    icons.push({
      className: "status-icon behind",
      text: `↓${status.behind}`,
      tooltip: `Behind by ${status.behind} commit${status.behind === 1 ? "" : "s"}`,
      kind: "behind",
      value: status.behind,
    });
  }

  if (icons.length === 0) {
    icons.push({ className: "status-icon", text: "•", tooltip: "No status information", kind: "neutral" });
  }

  return icons;
}

export function buildWorkspaceDetailTooltip(workspace: WorkspaceSummary): string {
  const status = workspace.status;
  const branchLabel = workspace.branch || workspace.relativePath || "Detached HEAD";
  const lines: string[] = [
    `Branch: ${branchLabel}`,
    `Worktree: ${workspace.relativePath || "—"}`,
    `Path: ${workspace.path}`,
    `HEAD: ${workspace.headSha || "—"}`,
    status.upstream ? `Upstream: ${status.upstream}` : "Upstream: —",
    `Status: ${status.summary}`,
  ];

  if (!status.clean && status.changeCount) {
    lines.push(`${status.changeCount} uncommitted change${status.changeCount === 1 ? "" : "s"}`);
  }

  if (workspace.lastCommit) {
    lines.push(
      `Last commit: ${workspace.lastCommit.shortSha} ${workspace.lastCommit.relativeTime} — ${workspace.lastCommit.subject}`,
    );
  }

  if (!status.clean && Array.isArray(status.sampleChanges) && status.sampleChanges.length > 0) {
    lines.push("Changes:");
    status.sampleChanges.slice(0, 5).forEach((change) => {
      lines.push(` • ${change}`);
    });
  }

  return lines.join("\n");
}
