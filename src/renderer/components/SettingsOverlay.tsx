import React, { FormEvent } from "react";
import { cx } from "../utils/cx";
import type { QuickAccessDraft } from "../stateTypes";

interface SettingsOverlayProps {
  icon: string;
  quickAccess: QuickAccessDraft[];
  saving: boolean;
  error: string | null;
  agentApiKey: string;
  onRequestClose: () => void;
  onSubmit: () => void;
  onIconChange: (value: string) => void;
  onEntryAdd: () => void;
  onEntryChange: (id: string, patch: Partial<Pick<QuickAccessDraft, "label" | "quickCommand">>) => void;
  onEntryRemove: (id: string) => void;
  onEntryMove: (id: string, direction: "up" | "down") => void;
  onAgentApiKeyChange: (value: string) => void;
}

export const SettingsOverlay: React.FC<SettingsOverlayProps> = ({
  icon,
  quickAccess,
  saving,
  error,
  agentApiKey,
  onRequestClose,
  onSubmit,
  onIconChange,
  onEntryAdd,
  onEntryChange,
  onEntryRemove,
  onEntryMove,
  onAgentApiKeyChange,
}) => {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  const hasEntries = quickAccess.length > 0;

  return (
    <div className="dialog-overlay settings-overlay" role="dialog" aria-modal="true">
      <div className="dialog-backdrop" onClick={onRequestClose} />
      <form className="dialog-panel settings-dialog" onSubmit={handleSubmit}>
        <div className="dialog-header">
          <h2>Project Settings</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close settings"
            onClick={onRequestClose}
            disabled={saving}
          >
            ×
          </button>
        </div>
        <p className="dialog-message">
          Choose a project icon and adjust the quick access commands available for this project.
        </p>
        <div className="settings-section">
          <h3>Project Icon</h3>
          <label className="settings-field">
            <span>Icon</span>
            <input
              type="text"
              value={icon}
              onChange={(event) => onIconChange(event.target.value)}
              placeholder="e.g. 🚀 or path/to/icon.png"
              autoComplete="off"
              disabled={saving}
            />
            <span className="settings-field-note">
              Shown next to the project name and in the picker; point to an image file to update the window icon.
            </span>
          </label>
        </div>
        <div className="settings-section">
          <h3>OpenAI Agent</h3>
          <label className="settings-field">
            <span>API Key</span>
            <input
              type="password"
              value={agentApiKey}
              onChange={(event) => onAgentApiKeyChange(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              disabled={saving}
            />
            <span className="settings-field-note">
              Stored in the project&apos;s `.wtm/config.json`. Leave blank to clear the key.
            </span>
          </label>
        </div>
        <div className="settings-section">
          <h3>Quick Access Commands</h3>
          {hasEntries ? (
            <div className="quick-access-list">
              {quickAccess.map((entry, index) => {
                const commandInvalid = !entry.quickCommand.trim();
                return (
                  <div key={entry.id} className={cx("quick-access-row", { "has-error": commandInvalid })}>
                    <div className="quick-access-fields">
                      <label className="quick-access-field">
                        <span>Label</span>
                        <input
                          type="text"
                          value={entry.label}
                          onChange={(event) =>
                            onEntryChange(entry.id, {
                              label: event.target.value,
                            })
                          }
                          placeholder="e.g. Install dependencies"
                          autoComplete="off"
                        />
                      </label>
                      <label className="quick-access-field">
                        <span>Command</span>
                        <input
                          type="text"
                          value={entry.quickCommand}
                          onChange={(event) =>
                            onEntryChange(entry.id, {
                              quickCommand: event.target.value,
                            })
                          }
                          placeholder="e.g. npm install"
                          autoComplete="off"
                          required
                        />
                      </label>
                    </div>
                    <div className="quick-access-row-actions">
                      <span className="quick-access-index" aria-hidden="true">
                        #{index + 1}
                      </span>
                      <button
                        type="button"
                        className="row-icon-button"
                        onClick={() => onEntryMove(entry.id, "up")}
                        disabled={index === 0 || saving}
                        aria-label="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="row-icon-button"
                        onClick={() => onEntryMove(entry.id, "down")}
                        disabled={index === quickAccess.length - 1 || saving}
                        aria-label="Move down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="row-icon-button danger"
                        onClick={() => onEntryRemove(entry.id)}
                        disabled={saving}
                        aria-label="Remove command"
                      >
                        ✖
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">Add at least one quick access command to get started.</div>
          )}
          <button type="button" className="ghost-button add-row-button" onClick={onEntryAdd} disabled={saving}>
            + Add command
          </button>
        </div>
        {error ? <div className="dialog-warning">{error}</div> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onRequestClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="accent-button" disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
};
