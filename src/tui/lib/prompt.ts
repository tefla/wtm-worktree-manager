import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirmPrompt(question: string, defaultValue = true): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = await rl.question(`${question} ${suffix} `);
    const normalised = answer.trim().toLowerCase();
    if (!normalised) {
      return defaultValue;
    }
    if (["y", "yes"].includes(normalised)) {
      return true;
    }
    if (["n", "no"].includes(normalised)) {
      return false;
    }
    return defaultValue;
  } finally {
    rl.close();
  }
}
