import path from "node:path";
import { execa } from "execa";

export async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const result = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    const output = result.stdout.trim();
    if (!output) {
      return null;
    }
    return path.resolve(cwd, output);
  } catch {
    return null;
  }
}
