import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Logger = (level: "info" | "warn" | "error", message: string) => void;

export interface EnsureTmuxSessionOptions {
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export class TmuxController {
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  assertAvailable(): void {
    if (!process.env.PATH) {
      throw new Error("PATH not set; cannot locate tmux binary.");
    }
    try {
      const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(result.stderr || `tmux -V exited with status ${result.status}`);
      }
    } catch (error) {
      throw new Error(`tmux is required but not available: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  buildSessionName(workspacePath: string, slot: string): string {
    const abs = path.resolve(workspacePath);
    const baseName = path.basename(abs) || "workspace";
    const sanitizedBase = baseName.replace(/[^A-Za-z0-9_.-]/g, "-").slice(-40);
    const sanitizedSlot = slot.replace(/[^A-Za-z0-9_.-]/g, "-").slice(-40) || "default";
    const digest = createHash("sha1").update(abs).update("\0").update(slot).digest("hex").slice(0, 12);
    return `wtm-${sanitizedBase}-${sanitizedSlot}-${digest}`;
  }

  async ensureSession(sessionName: string, options: EnsureTmuxSessionOptions): Promise<{ created: boolean }> {
    const exists = await this.hasSession(sessionName);
    if (exists) {
      return { created: false };
    }
    const envEntries = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value ?? ""}`);
    const commandParts: string[] =
      envEntries.length > 0 ? ["env", ...envEntries, options.command, ...options.args] : [options.command, ...options.args];
    await this.run(["new-session", "-d", "-s", sessionName, "-c", options.cwd, "--", ...commandParts]);
    this.logger?.("info", `Created tmux session ${sessionName}`);
    return { created: true };
  }

  async killSession(sessionName: string): Promise<void> {
    const exists = await this.hasSession(sessionName);
    if (!exists) return;
    try {
      await this.run(["kill-session", "-t", sessionName]);
      this.logger?.("info", `Killed tmux session ${sessionName}`);
    } catch (error) {
      this.logger?.("warn", `Failed to kill tmux session ${sessionName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async captureSession(sessionName: string, maxCharacters: number): Promise<string> {
    const exists = await this.hasSession(sessionName);
    if (!exists) {
      return "";
    }
    const lines = Math.max(200, Math.ceil(maxCharacters / 80));
    try {
      const result = await this.run(["capture-pane", "-p", "-t", `${sessionName}:0`, "-S", `-${lines}`]);
      return result.stdout.slice(-maxCharacters);
    } catch (error) {
      this.logger?.("warn", `Failed to capture tmux session ${sessionName}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  buildAttachCommand(sessionName: string): { command: string; args: string[] } {
    return {
      command: "tmux",
      args: ["attach-session", "-t", sessionName],
    };
  }

  private async hasSession(sessionName: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", sessionName]);
      return true;
    } catch (error) {
      const rawCode = (error as NodeJS.ErrnoException).code;
      if (String(rawCode) === "1") {
        return false;
      }
      throw error;
    }
  }

  private async run(args: string[]): Promise<RunResult> {
    return await new Promise<RunResult>((resolve, reject) => {
      execFile("tmux", args, { encoding: "utf8", env: process.env }, (error, stdout, stderr) => {
        if (error) {
          (error as Error & { stdout?: string; stderr?: string; code?: number }).stdout = stdout;
          (error as Error & { stdout?: string; stderr?: string; code?: number }).stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      });
    });
  }
}
