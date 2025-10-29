import { promises as fs } from "node:fs";

export interface QuickAccessEntry {
  key: string;
  label: string;
  quickCommand: string;
}

export interface JiraProjectConfig {
  enabled: boolean;
  site: string;
  profile: string | null;
  cliPath: string | null;
  browseUrl: string | null;
  jql: string;
  maxResults: number;
}

export interface ProjectConfig {
  quickAccess: QuickAccessEntry[];
  jira: JiraProjectConfig;
}

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

export function defaultJiraProjectConfig(): JiraProjectConfig {
  return {
    enabled: false,
    site: "",
    profile: null,
    cliPath: null,
    browseUrl: null,
    jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    maxResults: 50,
  };
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    quickAccess: cloneQuickAccess(DEFAULT_QUICK_ACCESS),
    jira: defaultJiraProjectConfig(),
  };
}

function extractString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function ensurePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

export function normaliseJiraProjectConfig(raw: unknown): JiraProjectConfig {
  const defaults = defaultJiraProjectConfig();
  if (!raw || typeof raw !== "object") {
    return { ...defaults };
  }

  const source = raw as Record<string, unknown>;
  const enabled = Boolean(source.enabled);
  const site = extractString(source.site) ?? "";
  const profile = extractString(source.profile);
  const cliPath = extractString(source.cliPath);
  const browseUrl = extractString(source.browseUrl);
  const jql = extractString(source.jql) ?? defaults.jql;
  const maxResults = ensurePositiveInteger(source.maxResults, defaults.maxResults);

  return {
    enabled: enabled && Boolean(site),
    site,
    profile,
    cliPath,
    browseUrl,
    jql,
    maxResults,
  };
}

export function normaliseProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object") {
    return defaultProjectConfig();
  }

  const source = raw as Record<string, unknown>;
  const quickAccess = normaliseQuickAccess(source.quickAccess);
  const jira = normaliseJiraProjectConfig(source.jira);

  return {
    quickAccess,
    jira,
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
