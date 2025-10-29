import React, { FormEvent, useEffect, useMemo, useState } from "react";
import type { JiraSettings, ProjectConfigPayload, QuickAccessEntry } from "../types";

interface SettingsPanelProps {
  open: boolean;
  initialConfig: ProjectConfigPayload | null;
  saving: boolean;
  loginInProgress: boolean;
  refreshInProgress: boolean;
  onSave: (config: ProjectConfigPayload) => Promise<void>;
  onClose: () => void;
  onLogin: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const DEFAULT_SETTINGS: JiraSettings = {
  enabled: false,
  site: "",
  profile: null,
  cliPath: null,
  browseUrl: null,
  jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
  maxResults: 50,
};

const DEFAULT_QUICK_ACCESS: QuickAccessEntry[] = [
  { key: "npm-install", label: "npm i", quickCommand: "npm i" },
  { key: "lerna-bootstrap", label: "npm run lerna:bootstrap", quickCommand: "npm run lerna:bootstrap" },
];

function cloneConfig(config: ProjectConfigPayload | null): ProjectConfigPayload {
  if (!config) {
    return {
      quickAccess: DEFAULT_QUICK_ACCESS.map((entry) => ({ ...entry })),
      jira: { ...DEFAULT_SETTINGS },
    };
  }
  return {
    quickAccess: config.quickAccess.map((entry) => ({ ...entry })),
    jira: { ...DEFAULT_SETTINGS, ...config.jira },
  };
}

function normaliseQuickAccess(entries: QuickAccessEntry[]): QuickAccessEntry[] {
  const result: QuickAccessEntry[] = [];
  const seenKeys = new Set<string>();

  entries.forEach((entry, index) => {
    const label = entry.label?.trim() ?? "";
    const command = entry.quickCommand?.trim() ?? "";
    if (!label && !command) {
      return;
    }
    let key = entry.key?.trim() || `${index}`;
    if (!key) {
      key = `${index}`;
    }
    while (seenKeys.has(key)) {
      key = `${key}-${result.length + 1}`;
    }
    seenKeys.add(key);
    result.push({ key, label, quickCommand: command });
  });

  return result.length > 0 ? result : DEFAULT_QUICK_ACCESS.map((entry) => ({ ...entry }));
}

function normaliseSettings(settings: JiraSettings): JiraSettings {
  const enabled = Boolean(settings.enabled);
  const site = settings.site?.trim() ?? "";
  const profile = settings.profile?.trim() || null;
  const cliPath = settings.cliPath?.trim() || null;
  const browseUrl = settings.browseUrl?.trim() || null;
  const jql = settings.jql?.trim() || DEFAULT_SETTINGS.jql;
  const maxResultsRaw = Number.parseInt(String(settings.maxResults ?? DEFAULT_SETTINGS.maxResults), 10);
  const maxResults = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0 ? maxResultsRaw : DEFAULT_SETTINGS.maxResults;

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

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  open,
  initialConfig,
  saving,
  loginInProgress,
  refreshInProgress,
  onSave,
  onClose,
  onLogin,
  onRefresh,
}) => {
  const [config, setConfig] = useState<ProjectConfigPayload>(() => cloneConfig(initialConfig));

  useEffect(() => {
    if (open) {
      setConfig(cloneConfig(initialConfig));
    }
  }, [open, initialConfig]);

  const handleQuickAccessChange = (index: number, field: keyof QuickAccessEntry, value: string) => {
    setConfig((current) => {
      const next = cloneConfig(current);
      next.quickAccess[index] = {
        ...next.quickAccess[index],
        [field]: value,
      };
      return next;
    });
  };

  const handleAddQuickAccess = () => {
    setConfig((current) => {
      const next = cloneConfig(current);
      next.quickAccess.push({ key: `slot-${next.quickAccess.length + 1}`, label: "", quickCommand: "" });
      return next;
    });
  };

  const handleRemoveQuickAccess = (index: number) => {
    setConfig((current) => {
      const next = cloneConfig(current);
      next.quickAccess.splice(index, 1);
      return next;
    });
  };

  const handleSettingsChange = (field: keyof JiraSettings, value: string | number | boolean) => {
    setConfig((current) => ({
      ...current,
      jira: {
        ...current.jira,
        [field]: value,
      },
    }));
  };

  const preparedConfig = useMemo<ProjectConfigPayload>(() => ({
    quickAccess: normaliseQuickAccess(config.quickAccess),
    jira: normaliseSettings(config.jira),
  }), [config]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await onSave(preparedConfig);
  };

  if (!open) {
    return null;
  }

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Project Settings">
        <header className="settings-header">
          <h2>Project Settings</h2>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <form className="settings-content" onSubmit={handleSubmit}>
          <section className="settings-section">
            <h3>Quick Access Commands</h3>
            <p className="settings-hint">Configure the preset terminal commands available for each workspace.</p>
            <div className="quick-access-list">
              {config.quickAccess.map((entry, index) => (
                <div key={index} className="quick-access-row">
                  <div className="field-group">
                    <label>
                      Label
                      <input
                        type="text"
                        value={entry.label}
                        onChange={(event) => handleQuickAccessChange(index, "label", event.target.value)}
                        placeholder="Command label"
                      />
                    </label>
                  </div>
                  <div className="field-group">
                    <label>
                      Command
                      <input
                        type="text"
                        value={entry.quickCommand}
                        onChange={(event) => handleQuickAccessChange(index, "quickCommand", event.target.value)}
                        placeholder="npm run build"
                      />
                    </label>
                  </div>
                  <button
                    className="ghost-button danger"
                    type="button"
                    onClick={() => handleRemoveQuickAccess(index)}
                    disabled={config.quickAccess.length <= 1}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button className="ghost-button" type="button" onClick={handleAddQuickAccess}>
              Add Command
            </button>
          </section>

          <section className="settings-section">
            <h3>Jira Integration</h3>
            <p className="settings-hint">Connect to Jira via Atlassian CLI (acli) to auto-refresh ticket suggestions.</p>
            <label className="field-toggle">
              <input
                type="checkbox"
                checked={Boolean(config.jira.enabled)}
                onChange={(event) => handleSettingsChange("enabled", event.target.checked)}
              />
              <span>Enable Jira ticket suggestions</span>
            </label>
            <div className="field-grid">
              <label>
                ACLI Site
                <input
                  type="text"
                  value={config.jira.site}
                  onChange={(event) => handleSettingsChange("site", event.target.value)}
                  placeholder="company-cloud"
                />
              </label>
              <label>
                ACLI Profile (optional)
                <input
                  type="text"
                  value={config.jira.profile ?? ""}
                  onChange={(event) => handleSettingsChange("profile", event.target.value)}
                  placeholder="default"
                />
              </label>
              <label>
                ACLI Binary Path (optional)
                <input
                  type="text"
                  value={config.jira.cliPath ?? ""}
                  onChange={(event) => handleSettingsChange("cliPath", event.target.value)}
                  placeholder="/usr/local/bin/acli"
                />
              </label>
              <label>
                Jira Browse URL (optional)
                <input
                  type="text"
                  value={config.jira.browseUrl ?? ""}
                  onChange={(event) => handleSettingsChange("browseUrl", event.target.value)}
                  placeholder="https://company.atlassian.net"
                />
              </label>
              <label>
                Max Results
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={config.jira.maxResults}
                  onChange={(event) => handleSettingsChange("maxResults", Number(event.target.value))}
                />
              </label>
            </div>
            <label className="field-group">
              <span>JQL Query</span>
              <textarea
                value={config.jira.jql}
                onChange={(event) => handleSettingsChange("jql", event.target.value)}
                rows={3}
              />
            </label>
            <div className="jira-actions">
              <button
                type="button"
                className="accent-button"
                onClick={onLogin}
                disabled={loginInProgress || !config.jira.site.trim()}
              >
                {loginInProgress ? "Logging in…" : "Login with Jira"}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={onRefresh}
                disabled={refreshInProgress}
              >
                {refreshInProgress ? "Refreshing…" : "Refresh Ticket Cache"}
              </button>
            </div>
          </section>

          <footer className="settings-footer">
            <button className="ghost-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="accent-button" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
