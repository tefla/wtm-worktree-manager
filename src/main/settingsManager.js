const { promises: fs } = require("node:fs");
const { mkdir } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

function defaultSettings() {
  const home = homedir();
  return {
    repoDir: join(home, "wtm", "repo"),
    workspaceRoot: join(home, "wtm", "worktrees"),
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
    const merged = {
      ...defaults,
      ...(raw ?? {}),
    };
    return {
      repoDir: resolve(merged.repoDir),
      workspaceRoot: resolve(merged.workspaceRoot),
    };
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
}

const settingsManager = new SettingsManager();

module.exports = {
  settingsManager,
  SettingsManager,
};
