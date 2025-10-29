import React from "react";
import type { DockerComposeServiceInfo } from "../../shared/dockerCompose";
import { cx } from "../utils/cx";

interface ComposeServicesPanelProps {
  hasActiveProject: boolean;
  projectName: string | null;
  services: DockerComposeServiceInfo[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
}

function classifyStateVariant(service: DockerComposeServiceInfo): string {
  const basis = `${service.state} ${service.status}`.toLowerCase();
  if (basis.includes("running") || basis.includes("up")) {
    return "running";
  }
  if (basis.includes("starting") || basis.includes("restarting")) {
    return "starting";
  }
  if (basis.includes("paused")) {
    return "paused";
  }
  if (basis.includes("healthy")) {
    return "running";
  }
  if (basis.includes("unhealthy") || basis.includes("exited") || basis.includes("dead") || basis.includes("stopped")) {
    return "stopped";
  }
  if (basis.includes("created")) {
    return "created";
  }
  return "unknown";
}

export const ComposeServicesPanel: React.FC<ComposeServicesPanelProps> = ({
  hasActiveProject,
  projectName,
  services,
  loading,
  error,
  onRefresh,
}) => {
  const renderBody = () => {
    if (!hasActiveProject) {
      return <div className="compose-panel-message">Open a project to view docker compose services.</div>;
    }
    if (loading) {
      return <div className="compose-panel-message">Loading services…</div>;
    }
    if (error) {
      return <div className="compose-panel-message is-error">{error}</div>;
    }
    if (!services.length) {
      return <div className="compose-panel-message">No docker compose services detected for this project.</div>;
    }
    return (
      <ul className="compose-service-list">
        {services.map((service) => {
          const key = service.id ?? `${service.projectName}:${service.serviceName}:${service.containerName ?? ""}`;
          const variant = classifyStateVariant(service);
          return (
            <li key={key} className="compose-service-row">
              <div className="compose-service-info">
                <span className="compose-service-name">{service.serviceName}</span>
                {service.containerName && service.containerName !== service.serviceName ? (
                  <span className="compose-service-container">{service.containerName}</span>
                ) : null}
                {service.status ? <span className="compose-service-status-text">{service.status}</span> : null}
                {service.health ? (
                  <span className={cx("compose-service-health", service.health.toLowerCase().includes("healthy") ? "healthy" : "unhealthy")}>
                    {service.health}
                  </span>
                ) : null}
              </div>
              <span className={cx("compose-service-state", variant)}>{service.state || "unknown"}</span>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <aside className="compose-panel">
      <div className="compose-panel-header">
        <div className="compose-panel-heading">
          <span className="compose-panel-label">Services</span>
          {projectName ? <span className="compose-panel-project">{projectName}</span> : null}
        </div>
        <button
          type="button"
          className="compose-panel-refresh ghost-button"
          onClick={onRefresh}
          disabled={!hasActiveProject || loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="compose-panel-content">{renderBody()}</div>
    </aside>
  );
};
