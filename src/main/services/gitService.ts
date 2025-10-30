import { spawn } from "node:child_process";
import { constants, promises as fsPromises } from "node:fs";

const { access } = fsPromises;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandError extends Error {
  command: string[];
  stderr: string;

  constructor(command: string[], stderr: string, message?: string) {
    super(message ?? `Command failed: ${command.join(" ")}`);
    this.name = "GitCommandError";
    this.command = command;
    this.stderr = stderr;
  }
}

export async function runGitCommand(
  cmd: string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
): Promise<GitCommandResult> {
  const { cwd, allowFailure = false } = options;

  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      if (allowFailure) {
        resolve({ stdout, stderr: stderr || (error as Error).message, exitCode: 1 });
      } else {
        reject(error);
      }
    });

    child.on("close", (exitCode) => {
      if (exitCode !== 0 && !allowFailure) {
        reject(new GitCommandError(cmd, stderr.trim()));
        return;
      }
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });
  });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
