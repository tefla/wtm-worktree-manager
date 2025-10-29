export interface DockerComposeServiceInfo {
  id?: string | null;
  serviceName: string;
  containerName?: string | null;
  projectName: string;
  state: string;
  status: string;
  health?: string | null;
}

export interface DockerComposeServicesSnapshot {
  projectName: string | null;
  services: DockerComposeServiceInfo[];
  error?: string | null;
}
