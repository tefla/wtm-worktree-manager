import React from "react";
import type { SettingsResponse } from "../types";

interface AppHeaderProps {
  title: string;
  subtitle: string;
  environments: SettingsResponse["environments"];
  activeEnvironment: string;
  refreshing: boolean;
  onEnvironmentChange: (name: string) => void;
  onRefreshAll: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  title,
  subtitle,
  environments,
  activeEnvironment,
  refreshing,
  onEnvironmentChange,
  onRefreshAll,
}) => {
  const environmentEntries = Object.entries(environments);
  return (
    <header className="app-header">
      <div className="header-text">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="header-actions">
        <label className="environment-switcher">
          <span>Environment</span>
          <select
            id="environment-select"
            name="environment"
            value={activeEnvironment}
            onChange={(event) => onEnvironmentChange(event.target.value)}
          >
            {environmentEntries.map(([name]) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          id="refresh-button"
          className="accent-button"
          type="button"
          onClick={onRefreshAll}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
};
