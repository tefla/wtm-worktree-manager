import os from "node:os";
import path from "node:path";
import process from "node:process";

export function getHostSocketPath(): string {
  const configured = process.env.WTM_TERMINAL_HOST_SOCKET;
  if (configured) {
    return configured;
  }
  if (process.platform === "win32") {
    return path.join("\\\\?\\pipe", "wtm-terminal-host");
  }
  const dir = path.join(os.homedir(), ".wtm");
  return path.join(dir, "terminal-host.sock");
}

export function getHostEntrypointDir(): string {
  if (process.env.WTM_TERMINAL_HOST_ENTRYPOINT) {
    return process.env.WTM_TERMINAL_HOST_ENTRYPOINT;
  }
  return __dirname;
}
