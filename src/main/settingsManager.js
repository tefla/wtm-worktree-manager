const { promises: fs } = require("node:fs");
const { mkdir } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

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

function defaultSettings() {
  const home = homedir();
  const defaultEnvironment = {
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

function resolveSettingsPath(customPath) {
  if (customPath) {
    return resolve(customPath);
  }
  const home = homedir();
  return resolve(join(home, ".wtm", "settings.json"));
}

class SettingsManager {
  constructor(options = {}) {
    this.filePath = resolveSettingsPath(options.filePath ?? process.env.WTM_SETTINGS_PATH);
    this.settings = null;
  }

  async load() {
    if (this.settings) {
      return this.settings;
    }

    try {
      const raw = await fs.readFile(this.filePath, { encoding: "utf8" });
      const parsed = JSON.parse(raw);
      this.settings = this.normalizeSettings(parsed);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
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

  normalizeSettings(raw) {
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

  coerceToEnvironmentShape(raw, defaults) {
    const source = raw && typeof raw === "object" ? raw : {};

    if (typeof source.repoDir === "string" || typeof source.workspaceRoot === "string") {
      return {
        environments: {
          default: {
            repoDir: source.repoDir,
            workspaceRoot: source.workspaceRoot,
          },
        },
        activeEnvironment: "default",
        quickAccess: defaults.quickAccess,
      };
    }

    const environments =
      source.environments && typeof source.environments === "object" ? source.environments : {};

    return {
      environments,
      activeEnvironment: source.activeEnvironment ?? defaults.activeEnvironment,
      quickAccess: Array.isArray(source.quickAccess) ? source.quickAccess : defaults.quickAccess,
    };
  }

  normalizeQuickAccess(rawList, defaultList) {
    const hasUserList = Array.isArray(rawList);
    const sourceList = hasUserList ? rawList : defaultList;
    const normalized = [];
    const seenKeys = new Set();

    sourceList.forEach((entry, index) => {
      const normalizedEntry = this.normalizeQuickAccessEntry(entry, index);
      if (!normalizedEntry) {
        return;
      }
      let key = normalizedEntry.key;
      let counter = 1;
      while (seenKeys.has(key)) {
        key = `${normalizedEntry.key}-${counter += 1}`;
      }
      seenKeys.add(key);
      normalized.push({
        key,
        label: normalizedEntry.label,
        quickCommand: normalizedEntry.quickCommand,
      });
    });

    if (normalized.length === 0) {
      if (hasUserList && sourceList.length === 0) {
        return [];
      }
      return defaultList.map((item) => ({ ...item }));
    }

    return normalized;
  }

  normalizeQuickAccessEntry(entry, index) {
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

    const labelCandidate = this.extractString(entry.label) || this.extractString(entry.name);
    const commandCandidate =
      this.extractString(entry.quickCommand) || this.extractString(entry.command) || labelCandidate;

    if (!labelCandidate && !commandCandidate) {
      return null;
    }

    const label = labelCandidate || commandCandidate || `Command ${index + 1}`;
    const quickCommand = commandCandidate || label;
    const keySource = this.extractString(entry.key) || label;
    const key = this.slugify(keySource) || `slot-${index + 1}`;

    return {
      key,
      label,
      quickCommand,
    };
  }

  extractString(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  }

  slugify(value) {
    if (!value) {
      return "";
    }
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  normalizeEnvironmentMap(environmentsRaw, defaults) {
    const defaultEnv = defaults.environments[defaults.activeEnvironment];
    const normalized = {};

    for (const [name, value] of Object.entries(environmentsRaw || {})) {
      if (!value || typeof value !== "object") {
        continue;
      }

      const repoDir =
        typeof value.repoDir === "string" && value.repoDir.trim()
          ? value.repoDir
          : defaultEnv.repoDir;
      const workspaceRoot =
        typeof value.workspaceRoot === "string" && value.workspaceRoot.trim()
          ? value.workspaceRoot
          : defaultEnv.workspaceRoot;

      const key = String(name);
      normalized[key] = {
        repoDir: resolve(repoDir),
        workspaceRoot: resolve(workspaceRoot),
      };
    }

    if (Object.keys(normalized).length === 0) {
      normalized.default = {
        repoDir: resolve(defaultEnv.repoDir),
        workspaceRoot: resolve(defaultEnv.workspaceRoot),
      };
    }

    return normalized;
  }

  resolveActiveEnvironment(requested, environments, defaults) {
    const available = Object.keys(environments);
    if (available.length === 0) {
      throw new Error("No environments configured after normalisation");
    }

    if (requested && typeof requested === "string" && environments[requested]) {
      return requested;
    }

    if (environments[defaults.activeEnvironment]) {
      return defaults.activeEnvironment;
    }

    return available[0];
  }

  async save() {
    if (!this.settings) {
      throw new Error("Cannot save settings before calling load()");
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = `${JSON.stringify(this.settings, null, 2)}\n`;
    await fs.writeFile(this.filePath, body, { encoding: "utf8" });
    return this.settings;
  }

  async update(partial) {
    await this.load();
    this.settings = this.normalizeSettings({
      ...this.settings,
      ...partial,
    });
    await this.save();
    return this.settings;
  }

  getSettings() {
    if (!this.settings) {
      throw new Error("Settings have not been loaded yet. Call load() first.");
    }
    return this.settings;
  }

  listEnvironments() {
    const settings = this.getSettings();
    return Object.entries(settings.environments).map(([name, config]) => ({
      name,
      repoDir: config.repoDir,
      workspaceRoot: config.workspaceRoot,
      isActive: name === settings.activeEnvironment,
    }));
  }

  getQuickAccess() {
    const settings = this.getSettings();
    return settings.quickAccess.map((item) => ({ ...item }));
  }

  getEnvironment(name) {
    const settings = this.getSettings();
    const environment = settings.environments[name];
    if (!environment) {
      throw new Error(`Environment not found: ${name}`);
    }
    return {
      name,
      repoDir: environment.repoDir,
      workspaceRoot: environment.workspaceRoot,
    };
  }

  getActiveEnvironment() {
    const settings = this.getSettings();
    return this.getEnvironment(settings.activeEnvironment);
  }

  async setActiveEnvironment(name) {
    if (typeof name !== "string" || !name) {
      throw new Error("Environment name is required");
    }

    await this.load();

    if (!this.settings.environments[name]) {
      throw new Error(`Unknown environment: ${name}`);
    }

    if (this.settings.activeEnvironment !== name) {
      this.settings.activeEnvironment = name;
      await this.save();
    }

    return this.getEnvironment(name);
  }
}

const settingsManager = new SettingsManager();

module.exports = {
  settingsManager,
  SettingsManager,
};
