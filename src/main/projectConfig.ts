import { promises as fs } from "node:fs";
import type { AgentSettings, ProjectConfig, QuickAccessEntry } from "../shared/ipc";

export type { ProjectConfig, QuickAccessEntry } from "../shared/ipc";

const DEFAULT_QUICK_ACCESS: QuickAccessEntry[] = [
  {
    key: "npm-install",
    label: "npm i",
    quickCommand: "npm i",
  },
  {
    key: "lerna-bootstrap",
    label: "npm run lerna:bootstrap",
    quickCommand: "npm run lerna:bootstrap",
  },
];

function cloneQuickAccess(entries: QuickAccessEntry[]): QuickAccessEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    icon: null,
    quickAccess: cloneQuickAccess(DEFAULT_QUICK_ACCESS),
    agent: {
      apiKey: null,
    },
  };
}

function extractString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normaliseIcon(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normaliseQuickAccess(list: unknown): QuickAccessEntry[] {
  const source = Array.isArray(list) ? (list as QuickAccessEntry[]) : [];
  const normalised: QuickAccessEntry[] = [];
  const seenKeys = new Set<string>();

  source.forEach((entry, index) => {
    const labelCandidate = extractString((entry as QuickAccessEntry)?.label) ?? extractString((entry as QuickAccessEntry)?.["name"]);
    const commandCandidate = extractString((entry as QuickAccessEntry)?.quickCommand) ?? extractString((entry as QuickAccessEntry)?.["command"]);

    if (!labelCandidate && !commandCandidate) {
      return;
    }

    const keyCandidate = extractString((entry as QuickAccessEntry)?.key);
    const fallbackKey = slugify(labelCandidate || commandCandidate || "");
    const baseKey = keyCandidate ?? (fallbackKey || `slot-${index + 1}`);

    let key = baseKey;
    let counter = 1;
    while (seenKeys.has(key)) {
      key = `${baseKey}-${(counter += 1)}`;
    }
    seenKeys.add(key);

    normalised.push({
      key,
      label: labelCandidate || commandCandidate || `Command ${index + 1}`,
      quickCommand: commandCandidate || labelCandidate || "",
    });
  });

  if (normalised.length === 0) {
    return cloneQuickAccess(DEFAULT_QUICK_ACCESS);
  }

  return normalised;
}

function normaliseAgentSettings(value: unknown): AgentSettings {
  if (!value || typeof value !== "object") {
    return { apiKey: null };
  }
  const apiKeyRaw = (value as AgentSettings).apiKey;
  const apiKey =
    typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0 ? apiKeyRaw.trim() : null;
  return { apiKey };
}

export function normaliseProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object") {
    return defaultProjectConfig();
  }

  const source = raw as Record<string, unknown>;
  const icon = normaliseIcon(source.icon);
  const quickAccess = normaliseQuickAccess(source.quickAccess);
  const agent = normaliseAgentSettings(source.agent);

  return {
    icon,
    quickAccess,
    agent,
  };
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as ProjectConfig;
    return normaliseProjectConfig(parsed);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      const defaults = defaultProjectConfig();
      await saveProjectConfig(configPath, defaults);
      return defaults;
    }
    throw new Error(
      `Failed to load project configuration from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function saveProjectConfig(configPath: string, config: ProjectConfig): Promise<void> {
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, body, "utf8");
}
