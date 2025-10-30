import type { QuickAccessEntry } from "../../shared/ipc";
import type { DockerComposeServiceInfo } from "../../shared/dockerCompose";
import type { TerminalDefinition } from "../stateTypes";

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normaliseQuickAccessList(
  list: unknown,
  options: { fallbackToDefault?: boolean } = {},
): TerminalDefinition[] {
  const { fallbackToDefault = false } = options;
  const source = Array.isArray(list) ? (list as QuickAccessEntry[]) : [];
  const normalized: TerminalDefinition[] = [];
  const seenKeys = new Set<string>();

  source.forEach((entry, index) => {
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    const command = typeof entry?.quickCommand === "string" ? entry.quickCommand.trim() : "";
    if (!label && !command) {
      return;
    }
    const baseKey = entry?.key && typeof entry.key === "string" ? entry.key.trim() : slugify(label || command);
    let key = baseKey || `slot-${index + 1}`;
    let counter = 1;
    while (seenKeys.has(key)) {
      key = `${baseKey || `slot-${index + 1}`}-${(counter += 1)}`;
    }
    seenKeys.add(key);
    normalized.push({
      key,
      label: label || command || `Command ${index + 1}`,
      quickCommand: command || null,
      isEphemeral: false,
    });
  });

  if (normalized.length === 0 && fallbackToDefault) {
    return [
      { key: "npm-install", label: "npm i", quickCommand: "npm i", isEphemeral: false },
      {
        key: "lerna-bootstrap",
        label: "npm run lerna:bootstrap",
        quickCommand: "npm run lerna:bootstrap",
        isEphemeral: false,
      },
    ];
  }

  return normalized;
}

export function normaliseComposeServices(list: unknown): DockerComposeServiceInfo[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const normalized: DockerComposeServiceInfo[] = [];
  list.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const candidate = entry as Partial<DockerComposeServiceInfo>;
    if (typeof candidate.serviceName !== "string") {
      return;
    }
    const service: DockerComposeServiceInfo = {
      serviceName: candidate.serviceName,
      containerName:
        typeof candidate.containerName === "string" && candidate.containerName.trim()
          ? candidate.containerName
          : null,
      projectName:
        typeof candidate.projectName === "string" && candidate.projectName.trim()
          ? candidate.projectName
          : "",
      state: typeof candidate.state === "string" && candidate.state.trim() ? candidate.state : "unknown",
      status:
        typeof candidate.status === "string" && candidate.status.trim()
          ? candidate.status
          : typeof candidate.state === "string" && candidate.state.trim()
            ? candidate.state
            : "unknown",
      ...(typeof candidate.id === "string" && candidate.id.trim() ? { id: candidate.id } : {}),
      ...(typeof candidate.health === "string" && candidate.health.trim()
        ? { health: candidate.health }
        : {}),
    };
    normalized.push(service);
  });
  return normalized;
}
