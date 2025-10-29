import { basename } from "node:path";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { DockerComposeServiceInfo, DockerComposeServicesSnapshot } from "../shared/dockerCompose";

interface DockerHttpResult {
  ok: boolean;
  statusCode?: number;
  body: string;
  errorMessage?: string;
  errorCode?: string;
}

interface ComposeContainerSummary {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
  State?: string;
  Status?: string;
}

interface ComposeProjectGroup {
  projectName: string;
  projectNameLower: string;
  containers: ComposeContainerSummary[];
  workingDir: string | null;
  configFiles: string[];
}

type DockerConnection =
  | {
      type: "socket";
      socketPath: string;
    }
  | {
      type: "http";
      protocol: "http" | "https";
      hostname: string;
      port: number;
    };

const isWindows = process.platform === "win32";

function normaliseString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalisePathForComparison(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalised = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalised) {
    return null;
  }
  return isWindows ? normalised.toLowerCase() : normalised;
}

function pathsEqual(a: string | null, b: string | null): boolean {
  const normalisedA = normalisePathForComparison(a);
  const normalisedB = normalisePathForComparison(b);
  return Boolean(normalisedA && normalisedB && normalisedA === normalisedB);
}

function pathStartsWith(value: string | null, possiblePrefix: string | null): boolean {
  const normalisedValue = normalisePathForComparison(value);
  const normalisedPrefix = normalisePathForComparison(possiblePrefix);
  if (!normalisedValue || !normalisedPrefix) {
    return false;
  }
  return normalisedValue === normalisedPrefix || normalisedValue.startsWith(`${normalisedPrefix}/`);
}

function extractHealth(status: string | null): string | null {
  if (!status) {
    return null;
  }

  const segments = status.match(/\([^()]+\)/g);
  if (!segments) {
    return null;
  }

  for (const segment of segments) {
    const content = segment.slice(1, -1).trim();
    if (!content) {
      continue;
    }

    const lowered = content.toLowerCase();
    if (lowered.startsWith("health:")) {
      const value = lowered.slice("health:".length).trim();
      if (value) {
        return value;
      }
      continue;
    }

    if (/(healthy|unhealthy|starting|no healthcheck)/.test(lowered)) {
      return lowered;
    }
  }

  return null;
}

function resolveDockerConnection(): DockerConnection {
  const dockerHost = normaliseString(process.env.DOCKER_HOST);
  if (dockerHost) {
    try {
      const hostValue = dockerHost.includes("://") ? dockerHost : `tcp://${dockerHost}`;
      const parsed = new URL(hostValue);
      if (parsed.protocol === "unix:") {
        const socketPath = parsed.pathname;
        if (socketPath) {
          return { type: "socket", socketPath };
        }
      }
      if (parsed.protocol === "tcp:" || parsed.protocol === "http:" || parsed.protocol === "https:") {
        const protocol = parsed.protocol === "https:" ? "https" : "http";
        const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 2375;
        return {
          type: "http",
          protocol,
          hostname: parsed.hostname,
          port,
        };
      }
    } catch (error) {
      console.debug("Failed to parse DOCKER_HOST", error);
    }
  }

  const explicitSocket = normaliseString(process.env.DOCKER_SOCKET);
  if (explicitSocket) {
    return { type: "socket", socketPath: explicitSocket };
  }

  return { type: "socket", socketPath: "/var/run/docker.sock" };
}

const dockerConnection = resolveDockerConnection();

function dockerHttpRequest(path: string): Promise<DockerHttpResult> {
  return new Promise((resolve) => {
    const requestOptions: RequestOptions = {
      method: "GET",
      path,
      timeout: 5000,
    };

    let requestFn = httpRequest;

    if (dockerConnection.type === "socket") {
      requestOptions.socketPath = dockerConnection.socketPath;
    } else {
      requestOptions.hostname = dockerConnection.hostname;
      requestOptions.port = dockerConnection.port;
      requestFn = dockerConnection.protocol === "https" ? httpsRequest : httpRequest;
    }

    const req = requestFn(requestOptions, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        const statusCode = res.statusCode ?? 0;
        resolve({
          ok: statusCode >= 200 && statusCode < 300,
          statusCode,
          body,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Docker request timed out"));
    });

    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        body: "",
        errorMessage: error?.message,
        errorCode: error?.code,
      });
    });

    req.end();
  });
}

function describeDockerError(result: DockerHttpResult, fallback: string): string {
  if (result.errorCode === "ENOENT") {
    return "Docker socket not available";
  }
  if (result.errorCode === "EACCES") {
    return "Access to the Docker socket was denied";
  }
  if (result.errorCode === "ECONNREFUSED") {
    return "Unable to connect to the Docker engine";
  }
  if (result.statusCode === 403) {
    return "Access to the Docker engine was denied";
  }
  if (result.statusCode === 404) {
    return "Docker endpoint returned 404";
  }
  if (result.errorMessage) {
    return result.errorMessage;
  }
  if (result.body) {
    return result.body.trim();
  }
  return fallback;
}

function collectProjectGroups(containers: ComposeContainerSummary[]): ComposeProjectGroup[] {
  const groups = new Map<string, ComposeProjectGroup>();

  for (const container of containers) {
    if (!container || typeof container !== "object") {
      continue;
    }

    const labels = container.Labels ?? {};
    const projectName = normaliseString(labels["com.docker.compose.project"]);
    if (!projectName) {
      continue;
    }

    let group = groups.get(projectName);
    if (!group) {
      group = {
        projectName,
        projectNameLower: projectName.toLowerCase(),
        containers: [],
        workingDir: null,
        configFiles: [],
      };
      groups.set(projectName, group);
    }

    group.containers.push(container);

    const workingDirLabel = normaliseString(labels["com.docker.compose.project.working_dir"]);
    const workingDir = normalisePathForComparison(workingDirLabel);
    if (workingDir && !group.workingDir) {
      group.workingDir = workingDir;
    }

    const configFilesLabel =
      normaliseString(labels["com.docker.compose.project.config_files"]) ??
      normaliseString(labels["com.docker.compose.config-files"]);
    if (configFilesLabel) {
      const files = configFilesLabel
        .split(/[,;]+/)
        .map((file) => normalisePathForComparison(normaliseString(file)))
        .filter((file): file is string => Boolean(file));
      for (const file of files) {
        if (!group.configFiles.includes(file)) {
          group.configFiles.push(file);
        }
      }
    }
  }

  return Array.from(groups.values());
}

function selectProjectGroup(
  groups: ComposeProjectGroup[],
  projectPath: string,
  fallbackProjectName: string | null,
): ComposeProjectGroup | null {
  if (groups.length === 0) {
    return null;
  }

  const normalisedProjectPath = normalisePathForComparison(projectPath);
  if (normalisedProjectPath) {
    const exactWorkingDir = groups.find((group) => group.workingDir && pathsEqual(group.workingDir, normalisedProjectPath));
    if (exactWorkingDir) {
      return exactWorkingDir;
    }

    const overlappingWorkingDir = groups.find(
      (group) =>
        group.workingDir &&
        (pathStartsWith(group.workingDir, normalisedProjectPath) || pathStartsWith(normalisedProjectPath, group.workingDir)),
    );
    if (overlappingWorkingDir) {
      return overlappingWorkingDir;
    }

    const configMatch = groups.find((group) => group.configFiles.some((file) => pathStartsWith(file, normalisedProjectPath)));
    if (configMatch) {
      return configMatch;
    }
  }

  const fallbackNormalised = fallbackProjectName ? fallbackProjectName.toLowerCase() : null;
  if (fallbackNormalised) {
    const fallbackMatch = groups.find((group) => group.projectNameLower === fallbackNormalised);
    if (fallbackMatch) {
      return fallbackMatch;
    }
  }

  return groups[0] ?? null;
}

function toServiceInfo(container: ComposeContainerSummary, projectName: string): DockerComposeServiceInfo | null {
  const labels = container.Labels ?? {};
  let serviceName = normaliseString(labels["com.docker.compose.service"]);

  const names = Array.isArray(container.Names) ? container.Names : [];
  const firstNamedEntry = names.find((name) => Boolean(normaliseString(name))) ?? null;
  const trimmedContainerName = normaliseString(firstNamedEntry);
  const containerName = trimmedContainerName ? trimmedContainerName.replace(/^\//, "") : null;

  if (!serviceName && containerName) {
    const candidates = [
      `${projectName}-`,
      `${projectName}_`,
      `${projectName.toLowerCase()}-`,
      `${projectName.toLowerCase()}_`,
    ];
    for (const prefix of candidates) {
      if (containerName.startsWith(prefix)) {
        const remainder = containerName.slice(prefix.length);
        const parts = remainder.split("-");
        if (parts.length > 1) {
          parts.pop();
          serviceName = parts.join("-") || null;
        } else {
          serviceName = remainder || null;
        }
        if (serviceName) {
          break;
        }
      }
    }
  }

  if (!serviceName) {
    serviceName = containerName;
  }

  if (!serviceName) {
    return null;
  }

  const state = normaliseString(container.State) ?? "unknown";
  const statusRaw = normaliseString(container.Status);
  const status = statusRaw ?? state;
  const health = extractHealth(statusRaw);

  return {
    id: container.Id ?? null,
    serviceName,
    containerName,
    projectName,
    state,
    status,
    health,
  };
}

export class DockerComposeInspector {
  async inspect(projectPath: string): Promise<DockerComposeServicesSnapshot> {
    const fallbackProjectName = normaliseString(basename(projectPath));

    const filters = encodeURIComponent(
      JSON.stringify({
        label: ["com.docker.compose.project"],
      }),
    );

    const result = await dockerHttpRequest(`/containers/json?all=1&filters=${filters}`);

    if (!result.ok) {
      const errorMessage = describeDockerError(result, "Failed to query docker compose services");
      return { projectName: fallbackProjectName ?? null, services: [], error: errorMessage };
    }

    let parsed: unknown;
    try {
      parsed = result.body ? JSON.parse(result.body) : [];
    } catch (error) {
      console.debug("Failed to parse docker engine response", error);
      return {
        projectName: fallbackProjectName ?? null,
        services: [],
        error: "Failed to parse Docker engine response",
      };
    }

    const containers = Array.isArray(parsed) ? (parsed as ComposeContainerSummary[]) : [];
    const groups = collectProjectGroups(containers);
    const selectedGroup = selectProjectGroup(groups, projectPath, fallbackProjectName);

    if (!selectedGroup) {
      return {
        projectName: fallbackProjectName ?? null,
        services: [],
      };
    }

    const services: DockerComposeServiceInfo[] = [];
    for (const container of selectedGroup.containers) {
      const info = toServiceInfo(container, selectedGroup.projectName);
      if (info) {
        services.push(info);
      }
    }

    services.sort((a, b) => a.serviceName.localeCompare(b.serviceName));

    return {
      projectName: selectedGroup.projectName,
      services,
    };
  }
}
