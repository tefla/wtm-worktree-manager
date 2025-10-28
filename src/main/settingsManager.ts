import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_QUICK_ACCESS = [
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

export interface QuickAccessEntry {
  key: string;
  label: string;
  quickCommand: string;
}

export interface EnvironmentDefinition {
  repoDir: string;
  workspaceRoot: string;
}

export interface SettingsData {
  environments: Record<string, EnvironmentDefinition>;
  activeEnvironment: string;
  quickAccess: QuickAccessEntry[];
}

export interface SettingsManagerOptions {
  filePath?: string;
}

function defaultSettings(): SettingsData {
  const home = homedir();
  const defaultEnvironment: EnvironmentDefinition = {
    repoDir: join(home, "wtm", "repo"),
    workspaceRoot: join(home, "wtm", "worktrees"),
  };

  return {
    environments: {
      default: defaultEnvironment,
    },
    activeEnvironment: "default",
    quickAccess: DEFAULT_QUICK_ACCESS,
  };
}

function resolveSettingsPath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  const home = homedir();
  return resolve(join(home, ".wtm", "settings.json"));
}

export class SettingsManager {
  private filePath: string;
  private settings: SettingsData | null;

  constructor(options: SettingsManagerOptions = {}) {
    this.filePath = resolveSettingsPath(options.filePath ?? process.env.WTM_SETTINGS_PATH);
    this.settings = null;
  }

  async load(): Promise<SettingsData> {
    if (this.settings) {
      return this.settings;
    }

    try {
      const raw = await fs.readFile(this.filePath, { encoding: "utf8" });
      const parsed = JSON.parse(raw) as SettingsData;
      this.settings = this.normalizeSettings(parsed);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        this.settings = this.normalizeSettings(defaultSettings());
        await this.save();
      } else {
        throw new Error(
          `Failed to load settings from ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return this.settings;
  }

  private normalizeSettings(raw: unknown): SettingsData {
    const defaults = defaultSettings();
    const normalizedRaw = this.coerceToEnvironmentShape(raw, defaults);

    const environments = this.normalizeEnvironmentMap(normalizedRaw.environments, defaults);

    const activeEnvironment = this.resolveActiveEnvironment(
      normalizedRaw.activeEnvironment,
      environments,
      defaults,
    );

    const quickAccess = this.normalizeQuickAccess(normalizedRaw.quickAccess, defaults.quickAccess);

    return {
      environments,
      activeEnvironment,
      quickAccess,
    };
  }

  private coerceToEnvironmentShape(raw: unknown, defaults: SettingsData): SettingsData {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

    if (typeof source.repoDir === "string" || typeof source.workspaceRoot === "string") {
      return {
        environments: {
          default: {
            repoDir: String(source.repoDir || ""),
            workspaceRoot: String(source.workspaceRoot || ""),
          },
        },
        activeEnvironment: "default",
        quickAccess: defaults.quickAccess,
      };
    }

    const environments =
      source.environments && typeof source.environments === "object" ? (source.environments as Record<string, EnvironmentDefinition>) : {};

    return {
      environments,
      activeEnvironment: typeof source.activeEnvironment === "string" ? source.activeEnvironment : defaults.activeEnvironment,
      quickAccess: Array.isArray(source.quickAccess) ? (source.quickAccess as QuickAccessEntry[]) : defaults.quickAccess,
    };
  }

  private normalizeQuickAccess(rawList: unknown, defaultList: QuickAccessEntry[]): QuickAccessEntry[] {
    const hasUserList = Array.isArray(rawList);
    const sourceList = hasUserList ? (rawList as QuickAccessEntry[]) : defaultList;
    const normalized: QuickAccessEntry[] = [];
    const seenKeys = new Set<string>();

    sourceList.forEach((entry, index) => {
      const normalizedEntry = this.normalizeQuickAccessEntry(entry, index);
      if (!normalizedEntry) {
        return;
      }
      let key = normalizedEntry.key;
      let counter = 1;
      while (seenKeys.has(key)) {
        key = `${normalizedEntry.key}-${(counter += 1)}`;
      }
      seenKeys.add(key);
      normalized.push({
        key,
        label: normalizedEntry.label,
        quickCommand: normalizedEntry.quickCommand,
      });
    });

    if (normalized.length === 0) {
      if (hasUserList && (sourceList as QuickAccessEntry[]).length === 0) {
        return [];
      }
      return defaultList.map((item) => ({ ...item }));
    }

    return normalized;
  }

  private normalizeQuickAccessEntry(entry: unknown, index: number): QuickAccessEntry | null {
    if (!entry || (typeof entry !== "object" && typeof entry !== "string")) {
      return null;
    }

    if (typeof entry === "string") {
      const label = entry.trim();
      if (!label) {
        return null;
      }
      return {
        key: this.slugify(label) || `slot-${index + 1}`,
        label,
        quickCommand: label,
      };
    }

    const labelCandidate = this.extractString((entry as Record<string, unknown>).label) ||
      this.extractString((entry as Record<string, unknown>).name);
    const commandCandidate =
      this.extractString((entry as Record<string, unknown>).quickCommand) ||
      this.extractString((entry as Record<string, unknown>).command) ||
      labelCandidate;

    if (!labelCandidate && !commandCandidate) {
      return null;
    }

    const label = labelCandidate || commandCandidate || `Command ${index + 1}`;
    const quickCommand = commandCandidate || label;
    const keySource = this.extractString((entry as Record<string, unknown>).key) || label;
    const key = this.slugify(keySource) || `slot-${index + 1}`;

    return {
      key,
      label,
      quickCommand,
    };
  }

  private extractString(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  }

  private slugify(value: string): string {
    if (!value) {
      return "";
    }
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private normalizeEnvironmentMap(
    environments: Record<string, EnvironmentDefinition>,
    defaults: SettingsData,
  ): Record<string, EnvironmentDefinition> {
    const result: Record<string, EnvironmentDefinition> = {};
    for (const [key, value] of Object.entries(environments || {})) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const repoDir = this.extractString((value as unknown as Record<string, string>).repoDir) || defaults.environments.default.repoDir;
      const workspaceRoot =
        this.extractString((value as unknown as Record<string, string>).workspaceRoot) || defaults.environments.default.workspaceRoot;
      result[key] = {
        repoDir: resolve(repoDir),
        workspaceRoot: resolve(workspaceRoot),
      };
    }
    if (Object.keys(result).length === 0) {
      return { ...defaults.environments };
    }
    return result;
  }

  private resolveActiveEnvironment(
    active: string | undefined,
    environments: Record<string, EnvironmentDefinition>,
    defaults: SettingsData,
  ): string {
    if (active && environments[active]) {
      return active;
    }
    if (environments[defaults.activeEnvironment]) {
      return defaults.activeEnvironment;
    }
    const keys = Object.keys(environments);
    return keys[0] ?? defaults.activeEnvironment;
  }

  listEnvironments(): Record<string, EnvironmentDefinition> {
    if (!this.settings) {
      throw new Error("Settings not loaded");
    }
    return this.settings.environments;
  }

  getActiveEnvironment(): EnvironmentDefinition & { name: string } {
    if (!this.settings) {
      throw new Error("Settings not loaded");
    }
    const name = this.settings.activeEnvironment;
    const environment = this.settings.environments[name];
    if (!environment) {
      throw new Error(`Active environment '${name}' not found`);
    }
    return { ...environment, name };
  }

  getQuickAccess(): QuickAccessEntry[] {
    if (!this.settings) {
      throw new Error("Settings not loaded");
    }
    return this.settings.quickAccess;
  }

  async save(): Promise<void> {
    if (!this.settings) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = `${JSON.stringify(this.settings, null, 2)}\n`;
    await fs.writeFile(this.filePath, body, { encoding: "utf8" });
  }

  async setActiveEnvironment(name: string): Promise<EnvironmentDefinition & { name: string }> {
    await this.load();
    const environment = this.settings?.environments[name];
    if (!environment) {
      throw new Error(`Environment '${name}' does not exist`);
    }
    if (!this.settings) {
      throw new Error("Settings not loaded");
    }
    this.settings.activeEnvironment = name;
    await this.save();
    return { ...environment, name };
  }
}

export const settingsManager = new SettingsManager();
